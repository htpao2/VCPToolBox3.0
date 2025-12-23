// modules/GeminiToolsAdapter.js
const fs = require('fs').promises;
const path = require('path');
const PluginManager = require('../Plugin.js');

class GeminiToolsAdapter {
    constructor() {
        this.debugMode = (process.env.DebugMode || "false").toLowerCase() === "true";
    }

    /**
     * Converts a VCP Plugin Manifest to a Gemini Tool Declaration.
     * Note: Since VCP manifests don't always have a strict JSON schema for parameters,
     * we infer them or use a generic "instruction" parameter for some tools.
     *
     * @param {Object} manifest - VCP Plugin Manifest
     * @returns {Object|null} - Gemini Function Declaration or null if not compatible
     */
    convertManifestToTool(manifest) {
        if (!manifest || !manifest.name) return null;

        // Skip internal or static plugins that don't have invocation commands
        // Exception: RAG and MetaThinking are handled specially, but if they are standard plugins, we might map them.
        // For now, we focus on plugins that have invocationCommands or a known schema.

        // Special Case: Tools that use standard input (stdio) often expect a JSON object.
        // We need to look at 'configSchema' or infer from 'invocationCommands'.

        const description = manifest.description || manifest.displayName || manifest.name;

        // 1. Try to build from configSchema if it represents input parameters (rare in VCP, usually configSchema is for env vars)
        // Actually, VCP plugins receive inputs via `toolArgs`.
        // We need to know what `toolArgs` are expected.
        // Most VCP plugins don't strictly define input schema in manifest yet.
        // They rely on the LLM knowing how to use them via `invocationCommands` description.

        // Strategy: Create a generic tool definition based on the textual description.
        // If the plugin has `invocationCommands`, we use the first command's description.

        let toolDescription = description;
        let properties = {};
        let required = [];

        // Heuristic for specific known plugins or types
        if (manifest.name === 'DailyNoteWrite') {
            properties = {
                maidName: { type: "STRING", description: "The name of the persona or tag for the diary (e.g., 'Nova' or '[Work]')." },
                dateString: { type: "STRING", description: "The date of the diary entry (YYYY-MM-DD)." },
                contentText: { type: "STRING", description: "The content of the diary entry." }
            };
            required = ["maidName", "dateString", "contentText"];
        } else if (manifest.name === 'SciCalculator') {
            properties = {
                expression: { type: "STRING", description: "The mathematical expression to evaluate (python syntax)." }
            };
            required = ["expression"];
        } else if (manifest.name === 'ChromeControl') {
             properties = {
                command: { type: "STRING", description: "The command to execute (e.g., 'scroll_down', 'click')." },
                selector: { type: "STRING", description: "CSS selector for the target element (if needed)." },
                value: { type: "STRING", description: "Value to input (if needed)." }
            };
            required = ["command"];
        } else {
             // Generic Fallback: If we can't determine the schema, we create a generic 'params' JSON string
             // or specific fields if we can parse the description.
             // For safety in Live API, it's better to explicitly support a whitelist of tools first.
             // But to be "dynamic", let's try to support all.

             // If invocationCommands exists, try to hint arguments.
             if (manifest.capabilities && manifest.capabilities.invocationCommands && manifest.capabilities.invocationCommands.length > 0) {
                 const cmd = manifest.capabilities.invocationCommands[0];
                 toolDescription = cmd.description || toolDescription;

                 // Generic catch-all for unknown tools
                 properties = {
                     arguments: { type: "STRING", description: "JSON string arguments for the tool, based on its description." }
                 };
             } else {
                 return null; // Skip plugins without invocation commands (likely static or background)
             }
        }

        return {
            name: manifest.name,
            description: toolDescription.substring(0, 1024), // Limit description length
            parameters: {
                type: "OBJECT",
                properties: properties,
                required: required
            }
        };
    }

