import fs from 'fs-extra';
import path from 'path';
import execa from 'execa';
import { glob } from 'glob';
import puppeteer from 'puppeteer';
import { distance } from 'fastest-levenshtein';
import * as diff from 'diff';

// --- Helper Functions ---

function getAbsolutePath(relPath) {
    const cwd = process.env.PROJECT_BASE_PATH || process.cwd();
    return path.resolve(cwd, relPath);
}

function normalizeString(str) {
    // Simple normalization, can be expanded based on Roo Code's full implementation
    return str.replace(/\r\n/g, '\n').trim();
}

function getSimilarity(original, search) {
    if (search === "") return 0;
    const normalizedOriginal = normalizeString(original);
    const normalizedSearch = normalizeString(search);
    if (normalizedOriginal === normalizedSearch) return 1;
    const dist = distance(normalizedOriginal, normalizedSearch);
    const maxLength = Math.max(normalizedOriginal.length, normalizedSearch.length);
    return 1 - dist / maxLength;
}

// --- MultiSearchReplaceDiffStrategy Implementation ---
// Ported and simplified from Roo Code for Node.js usage without VSCode dependencies

class MultiSearchReplaceDiffStrategy {
    constructor(fuzzyThreshold = 1.0, bufferLines = 40) {
        this.fuzzyThreshold = fuzzyThreshold;
        this.bufferLines = bufferLines;
    }

    unescapeMarkers(content) {
        return content
            .replace(/^\\<<<<<<</gm, "<<<<<<<")
            .replace(/^\\=======/gm, "=======")
            .replace(/^\\>>>>>>>/gm, ">>>>>>>")
            .replace(/^\\-------/gm, "-------")
            .replace(/^\\:end_line:/gm, ":end_line:")
            .replace(/^\\:start_line:/gm, ":start_line:");
    }

    async applyDiff(originalContent, diffContent) {
        // Regex to parse the diff block
        // Matches: <<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE
        const regex = /(?:^|\n)(?<!\\)<<<<<<< SEARCH>?\s*\n((?:\:start_line:\s*(\d+)\s*\n))?((?:\:end_line:\s*(\d+)\s*\n))?((?<!\\)-------\s*\n)?([\s\S]*?)(?:\n)?(?:(?<=\n)(?<!\\)=======\s*\n)([\s\S]*?)(?:\n)?(?:(?<=\n)(?<!\\)>>>>>>> REPLACE)(?=\n|$)/g;

        const matches = [...diffContent.matchAll(regex)];

        if (matches.length === 0) {
             return { success: false, error: "Invalid diff format - missing required sections" };
        }

        const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
        let resultLines = originalContent.split(/\r?\n/);
        let delta = 0;
        let diffResults = [];
        let appliedCount = 0;

        const replacements = matches.map(match => ({
            startLine: Number(match[2] ?? 0),
            searchContent: match[6],
            replaceContent: match[7]
        })).sort((a, b) => a.startLine - b.startLine);

        for (const replacement of replacements) {
            let { searchContent, replaceContent, startLine: explicitStartLine } = replacement;

            // Unescape
            searchContent = this.unescapeMarkers(searchContent);
            replaceContent = this.unescapeMarkers(replaceContent);

            let searchLines = searchContent === "" ? [] : searchContent.split(/\r?\n/);
            let replaceLines = replaceContent === "" ? [] : replaceContent.split(/\r?\n/);

            // Simple search: find exact match or best fuzzy match
            // For VCP simplification, we'll try exact match first, then basic substring match
            // We ignore the complex "middle-out" fuzzy logic for now to reduce complexity unless needed.
            // But we SHOULD try to respect the start line if given.

            let matchIndex = -1;
            let bestMatchScore = 0;

            // Adjust startLine for previous edits
            let startLine = explicitStartLine > 0 ? explicitStartLine + delta : 0;

            // Strategy: Convert lines to a single string for search (ignoring line endings difference for search)
            // But modifying lines array is safer for keeping structure.

            // Simplistic exact search first
            // We search in resultLines

            // If startLine is provided, check there first
            if (startLine > 0 && startLine <= resultLines.length) {
                // Check if searchLines match exactly at startLine - 1
                let matchesAtLine = true;
                for (let i = 0; i < searchLines.length; i++) {
                    if (startLine - 1 + i >= resultLines.length || resultLines[startLine - 1 + i].trim() !== searchLines[i].trim()) {
                         // We do a loose trim check for now
                         matchesAtLine = false;
                         break;
                    }
                }

                if (matchesAtLine) {
                    matchIndex = startLine - 1;
                }
            }

            if (matchIndex === -1) {
                // Scan the file
                for (let i = 0; i <= resultLines.length - searchLines.length; i++) {
                    let matchesAtLine = true;
                    for (let j = 0; j < searchLines.length; j++) {
                        // Strict check or trimmed check? Roo Code uses normalizedString which trims.
                        if (normalizeString(resultLines[i + j]) !== normalizeString(searchLines[j])) {
                            matchesAtLine = false;
                            break;
                        }
                    }
                    if (matchesAtLine) {
                        matchIndex = i;
                        break; // Find first occurrence
                    }
                }
            }

            if (matchIndex === -1) {
                diffResults.push({ success: false, error: `Could not find match for:\n${searchContent}` });
                continue;
            }

            // Perform Replacement
            // Remove searchLines
            // Insert replaceLines
            // We need to preserve indentation if possible, but Roo Code logic is complex.
            // Simplified: Use the replaceLines as is.

            const before = resultLines.slice(0, matchIndex);
            const after = resultLines.slice(matchIndex + searchLines.length);

            resultLines = [...before, ...replaceLines, ...after];

            // Update delta
            delta += (replaceLines.length - searchLines.length);
            appliedCount++;
        }

        if (appliedCount === 0) {
            return { success: false, error: "No changes applied. " + diffResults.map(r => r.error).join('\n') };
        }

        return { success: true, content: resultLines.join(lineEnding) };
    }
}


