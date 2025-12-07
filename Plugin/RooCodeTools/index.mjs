import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { glob } from 'glob';
import puppeteer from 'puppeteer';
import { fileURLToPath } from 'url';

// --- Constants & Config ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = process.env.PROJECT_BASE_PATH || process.cwd();
const TODO_FILE = path.join(PROJECT_ROOT, '.roo_todo.json');

// --- Helper Functions ---

function getAbsolutePath(filePath) {
    if (path.isAbsolute(filePath)) return filePath;
    return path.join(PROJECT_ROOT, filePath);
}

function sendOutput(data) {
    console.log(JSON.stringify(data));
}

function sendError(message) {
    console.log(JSON.stringify({ error: message }));
}

// --- Diff Strategy (MultiSearchReplaceDiffStrategy Port) ---

function applyDiff(fileContent, diffString) {
    const SEARCH_MARKER = '<<<<<<< SEARCH';
    const DIVIDER_MARKER = '=======';
    const REPLACE_MARKER = '>>>>>>> REPLACE';

    let currentContent = fileContent;
    const lines = diffString.split('\n');
    let i = 0;

    while (i < lines.length) {
        if (lines[i].trim() === SEARCH_MARKER) {
            let searchBlock = [];
            i++;
            while (i < lines.length && lines[i].trim() !== DIVIDER_MARKER) {
                searchBlock.push(lines[i]);
                i++;
            }
            if (i >= lines.length) throw new Error('Malformed diff: Missing =======');
            i++; // Skip DIVIDER

            let replaceBlock = [];
            while (i < lines.length && lines[i].trim() !== REPLACE_MARKER) {
                replaceBlock.push(lines[i]);
                i++;
            }
            if (i >= lines.length) throw new Error('Malformed diff: Missing >>>>>>> REPLACE');
            i++; // Skip REPLACE

            const searchStr = searchBlock.join('\n');
            const replaceStr = replaceBlock.join('\n');

            // Exact match attempt
            if (currentContent.includes(searchStr)) {
                currentContent = currentContent.replace(searchStr, replaceStr);
            } else {
                // Fuzzy match attempt (Simulated simple fuzzy logic or exact line trimming)
                // For this implementation, we will stick to exact match but with trimmed whitespace check fallback
                // Real Roo Code uses Levenshtein on lines. Let's do a basic line-by-line fuzzy search if exact fails.

                // Note: Implementing full fastest-levenshtein fuzzy search here is complex.
                // We will report failure if exact match fails, as typical Roo Code behavior encourages user to fix the search block.
                throw new Error(`Could not find search block in file:\n${searchStr}`);
            }
        } else {
            i++;
        }
    }
    return currentContent;
}


// --- Main Execution ---

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
    try {
        const input = JSON.parse(Buffer.concat(chunks).toString());
        const { commandIdentifier, ...args } = input;

        switch (commandIdentifier) {
            case 'execute_command':
                await handleExecuteCommand(args);
                break;
            case 'read_file':
                await handleReadFile(args);
                break;
            case 'write_to_file':
                await handleWriteToFile(args);
                break;
            case 'apply_diff':
                await handleApplyDiff(args);
                break;
            case 'search_files':
                await handleSearchFiles(args);
                break;
            case 'list_files':
                await handleListFiles(args);
                break;
            case 'list_code_definition_names': // Simplified stub
                await handleListCodeDefinitions(args);
                break;
            case 'browser_action':
                await handleBrowserAction(args);
                break;
            case 'ask_followup_question':
                sendOutput({ result: `Question asked: ${args.question}` });
                break;
            case 'attempt_completion':
                sendOutput({ result: `Task completed. Result: ${args.result}` });
                break;
            case 'switch_mode':
                sendOutput({ result: `Switched to mode: ${args.mode} (Virtual State)` });
                break;
            case 'new_task':
                await handleNewTask(args);
                break;
            case 'update_todo_list':
                await handleUpdateTodo(args);
                break;
            default:
                sendError(`Unknown command: ${commandIdentifier}`);
        }
    } catch (err) {
        sendError(err.message);
    }
});

// --- Handlers ---

async function handleExecuteCommand({ command, requireAdmin }) {
    // Basic security check (demonstration)
    /*
    const sensitiveCommands = ['rm', 'sudo', 'mv', 'chmod'];
    const isSensitive = sensitiveCommands.some(c => command.startsWith(c));

    if (isSensitive) {
         if (requireAdmin !== process.env.DECRYPTED_AUTH_CODE) {
             sendError("Admin approval required for this command.");
             return;
         }
    }
    */
    // For now, executing directly as requested by "simulate Roo Code"
    exec(command, { cwd: PROJECT_ROOT }, (error, stdout, stderr) => {
        if (error) {
            sendOutput({ error: error.message, stderr, stdout });
        } else {
            sendOutput({ stdout, stderr });
        }
    });
}

