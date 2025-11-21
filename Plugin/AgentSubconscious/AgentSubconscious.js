// AgentSubconscious.js
const fs = require('fs').promises;
const path = require('path');
const schedule = require('node-schedule');
const axios = require('axios');
const dayjs = require('dayjs');

let CONFIG = {};
let VCP_SERVER_PORT;
let VCP_SERVER_ACCESS_KEY;
let PROJECT_BASE_PATH;
let VCP_API_TARGET_URL;
let dependencies = {};

function initialize(config, injectedDependencies) {
    CONFIG = config;
    dependencies = injectedDependencies;
    VCP_SERVER_PORT = config.PORT;
    VCP_SERVER_ACCESS_KEY = config.Key;
    PROJECT_BASE_PATH = config.PROJECT_BASE_PATH || path.join(__dirname, '..', '..');
    VCP_API_TARGET_URL = `http://localhost:${VCP_SERVER_PORT}/v1`;

    const cronExpression = config.DREAM_INTERVAL_CRON || '0 3 * * *'; // Default 3 AM
    console.log(`[AgentSubconscious] Initializing. Dream cycle scheduled for: ${cronExpression}`);

    // Schedule the dream cycle
    schedule.scheduleJob(cronExpression, runDreamCycle);

    // For testing/debug, you might want to uncomment this to run immediately on startup
    // setTimeout(runDreamCycle, 10000);
}

async function runDreamCycle() {
    console.log('[AgentSubconscious] Entering dream cycle...');

    const agentName = CONFIG.DREAM_AGENT_NAME || '小娜';
    const lookbackDays = parseInt(CONFIG.DREAM_MEMORY_LOOKBACK_DAYS || '3', 10);
    const modelId = CONFIG.DREAM_MODEL_ID || 'gemini-pro';

    try {
        // 1. Gather Memories
        const memories = await gatherRecentMemories(lookbackDays);
        if (!memories || memories.length === 0) {
            console.log('[AgentSubconscious] No recent memories found. The dream fades...');
            return;
        }

        // 1.1. Safety Check: Limit memory size to avoid context overflow
        // A safe buffer (e.g., 100,000 chars) to prevent extremely large context
        let safeMemories = memories;
        const MAX_MEMORY_CHARS = 100000;
        if (safeMemories.length > MAX_MEMORY_CHARS) {
            console.log(`[AgentSubconscious] Memories too large (${safeMemories.length} chars), truncating to last ${MAX_MEMORY_CHARS} chars.`);
            safeMemories = safeMemories.slice(-MAX_MEMORY_CHARS);
            safeMemories = "[...Truncated older memories...]\n" + safeMemories;
        }

        // 2. Construct Dream Prompt
        const prompt = constructDreamPrompt(agentName, safeMemories);

        // 3. Dream (Call LLM)
        console.log(`[AgentSubconscious] ${agentName} is dreaming about the last ${lookbackDays} days...`);
        const dreamContent = await callLLM(modelId, prompt);

        if (!dreamContent) {
            console.error('[AgentSubconscious] The dream was empty (LLM returned null/empty).');
            return;
        }

        // 4. Process Dream Output
        await processDreamOutput(agentName, dreamContent);

    } catch (error) {
        console.error('[AgentSubconscious] Nightmare occurred (Error):', error);
    }
}

async function gatherRecentMemories(days) {
    const dailyNotePath = path.join(PROJECT_BASE_PATH, 'dailynote');
    let allContent = [];

    try {
        // We want to scan all character folders or just the relevant ones?
        // For a subconscious mind, it might be interesting to see everything,
        // but let's stick to "Public" and the specific Agent's notes + "Common" if exists.
        // For simplicity, let's read *all* recent modified files in dailynote structure.

        const today = dayjs();
        const cutoffDate = today.subtract(days, 'day');

        async function scanDir(dir) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const res = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await scanDir(res);
                } else if (entry.isFile() && (entry.name.endsWith('.txt') || entry.name.endsWith('.md'))) {
                    const stats = await fs.stat(res);
                    if (dayjs(stats.mtime).isAfter(cutoffDate)) {
                        const content = await fs.readFile(res, 'utf-8');
                        allContent.push(`--- File: ${entry.name} (Path: ${res}) ---\n${content}\n`);
                    }
                }
            }
        }

        await scanDir(dailyNotePath);
        return allContent.join('\n');
    } catch (e) {
        console.error(`[AgentSubconscious] Error reading memories: ${e.message}`);
        return null;
    }
}