// --- Tool Implementations ---

async function execute_command(args) {
    if (args.commandIdentifier !== 'execute_command') return null;

    // Check Admin Code
    const requireAdmin = args.requireAdmin;
    const realCode = process.env.DECRYPTED_AUTH_CODE;
    if (!realCode || String(requireAdmin) !== realCode) {
        return { success: false, error: "Admin authentication failed. Please provide valid requireAdmin code." };
    }

    const cwd = args.cwd ? getAbsolutePath(args.cwd) : (process.env.PROJECT_BASE_PATH || process.cwd());

    try {
        const { stdout, stderr } = await execa(args.command, { shell: true, cwd, all: true });
        return { success: true, result: stdout || stderr };
    } catch (error) {
        return { success: false, error: error.message + "\n" + (error.stderr || "") };
    }
}

async function read_file(args) {
    if (args.commandIdentifier !== 'read_file') return null;
    const filePath = getAbsolutePath(args.path);
    try {
        const content = await fs.readFile(filePath, 'utf8');
        // Add line numbers as per Roo Code description?
        // "The tool outputs line-numbered content"
        const lines = content.split('\n').map((line, i) => `${i + 1} | ${line}`).join('\n');
        return { success: true, result: lines };
    } catch (error) {
        return { success: false, error: `Failed to read file ${args.path}: ${error.message}` };
    }
}

async function write_to_file(args) {
    if (args.commandIdentifier !== 'write_to_file') return null;
    const filePath = getAbsolutePath(args.path);
    try {
        await fs.outputFile(filePath, args.content);
        return { success: true, result: `Successfully wrote to ${args.path}` };
    } catch (error) {
        return { success: false, error: `Failed to write file ${args.path}: ${error.message}` };
    }
}

async function apply_diff(args) {
    if (args.commandIdentifier !== 'apply_diff') return null;
    const filePath = getAbsolutePath(args.path);

    try {
        if (!await fs.pathExists(filePath)) {
            return { success: false, error: `File not found: ${args.path}` };
        }

        const originalContent = await fs.readFile(filePath, 'utf8');
        const diffStrategy = new MultiSearchReplaceDiffStrategy();
        const result = await diffStrategy.applyDiff(originalContent, args.diff);

        if (result.success) {
            await fs.writeFile(filePath, result.content);
            return { success: true, result: `Successfully applied diff to ${args.path}` };
        } else {
            return { success: false, error: `Failed to apply diff: ${result.error}` };
        }
    } catch (error) {
        return { success: false, error: `Error processing diff for ${args.path}: ${error.message}` };
    }
}

