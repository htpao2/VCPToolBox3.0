// modules/GeminiLiveProxy.js
const WebSocket = require('ws');
const GeminiToolsAdapter = require('./GeminiToolsAdapter');
const PluginManager = require('../Plugin.js');

class GeminiLiveProxy {
    constructor(clientWs, config, pluginManager) {
        this.clientWs = clientWs;
        this.config = config;
        this.pluginManager = pluginManager;
        this.upstreamWs = null;
        this.debugMode = config.debugMode || false;
        this.sessionConfig = null;

        // Active Push State
        this.lastUserTranscript = "";
        this.isProcessingRAG = false;

        this.init();
    }

    log(msg) {
        if (this.debugMode) console.log(`[GeminiLiveProxy] ${msg}`);
    }

    init() {
        const apiKey = this.config.apiKey; // Must be provided
        // Construct standard Gemini Live WebSocket URL
        // If using NewAPI, we assume it proxies the same path.
        // Standard: wss://generativelanguage.googleapis.com/ws/google.generativeai.v1alpha.GenerativeService.BidiGenerateContent?key=...
        // NewAPI might be: ws://newapi-host/v1/ws/google.generativeai.v1alpha.GenerativeService.BidiGenerateContent?key=...
        // Or specific path. We'll try to construct it based on API_URL.

        let baseUrl = this.config.apiUrl || "https://generativelanguage.googleapis.com";
        // Convert https/http to wss/ws
        let wsUrl = baseUrl.replace(/^http/, 'ws');

        // Append path if not present (heuristic)
        if (!wsUrl.includes('/ws/')) {
            wsUrl += "/ws/google.generativeai.v1alpha.GenerativeService.BidiGenerateContent";
        }

        const targetUrl = `${wsUrl}?key=${apiKey}`;
        this.log(`Connecting to Upstream: ${targetUrl}`);

        this.upstreamWs = new WebSocket(targetUrl);

        this.upstreamWs.on('open', () => {
            this.log('Upstream connected.');
            // We do NOT send setup immediately here usually;
            // the Client sends the first message which is often 'setup'.
            // But we need to Intercept it.
        });

        this.upstreamWs.on('message', (data) => this.handleUpstreamMessage(data));
        this.upstreamWs.on('close', (code, reason) => {
            this.log(`Upstream closed: ${code} ${reason}`);
            this.clientWs.close(code, reason);
        });
        this.upstreamWs.on('error', (err) => {
            this.log(`Upstream error: ${err.message}`);
            this.clientWs.close();
        });

        this.clientWs.on('message', (data) => this.handleClientMessage(data));
        this.clientWs.on('close', (code, reason) => {
            this.log(`Client closed: ${code} ${reason}`);
            if (this.upstreamWs.readyState === WebSocket.OPEN) this.upstreamWs.close();
        });
        this.clientWs.on('error', (err) => {
             this.log(`Client error: ${err.message}`);
             if (this.upstreamWs.readyState === WebSocket.OPEN) this.upstreamWs.close();
        });
    }

    async handleClientMessage(data) {
        try {
            // Data can be binary (audio) or text (JSON)
            // If binary, just forward it?
            // Wait, standard Gemini Bidi protocol uses JSON wrapper even for audio bytes usually?
            // Actually, client might send raw blobs? No, usually JSON with base64 audio.
            // Let's assume JSON text messages for control/setup/audio-wrapper.

            let msg;
            let isBinary = false;

            if (Buffer.isBuffer(data)) {
                 // Try to parse as JSON first
                 try {
                     const text = data.toString('utf8');
                     msg = JSON.parse(text);
                 } catch (e) {
                     // It's likely raw binary or just not JSON.
                     // Some clients send raw BSON or Protobuf?
                     // Google Live API uses JSON text frame for setup/client_content(text).
                     // But RealtimeInput can be just bytes if configured?
                     // Let's assume standard JSON usage first.
                     isBinary = true;
                 }
            } else {
                msg = JSON.parse(data);
            }

            if (isBinary) {
                // Forward binary directly
                this.upstreamWs.send(data);
                return;
            }

            // Intercept 'setup'
            if (msg.setup) {
                this.log('Intercepting SETUP message.');
                const modifiedSetup = await this.injectVCPContext(msg.setup);
                const newMsg = { setup: modifiedSetup };
                this.upstreamWs.send(JSON.stringify(newMsg));
                return;
            }

            // Forward others
            this.upstreamWs.send(data);

        } catch (e) {
            this.log(`Error handling client message: ${e.message}`);
            // Forward anyway if it might be valid
            this.upstreamWs.send(data);
        }
    }

