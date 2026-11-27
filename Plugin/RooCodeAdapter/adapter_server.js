const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.ADAPTER_PORT || 3001;
const VCP_API_URL = process.env.VCP_SERVER_URL || 'http://localhost:3000/v1';

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --- Helper: Convert VCP Tool Call to Roo Code XML ---
function convertVCPToolToXML(content) {
    if (!content) return content;

    // Pattern for VCP Tool Request
    // <<<[TOOL_REQUEST]>>>
    // tool_name:「始」Name「末」,
    // param:「始」Value「末」,
    // ...
    // <<<[END_TOOL_REQUEST]>>>

    const toolRegex = /<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/g;
    let convertedContent = content;
    let match;
    const replacements = [];

    while ((match = toolRegex.exec(content)) !== null) {
        const fullBlock = match[0];
        const body = match[1];

        // Parse parameters: key:「始」value「末」,
        const paramRegex = /([a-zA-Z0-9_]+):「始」([\s\S]*?)「末」/g;
        let paramMatch;
        const params = {};

        while ((paramMatch = paramRegex.exec(body)) !== null) {
            params[paramMatch[1]] = paramMatch[2];
        }

        const toolName = params.tool_name;
        const commandIdentifier = params.commandIdentifier;

        if (toolName === 'RooCodeTools' && commandIdentifier) {
            let xml = `<${commandIdentifier}>\n`;
            for (const [key, value] of Object.entries(params)) {
                if (key === 'tool_name' || key === 'commandIdentifier') continue;
                xml += `<${key}>${value}</${key}>\n`;
            }
            xml += `</${commandIdentifier}>`;

            replacements.push({
                start: match.index,
                end: match.index + fullBlock.length,
                text: xml
            });
        }
    }

    // Apply replacements in reverse order
    for (let i = replacements.length - 1; i >= 0; i--) {
        const rep = replacements[i];
        convertedContent = convertedContent.substring(0, rep.start) + rep.text + convertedContent.substring(rep.end);
    }

    return convertedContent;
}

// --- Proxy Route ---

app.post('/v1/chat/completions', async (req, res) => {
    try {
        console.log(`[RooAdapter] Forwarding request to ${VCP_API_URL}/chat/completions`);

        // IMPORTANT: We force 'stream: false' to the upstream VCP server to ensure
        // we get the full response payload. This allows us to reliably parse and translate
        // the VCP tool call block (which might be split across chunks in a stream)
        // into valid XML for Roo Code.
        const originalBody = req.body;
        const upstreamBody = { ...originalBody, stream: false };

        const vcpResponse = await fetch(VCP_API_URL + '/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': req.headers.authorization || ''
            },
            body: JSON.stringify(upstreamBody)
        });

        if (!vcpResponse.ok) {
            const errText = await vcpResponse.text();
            return res.status(vcpResponse.status).send(errText);
        }

        const data = await vcpResponse.json();

        // Perform Translation
        if (data.choices && data.choices[0] && data.choices[0].message) {
            const originalContent = data.choices[0].message.content || '';
            const translatedContent = convertVCPToolToXML(originalContent);
            data.choices[0].message.content = translatedContent;
        }

        // If the client requested streaming, we need to fake a stream response
        // because Roo Code expects SSE if it asked for it.
        if (originalBody.stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const content = data.choices[0].message.content;
            const model = data.model;
            const id = data.id;

            // Send the entire content in one chunk (simplified streaming)
            const chunk = {
                id: id,
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: model,
                choices: [{
                    index: 0,
                    delta: { content: content },
                    finish_reason: null
                }]
            };

            res.write(`data: ${JSON.stringify(chunk)}\n\n`);

            // Send finish chunk
            const finishChunk = {
                id: id,
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: model,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                }]
            };
            res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();

        } else {
            // Standard JSON response
            res.json(data);
        }

    } catch (error) {
        console.error('[RooAdapter] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`[RooAdapter] Service running on port ${PORT}`);
    console.log(`[RooAdapter] Target VCP URL: ${VCP_API_URL}`);
    console.log(`[RooAdapter] Point your Roo Code Extension to http://localhost:${PORT}/v1`);
});