async function search_files(args) {
    if (args.commandIdentifier !== 'search_files') return null;
    const searchPath = getAbsolutePath(args.path);
    const regexPattern = new RegExp(args.regex); // Note: JS regex, not Rust regex
    const filePattern = args.file_pattern || '**/*';

    try {
        const files = await glob(filePattern, { cwd: searchPath, nodir: true, absolute: true });
        let results = [];

        for (const file of files) {
            try {
                const content = await fs.readFile(file, 'utf8');
                const lines = content.split('\n');
                lines.forEach((line, index) => {
                    if (regexPattern.test(line)) {
                        results.push(`${path.relative(searchPath, file)}:${index + 1}: ${line.trim()}`);
                    }
                });
            } catch (err) {
                // Ignore read errors
            }
        }

        if (results.length === 0) return { success: true, result: "No matches found." };
        return { success: true, result: results.join('\n') };
    } catch (error) {
        return { success: false, error: `Search failed: ${error.message}` };
    }
}

async function list_files(args) {
    if (args.commandIdentifier !== 'list_files') return null;
    const dirPath = getAbsolutePath(args.path);
    const recursive = args.recursive === 'true' || args.recursive === true;

    try {
        if (recursive) {
             const files = await glob('**/*', { cwd: dirPath, mark: true });
             return { success: true, result: files.join('\n') };
        } else {
            const files = await fs.readdir(dirPath, { withFileTypes: true });
            const result = files.map(f => f.isDirectory() ? f.name + '/' : f.name).join('\n');
            return { success: true, result };
        }
    } catch (error) {
        return { success: false, error: `List files failed: ${error.message}` };
    }
}