async function handleReadFile({ path: filePath }) {
    const absPath = getAbsolutePath(filePath);
    if (!fs.existsSync(absPath)) {
        sendError(`File not found: ${filePath}`);
        return;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    sendOutput({ content });
}

async function handleWriteToFile({ path: filePath, content }) {
    const absPath = getAbsolutePath(filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
    sendOutput({ result: `Successfully wrote to ${filePath}` });
}

async function handleApplyDiff({ path: filePath, diff }) {
    const absPath = getAbsolutePath(filePath);
    if (!fs.existsSync(absPath)) {
        sendError(`File not found: ${filePath}`);
        return;
    }
    const content = fs.readFileSync(absPath, 'utf8');
    try {
        const newContent = applyDiff(content, diff);
        fs.writeFileSync(absPath, newContent, 'utf8');
        sendOutput({ result: `Successfully applied diff to ${filePath}` });
    } catch (e) {
        sendError(`Failed to apply diff: ${e.message}`);
    }
}

async function handleSearchFiles({ path: searchPath, regex }) {
    // Using glob to find files then grep logic? Or just simple recursive search
    // Since args has 'regex', let's search CONTENT
    const absPath = getAbsolutePath(searchPath);
    if (!fs.existsSync(absPath)) {
         sendError(`Path not found: ${searchPath}`);
         return;
    }

    try {
        // Simple grep-like search
        const files = await glob(path.join(searchPath, '**/*'), { nodir: true, cwd: PROJECT_ROOT });
        const matches = [];
        const re = new RegExp(regex);

        for (const f of files) {
            const fullP = getAbsolutePath(f);
            const content = fs.readFileSync(fullP, 'utf8');
            if (re.test(content)) {
                matches.push(f);
            }
        }
        sendOutput({ matches });
    } catch (e) {
        sendError(e.message);
    }
}

async function handleListFiles({ path: dirPath, recursive }) {
    const absPath = getAbsolutePath(dirPath);
    try {
        const files = await glob(path.join(dirPath, recursive ? '**/*' : '*'), { cwd: PROJECT_ROOT });
        sendOutput({ files });
    } catch (e) {
        sendError(e.message);
    }
}

async function handleListCodeDefinitions({ path: dirPath }) {
    // Stub implementation: just lists files for now as parsing AST is heavy
    const absPath = getAbsolutePath(dirPath);
    try {
         const files = await glob(path.join(dirPath, '**/*.{js,ts,py,java,c,cpp}'), { cwd: PROJECT_ROOT });
         sendOutput({ definitions: `Found ${files.length} source files. (Deep AST parsing not implemented in this port)` });
    } catch (e) {
        sendError(e.message);
    }
}

let browser;
let page;

async function handleBrowserAction({ action, url, selector, text }) {
    try {
        if (!browser) {
            browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
            page = await browser.newPage();
        }

        let result = "";
        switch (action) {
            case 'launch':
            case 'goto':
                await page.goto(url);
                result = `Navigated to ${url}`;
                break;
            case 'click':
                await page.click(selector);
                result = `Clicked ${selector}`;
                break;
            case 'type':
                await page.type(selector, text);
                result = `Typed "${text}" into ${selector}`;
                break;
            case 'screenshot':
                const screenshotPath = path.join(PROJECT_ROOT, 'screenshot.png');
                await page.screenshot({ path: screenshotPath });
                result = `Screenshot saved to ${screenshotPath}`;
                break;
            case 'close':
                await browser.close();
                browser = null;
                page = null;
                result = "Browser closed";
                break;
            default:
                result = "Unknown action";
        }
        sendOutput({ result });
    } catch (e) {
        sendError(e.message);
    }
}

async function handleNewTask({ mode, message }) {
    // Update TODO or simple logs
    const entry = { mode, message, timestamp: new Date().toISOString() };
    let todos = [];
    if (fs.existsSync(TODO_FILE)) {
        todos = JSON.parse(fs.readFileSync(TODO_FILE, 'utf8'));
    }
    if (!Array.isArray(todos)) todos = []; // Handle malformed or new format if needed

    // Actually Roo uses todo for the plan. new_task is just resetting context usually.
    // We will just log it here.
    sendOutput({ result: `New task started in ${mode}: ${message}` });
}

async function handleUpdateTodo({ todo }) {
    fs.writeFileSync(TODO_FILE, JSON.stringify({ todo_list: todo }, null, 2), 'utf8');
    sendOutput({ result: "Todo list updated." });
}
