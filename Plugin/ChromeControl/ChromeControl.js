// Plugin/ChromeControl/ChromeControl.js
// A synchronous stdio plugin that calls the central WebSocketServer to send commands.

const WebSocketServer = require('../../WebSocketServer.js');

function readInput() {
    return new Promise((resolve) => {
        const chunks = [];
        process.stdin.on('data', chunk => chunks.push(chunk));
        process.stdin.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
    });
}

function writeOutput(data) {
    process.stdout.write(JSON.stringify(data));
}

function generateRequestId() {
    return `cc-req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

async function main() {
    try {
        const inputString = await readInput();
        const commandData = JSON.parse(inputString);

        if (!commandData.command) {
            throw new Error("The 'command' field cannot be empty.");
        }

        // Ensure there is a requestId for tracking
        if (!commandData.requestId) {
            commandData.requestId = generateRequestId();
        }

        // Use the new, unified command channel
        const result = await WebSocketServer.sendCommandToChrome(commandData);

        writeOutput(result);

    } catch (error) {
        // Ensure the error message is a string
        const errorMessage = (error instanceof Error) ? error.message : String(error);
        writeOutput({ status: 'error', error: errorMessage });
    } finally {
        // The process must exit for the PluginManager to continue.
        process.exit(0);
    }
}

main();