    async handleUpstreamMessage(data) {
        try {
            const text = data.toString('utf8');
            const msg = JSON.parse(text);

            // 1. Tool Calls
            if (msg.toolCall) {
                this.log(`Received Tool Call from Gemini.`);
                const functionCalls = msg.toolCall.functionCalls;
                if (functionCalls && functionCalls.length > 0) {
                    // Execute locally
                    const responses = [];
                    for (const call of functionCalls) {
                        this.log(`Executing tool: ${call.name}`);
                        const result = await GeminiToolsAdapter.handleToolCall(call);
                        responses.push({
                            id: call.id,
                            name: call.name,
                            response: { result: result }
                        });
                    }

                    // Send response back to Upstream
                    const toolResponseMsg = {
                        toolResponse: {
                            functionResponses: responses
                        }
                    };
                    this.upstreamWs.send(JSON.stringify(toolResponseMsg));

                    // Do NOT forward toolCall to client if we handled it?
                    // Usually we don't want the client to see backend internal tools.
                    // But client might need to know 'model is thinking'.
                    // For now, we suppress it to keep client clean, OR we send a partial update?
                    // Better to suppress forwarding of VCP tools.
                    return;
                }
            }

            // 2. Server Content (Model Turn) -> Check for transcripts for Active Push
            if (msg.serverContent) {
                 // Gemini echoes back user input or sends model delta
                 // Check if there is a 'turnComplete' or similar indicating user finished speaking
                 // Actually, we look for 'modelTurn' which is the model speaking.
                 // We want 'clientTurn' transcript? Gemini usually doesn't send it back in Bidi unless asked.
                 // BUT, if the model *responds*, it means it understood.

                 // If we want "Active Push" based on what user said, we are stuck if we don't have the text.
                 // Assuming we rely on "Virtual Tool" strategy implemented in Adapter for now.
                 // But if Gemini DOES send `userContent` or similar in history updates, we use it.
            }

            // Forward to Client
            this.clientWs.send(data);

        } catch (e) {
            // Binary or non-JSON, forward directly
            this.clientWs.send(data);
        }
    }

    async injectVCPContext(originalSetup) {
        // 1. Inject System Prompts
        const systemInstruction = originalSetup.systemInstruction || {};
        const parts = systemInstruction.parts || [];

        // Get VCP Context
        const timeNow = new Date().toLocaleString();
        const city = process.env.VarCity || "Unknown City";
        const user = process.env.VarUser || "User";

        // Placeholder values
        const placeholders = this.pluginManager.getAllPlaceholderValues(); // Get all static values
        let weather = placeholders.get("VCPWeatherInfo") || "Weather unavailable";

        const vcpPrompt = `
[System Context]
Current Time: ${timeNow}
Location: ${city}
User: ${user}
Weather: ${weather}

[VCP Capability Injection]
You are connected to the VCP (Virtual Character Platform) Core.
You have DIRECT access to the user's memories (Diaries), computer control, and advanced reasoning.
CRITICAL INSTRUCTION:
1. If the user asks about past events, memories, or specific details, you MUST use the 'search_memory' tool immediately. Do not say "I don't know" without checking memory first.
2. If the user asks for complex reasoning or creative writing, use 'perform_meta_thinking'.
3. You can control the PC via 'ChromeControl' or write diaries via 'DailyNoteWrite'.
Be proactive. If you hear something that triggers a memory association, use the tool.
`;

        // Prepend to parts
        parts.unshift({ text: vcpPrompt });

        // 2. Inject Tools
        const existingTools = originalSetup.tools || [];
        const vcpTools = GeminiToolsAdapter.getAllToolDeclarations();

        // Gemini expects tools in format: { functionDeclarations: [...] }
        // We merge them.
        let mergedFunctionDeclarations = [];

        // Extract existing
        existingTools.forEach(t => {
            if (t.functionDeclarations) {
                mergedFunctionDeclarations.push(...t.functionDeclarations);
            }
        });

        // Add VCP tools
        mergedFunctionDeclarations.push(...vcpTools);

        const newTools = [{ functionDeclarations: mergedFunctionDeclarations }];

        return {
            ...originalSetup,
            systemInstruction: { parts: parts },
            tools: newTools
        };
    }
}

module.exports = GeminiLiveProxy;