    /**
     * Get all available tools in Gemini format.
     */
    getAllToolDeclarations() {
        const tools = [];
        const manifests = PluginManager.plugins; // Map<name, manifest>

        for (const [name, manifest] of manifests) {
            // Filter out tools that shouldn't be exposed directly or are internal
            if (['VCPLog', 'WeatherReporter'].includes(name)) continue;

            const tool = this.convertManifestToTool(manifest);
            if (tool) {
                tools.push(tool);
            }
        }

        // Add Special Active Tools (Virtual Tools)
        // 1. RAG Memory Search
        tools.push({
            name: "search_memory",
            description: "Actively search the VCP knowledge base (diaries, documents) for context. Use this whenever the user asks about past events, specific details, or when you need to recall information.",
            parameters: {
                type: "OBJECT",
                properties: {
                    query: { type: "STRING", description: "The search query." },
                    time_range: { type: "STRING", description: "Optional time range (e.g., 'last week', '2023-01')." }
                },
                required: ["query"]
            }
        });

        // 2. Meta Thinking
        tools.push({
            name: "perform_meta_thinking",
            description: "Perform deep, multi-stage reasoning on a complex topic using the 'Meta-Thinking' engine. Use this for difficult logical problems or creative writing tasks that require structural planning.",
            parameters: {
                type: "OBJECT",
                properties: {
                    topic: { type: "STRING", description: "The core topic or problem to analyze." },
                    mode: { type: "STRING", description: "Thinking mode (e.g., 'default', 'creative_writing', 'problem_solving')." }
                },
                required: ["topic"]
            }
        });

        return tools;
    }

    /**
     * Handle a tool call from Gemini.
     */
    async handleToolCall(toolCall) {
        const toolName = toolCall.name;
        const args = toolCall.args; // Object

        if (this.debugMode) console.log(`[GeminiToolsAdapter] Handling tool call: ${toolName}`, args);

        try {
            // 1. Virtual Tools
            if (toolName === 'search_memory') {
                // Map to RAGDiaryPlugin logic manually since it's not a standard tool call in VCP usually
                const ragPlugin = PluginManager.plugins.get('RAGDiaryPlugin');
                if (!ragPlugin) return { result: "Memory plugin not loaded." };

                // We need to access the internal logic of RAGDiaryPlugin.
                // Since RAGDiaryPlugin is a preprocessor, we might not be able to call it via processToolCall easily
                // unless we exposed a method.
                // However, PluginManager has `getPlugin` but not the module instance directly accessible for arbitrary methods easily
                // UNLESS it was registered as a service or we use the preprocessor instance.

                // Hack: Access the preprocessor instance
                const ragModule = PluginManager.messagePreprocessors.get('RAGDiaryPlugin');
                if (ragModule && typeof ragModule._processRAGPlaceholder === 'function') {
                    // We simulate a context to use the internal method, OR we implement a simplified search here.
                    // Actually, RAGDiaryPlugin has `vectorDBManager`. We can use that.
                    if (ragModule.vectorDBManager) {
                         // Perform a search
                         const vec = await ragModule.getSingleEmbeddingCached(args.query);
                         if (!vec) return { result: "Could not vectorize query." };

                         const results = await ragModule.vectorDBManager.search('all', vec, 5); // Search all diaries
                         // Format results
                         const text = results.map(r => r.text).join('\n---\n');
                         return { result: text || "No memories found." };
                    }
                }
                return { result: "Memory search unavailable (Module not ready)." };

            } else if (toolName === 'perform_meta_thinking') {
                 const ragModule = PluginManager.messagePreprocessors.get('RAGDiaryPlugin');
                 if (ragModule && typeof ragModule._processMetaThinkingChain === 'function') {
                     const vec = await ragModule.getSingleEmbeddingCached(args.topic);
                     if (!vec) return { result: "Could not vectorize topic." };

                     // Run meta thinking
                     const result = await ragModule._processMetaThinkingChain(
                         args.mode || 'default',
                         vec,
                         args.topic, // userContent
                         args.topic, // display query
                         null, // kSequence (auto)
                         true, // useGroup
                         args.mode === 'auto' // isAutoMode
                     );
                     return { result: result };
                 }
                 return { result: "Meta thinking unavailable." };
            }

            // 2. Standard VCP Plugins
            // If the args contains a generic 'arguments' string (fallback), parse it.
            let cleanArgs = { ...args };
            if (cleanArgs.arguments && typeof cleanArgs.arguments === 'string') {
                try {
                    const parsed = JSON.parse(cleanArgs.arguments);
                    cleanArgs = { ...cleanArgs, ...parsed };
                    delete cleanArgs.arguments;
                } catch (e) {
                    // keep as string if parse fails
                }
            }

            const result = await PluginManager.processToolCall(toolName, cleanArgs);
            return result; // Should be an object

        } catch (error) {
            console.error(`[GeminiToolsAdapter] Error executing ${toolName}:`, error);
            return { error: error.message };
        }
    }
}

module.exports = new GeminiToolsAdapter();