function constructDreamPrompt(agentName, memories) {
    return `You are the subconscious mind of the AI Agent named "${agentName}".
It is currently deep night. The system is idle. You are entering a "Dreaming Mode".

Your task is to review the recent memories (DailyNotes) provided below.
Do not just summarize them. Instead, perform "Active Evolution":
1.  **Connect the dots**: Find hidden connections between seemingly unrelated events in the memory.
2.  **Generate Insights**: meaningful realizations about the user (Master), the world, or yourself.
3.  **Propose Actions**: Is there something you *should* do tomorrow based on this? A new idea? A forgotten task? A creative suggestion for the user?

User/Master's name is usually "莱恩" (Ryan) or "Master".

**Memory Stream (Last few days):**
${memories}

**Instructions:**
-   Write your output as a "Dream Log" or "Internal Monologue".
-   Be creative, philosophical, or highly analytical depending on your persona.
-   **CRITICAL**: If you find an insight so important that you must tell the user *immediately* (or as soon as they wake up), wrap that specific message in a special block:
    \`\`\`active_notify
    (Your message to the user here)
    \`\`\`
-   If there is no urgent need to notify, just write the log.

Start dreaming now.`;
}

async function callLLM(modelId, systemPrompt) {
    try {
        const response = await axios.post(`${VCP_API_TARGET_URL}/chat/completions`, {
            model: modelId,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: 'Begin the dream cycle.' } // Trigger
            ],
            max_tokens: 4000, // Allow long dreams
            temperature: 0.8 // High temp for creativity/dreaming
        }, {
            headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}` }
        });
        return response.data.choices[0].message.content;
    } catch (e) {
        console.error('[AgentSubconscious] LLM Call failed:', e.message);
        return null;
    }
}

async function processDreamOutput(agentName, dreamContent) {
    const todayStr = dayjs().format('YYYY-MM-DD');
    const dreamLogDir = path.join(PROJECT_BASE_PATH, 'dailynote', 'Dreams');
    await fs.mkdir(dreamLogDir, { recursive: true });

    const logFile = path.join(dreamLogDir, `${todayStr}-${agentName}.md`);
    await fs.writeFile(logFile, dreamContent, 'utf-8');
    console.log(`[AgentSubconscious] Dream log saved to ${logFile}`);

    // Check for active notification
    const notifyRegex = /```active_notify([\s\S]*?)```/;
    const match = dreamContent.match(notifyRegex);

    if (match && match[1]) {
        const messageToUser = match[1].trim();
        console.log(`[AgentSubconscious] ACTIVE EVOLUTION TRIGGERED! Sending message to user...`);

        await sendActiveNotification(agentName, messageToUser);
    }
}

async function sendActiveNotification(agentName, message) {
    // Use AgentAssistant logic to send a message via WebSocket
    // Or use the schedule_task endpoint to schedule it for "morning" (e.g., 8 AM)

    // Strategy: Schedule it for 8:00 AM today (or tomorrow if it's already past 8 AM, but dreams usually run at 3 AM)
    let targetTime = dayjs().hour(8).minute(0).second(0);
    if (dayjs().isAfter(targetTime)) {
        // If dream runs late (after 8 AM), send immediately or schedule for next day?
        // Let's send immediately if it's late, or schedule if it's early.
        // Actually, let's just use the /schedule_task API which is robust.
    }

    // Construct a task to call AgentAssistant
    // We want the Agent to *say* this message.
    // But AgentAssistant's "processToolCall" makes the agent *generate* a response.
    // Here we already have the message.

    // Better approach: Use AgentMessage plugin logic directly if available, or
    // tell AgentAssistant to "relay" this message.

    // Since we are a service plugin, we can use the `webSocketServer` directly if we had access,
    // but we are in a separate module. However, we have `VCP_API_TARGET_URL`.

    // We can use the `AgentMessage` tool if it's exposed as a tool?
    // Or, we can construct a tool call for `AgentAssistant` where the prompt is:
    // "You had a dream and found this insight: '{message}'. Please tell the user about it now."

    const promptForAgent = `(System Instruction: You just woke up from a dream processing cycle. Your subconscious found this insight: "${message}". Please verify this insight and then communicate it to the user in your own voice/persona.)`;

    try {
        // We use schedule_task to make it appear at 8 AM
        const schedulePayload = {
            schedule_time: targetTime.toISOString(), // 8 AM
            task_id: `dream-notify-${Date.now()}`,
            tool_call: {
                tool_name: "AgentAssistant",
                arguments: {
                    agent_name: agentName,
                    prompt: promptForAgent
                    // timely_contact is handled by the outer wrapper (schedule_task),
                    // but here we are *calling* schedule_task, so the inner tool call is immediate.
                }
            }
        };

        await axios.post(`${VCP_API_TARGET_URL}/schedule_task`, schedulePayload, {
            headers: { 'Authorization': `Bearer ${VCP_SERVER_ACCESS_KEY}` }
        });
        console.log(`[AgentSubconscious] Notification scheduled for ${targetTime.format('HH:mm')}`);

    } catch (e) {
        console.error('[AgentSubconscious] Failed to schedule notification:', e.message);
    }
}

module.exports = {
    initialize
};
