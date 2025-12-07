const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const VCP_TARGET = process.env.VCP_TARGET || 'http://localhost:3000';

app.use(bodyParser.json({ limit: '50mb' }));

// VCP Tool Regex
const TOOL_REQUEST_REGEX = /<<<\[TOOL_REQUEST\]>>>([\s\S]*?)<<<\[END_TOOL_REQUEST\]>>>/;

function convertToRooXML(vcpResponse) {
    const match = vcpResponse.match(TOOL_REQUEST_REGEX);
    if (match) {
        try {
            const jsonStr = match[1];
            const toolCall = JSON.parse(jsonStr);
            const { commandIdentifier, ...args } = toolCall;

            // Roo Code expects: <tool_code>...</tool_code>
            // Actually, Roo Code (OpenAI provider) expects tool_calls array in JSON if using native tools,
            // OR if using "System Prompt" approach, it expects XML tags in the text.
            // Based on user request "show effects in Roo", and "Roo uses XML", we assume XML format.
            // Format: <tool_code>\n<tool_name>name</tool_name>\n<parameters>\n...</parameters>\n</tool_code>
            // Wait, standard Roo Code tool use format is:
            // <tool_code>
            //   tool_name
            //   <parameter_name>value</parameter_name>
            // </tool_code>
            // Let's stick to the standard Roo XML format.

            const escapeXml = (unsafe) => {
                if (typeof unsafe !== 'string') return unsafe;
                return unsafe.replace(/[<>&'"]/g, c => {
                    switch (c) {
                        case '<': return '&lt;';
                        case '>': return '&gt;';
                        case '&': return '&amp;';
                        case '\'': return '&apos;';
                        case '"': return '&quot;';
                    }
                });
            };

            let xml = `<tool_code>\n${commandIdentifier}\n`;
            for (const [key, value] of Object.entries(args)) {
                xml += `<${key}>${escapeXml(value)}</${key}>\n`;
            }
            xml += `</tool_code>`;

            // Replace the VCP block with XML block
            return vcpResponse.replace(match[0], xml);
        } catch (e) {
            console.error("Failed to parse tool call:", e);
            return vcpResponse; // Return original if parse fails
        }
    }
    return vcpResponse;
}

app.post('/v1/chat/completions', async (req, res) => {
    console.log("Received request from Roo Code Client");

    // 1. Intercept Request
    const upstreamReq = { ...req.body };

    // Disable streaming for translation purposes
    // (Translating a stream on the fly is hard, so we buffer)
    upstreamReq.stream = false;

    // TODO: Inject VCP System Prompt if needed?
    // Roo sends its own huge system prompt. If we replace it, we might break Roo's context.
    // But the user said: "Updated Roo Code System Prompts" is one of the goals.
    // If we want the model to use VCP format, we MUST inject instructions to do so.
    // However, if we just want to translate, maybe we let Roo send its XML instructions,
    // and we let the model output XML, and we just pass it through?
    // User said: "AI uses VCP format calls... in Roo also show VCP format... but effect like Roo Code".
    // Wait, "In Roo also show VCP format".
    // If Roo shows VCP format (<<<...>>>), the Roo Extension won't parse it as a tool call!
    // Unless we assume the User *wants* to see the raw text, and *then* the adapter converts it invisibly?
    // But if the Adapter converts it to XML for the *Extension to execute*, the Extension will see XML in the response content.

    // Let's stick to the Adapter Plan:
    // 1. We append a small instruction to the system prompt: "IMPORTANT: You are running in VCP mode. Please output tool calls in VCP format <<<[TOOL_REQUEST]>>>...".
    // 2. Model outputs VCP format.
    // 3. Adapter captures output.
    // 4. Adapter translates VCP format to XML format so Roo Client can execute it.

    if (upstreamReq.messages && upstreamReq.messages.length > 0) {
        const sysMsg = upstreamReq.messages.find(m => m.role === 'system');
        if (sysMsg) {
            sysMsg.content += "\n\nIMPORTANT: Please output tool calls using the following format:\n<<<[TOOL_REQUEST]>>>\n{\"commandIdentifier\": \"tool_name\", ...args}\n<<<[END_TOOL_REQUEST]>>>\n";
        }
    }

    try {
        const response = await axios.post(`${VCP_TARGET}/v1/chat/completions`, upstreamReq, {
            headers: { 'Content-Type': 'application/json' }
        });

        const vcpData = response.data;
        let content = vcpData.choices[0].message.content;

        // Translate
        const translatedContent = convertToRooXML(content);

        // Construct response compatible with OpenAI/Roo
        const translatedResponse = {
            ...vcpData,
            choices: [
                {
                    ...vcpData.choices[0],
                    message: {
                        ...vcpData.choices[0].message,
                        content: translatedContent
                    }
                }
            ]
        };

        // If the original request asked for stream, we can simulate a stream
        // But for simplicity, we return non-streamed JSON.
        // Roo Code usually handles non-streamed responses fine.
        res.json(translatedResponse);

    } catch (error) {
        console.error("Upstream error:", error.message);
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ error: "Internal Adapter Error" });
        }
    }
});

app.listen(PORT, () => {
    console.log(`RooCodeAdapter listening on port ${PORT}`);
});