async function list_code_definition_names(args) {
    if (args.commandIdentifier !== 'list_code_definition_names') return null;
    // Simplified regex-based implementation as Tree-sitter setup is complex for a portable plugin
    // This is a "good enough" approximation for now.
    const targetPath = getAbsolutePath(args.path);

    try {
        const stats = await fs.stat(targetPath);
        let filesToScan = [];

        if (stats.isDirectory()) {
            const allFiles = await fs.readdir(targetPath);
            filesToScan = allFiles.filter(f => /\.(js|ts|py|java|c|cpp|cs)$/.test(f)).map(f => path.join(targetPath, f));
        } else {
            filesToScan = [targetPath];
        }

        let definitions = [];

        for (const file of filesToScan) {
            const content = await fs.readFile(file, 'utf8');
            // Regex to catch class, function, const x = () =>, def, etc.
            // Enhanced regex to catch more patterns
            const regex = /(?:class|function|def|interface|type)\s+([a-zA-Z0-9_]+)|(?:const|let|var)\s+([a-zA-Z0-9_]+)\s*=\s*(?:async\s*)?(?:function|\(|new|class)|(?:public|private|protected|static)\s+(?:async\s+)?([a-zA-Z0-9_]+)\s*\(/g;
            let match;
            while ((match = regex.exec(content)) !== null) {
                // match[1]: class/func/def/interface/type Name
                // match[2]: const/let/var Name = ...
                // match[3]: method Name (in classes)
                definitions.push(`${path.basename(file)}: ${match[1] || match[2] || match[3]}`);
            }
        }

        if (definitions.length === 0) return { success: true, result: "No definitions found (regex scan)." };
        return { success: true, result: definitions.join('\n') };
    } catch (error) {
        return { success: false, error: `Failed to list definitions: ${error.message}` };
    }
}

// Global browser instance for session persistence
let browserInstance = null;
let browserPage = null;

async function browser_action(args) {
    if (args.commandIdentifier !== 'browser_action') return null;
    const action = args.action;

    try {
        if (action === 'launch') {
            if (browserInstance) await browserInstance.close();
            browserInstance = await puppeteer.launch({
                headless: "new",
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            browserPage = await browserInstance.newPage();
            if (args.url) await browserPage.goto(args.url);
            return { success: true, result: `Browser launched at ${args.url}` };
        }

        if (!browserInstance || !browserPage) {
            return { success: false, error: "Browser not launched. Use launch action first." };
        }

        if (action === 'close') {
            await browserInstance.close();
            browserInstance = null;
            browserPage = null;
            return { success: true, result: "Browser closed." };
        }

        if (action === 'click') {
            // Coordinate format: x,y@WxH
            // We need to parse this. simplified: assume standard x,y
            // If coordinate string is provided like "400,300@1024x768", we extract x,y
            const coords = args.coordinate.split('@')[0].split(',');
            const x = parseInt(coords[0]);
            const y = parseInt(coords[1]);
            await browserPage.mouse.click(x, y);
            return { success: true, result: `Clicked at ${x},${y}` };
        }

        if (action === 'type') {
            await browserPage.keyboard.type(args.text);
            return { success: true, result: `Typed: ${args.text}` };
        }

        if (action === 'scroll_down') {
            await browserPage.evaluate(() => window.scrollBy(0, window.innerHeight));
             return { success: true, result: "Scrolled down." };
        }

        // Capture screenshot after action
        const screenshot = await browserPage.screenshot({ encoding: 'base64' });

        // Return multi-modal result
        return {
            success: true,
            result: {
                content: [
                    { type: 'text', text: `Action ${action} executed.` },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } }
                ]
            }
        };

    } catch (error) {
         return { success: false, error: `Browser action failed: ${error.message}` };
    }
}

async function ask_followup_question(args) {
    if (args.commandIdentifier !== 'ask_followup_question') return null;
    return { success: true, result: `[Question to User]: ${args.question}` };
}

async function attempt_completion(args) {
    if (args.commandIdentifier !== 'attempt_completion') return null;
    return { success: true, result: `[Task Completed]: ${args.result}` };
}

async function switch_mode(args) {
    if (args.commandIdentifier !== 'switch_mode') return null;
    // Roo Code switches mode internally. Here we acknowledge it to the context.
    return {
        success: true,
        result: `Switched to ${args.mode} mode. ${args.reason ? `Reason: ${args.reason}` : ''}\nI will now adopt the ${args.mode} persona.`
    };
}

async function update_todo_list(args) {
    if (args.commandIdentifier !== 'update_todo_list') return null;
    const todoPath = getAbsolutePath('.roo_todo.json');
    try {
        await fs.writeJson(todoPath, { todo: args.todo }, { spaces: 2 });
        return { success: true, result: "Todo list updated." };
    } catch (error) {
        return { success: false, error: `Failed to update todo list: ${error.message}` };
    }
}

async function new_task(args) {
    if (args.commandIdentifier !== 'new_task') return null;
    const todoPath = getAbsolutePath('.roo_todo.json');
    try {
        // Reset todo list
        if (await fs.pathExists(todoPath)) {
             await fs.remove(todoPath);
        }
        return {
            success: true,
            result: `New task started in ${args.mode} mode.\nMessage: ${args.message}\nContext and todo list have been reset.`
        };
    } catch (error) {
        return { success: false, error: `Failed to start new task: ${error.message}` };
    }
}


// --- Main Handler ---

async function main() {
    // Read stdin
    let inputData = '';
    process.stdin.on('data', chunk => {
        inputData += chunk;
    });

    process.stdin.on('end', async () => {
        try {
            const request = JSON.parse(inputData);

            // Handle bulk commands (command1, command2...) or single command
            // VCP spec says server sends cleaned args.
            // If it's a bulk call, we might see command1, command2.
            // BUT for Roo Code tools, we usually get a single tool call per turn unless user chained them.
            // Let's assume standard object structure first.

            const cmd = request.commandIdentifier;

            if (!cmd) {
                 // Fallback: check if 'command' is used
                 if (request.command) request.commandIdentifier = request.command;
            }

            const handlers = [
                execute_command,
                read_file,
                write_to_file,
                apply_diff,
                search_files,
                list_files,
                list_code_definition_names,
                browser_action,
                ask_followup_question,
                attempt_completion,
                switch_mode,
                update_todo_list,
                new_task
            ];

            let handled = false;
            for (const handler of handlers) {
                const result = await handler(request);
                if (result) {
                    response = result;
                    handled = true;
                    break;
                }
            }

            var response;

            if (!handled) {
                response = { success: false, error: `Unknown command: ${request.commandIdentifier}` };
            }

            // Format output for VCP
            // VCP expects { status: "success"|"error", result: ... }
            const output = {
                status: response.success ? "success" : "error",
                [response.success ? "result" : "error"]: response.success ? response.result : response.error
            };

            console.log(JSON.stringify(output));

        } catch (error) {
            console.log(JSON.stringify({ status: "error", error: `Plugin crash: ${error.message}` }));
        }
    });
}

main();
