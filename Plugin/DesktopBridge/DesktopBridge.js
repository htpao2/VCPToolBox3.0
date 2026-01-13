// Plugin/DesktopBridge/DesktopBridge.js
const pluginManager = require('../../Plugin.js');

let pluginConfig = {};
let debugMode = false;
let webSocketServer = null;

// 存储连接的桌面客户端
const connectedClients = new Map();

// 状态管理
let latestImageBase64 = null; // 存储最新的 Base64 图片数据
let lastImageTimestamp = 0;
let isActiveMode = false; // 是否处于主动监控模式
const PLACEHOLDER_KEY = "{{VCPDesktopImage}}"; // 注入到 Prompt 的占位符（实际上会被预处理器替换为 Image Object）
const MARKER_STRING = "<<VCP_DESKTOP_IMAGE_MARKER>>"; // 预处理器识别的标记字符串

function initialize(config, dependencies) {
    pluginConfig = config;
    debugMode = pluginConfig.DebugMode || false;

    // 如果有 WebSocketServer 依赖，保存它
    // 注意：PluginManager.initializeServices 会传递 dependencies，但这取决于 server.js 的实现
    // 如果 dependencies 中包含 webSocketServer（目前 server.js 似乎没传），我们需要另一种方式获取。
    // 但是，DesktopBridge 是通过 WebSocketServer 主动调用的 (handleNewClient)，所以这里主要是为了保存引用以便主动发送消息

    if (debugMode) {
        console.log('[DesktopBridge] Initializing...');
    }

    // 初始化占位符
    updateStatusPlaceholder();
    // 设置 Image 占位符为标记字符串，以便预处理器识别
    pluginManager.staticPlaceholderValues.set(PLACEHOLDER_KEY, { value: MARKER_STRING, serverId: 'local' });
}

function updateStatusPlaceholder() {
    let statusText = "";
    if (connectedClients.size === 0) {
        statusText = "桌面客户端未连接。";
    } else {
        statusText = `桌面客户端已连接。监控模式: ${isActiveMode ? "开启 (实时)" : "关闭 (待机)"}。`;
        if (latestImageBase64) {
            const timeDiff = Math.round((Date.now() - lastImageTimestamp) / 1000);
            statusText += ` 最新画面捕获于 ${timeDiff} 秒前。`;
        }
    }
    pluginManager.staticPlaceholderValues.set("{{VCPDesktopStatus}}", { value: statusText, serverId: 'local' });
}

// 被 WebSocketServer 调用：注册新客户端
function handleNewClient(ws) {
    const clientId = ws.clientId;
    connectedClients.set(clientId, ws);

    console.log(`[DesktopBridge] ✅ 桌面客户端已连接: ${clientId}`);
    updateStatusPlaceholder();

    // 如果当前是开启状态，立即通知客户端开始捕获
    if (isActiveMode) {
        sendControlCommand(clientId, 'start_capture');
    }

    ws.on('close', () => {
        connectedClients.delete(clientId);
        console.log(`[DesktopBridge] ❌ 桌面客户端断开: ${clientId}`);
        updateStatusPlaceholder();
        latestImageBase64 = null; // 客户端断开，清除缓存图像
    });
}

// 被 WebSocketServer 调用：处理客户端消息
function handleClientMessage(clientId, message) {
    if (message.type === 'screen_update') {
        const base64Data = message.data.image;
        if (base64Data) {
            latestImageBase64 = base64Data;
            lastImageTimestamp = Date.now();
            updateStatusPlaceholder();
            if (debugMode) {
                console.log(`[DesktopBridge] 📷 收到屏幕更新, 大小: ${base64Data.length} 字节`);
            }
        }
    } else if (message.type === 'info') {
        if (debugMode) {
            console.log(`[DesktopBridge] ℹ️ 客户端信息: ${message.data.message}`);
        }
    }
}

// 辅助：发送控制命令给客户端
function sendControlCommand(clientId, command, args = {}) {
    const ws = connectedClients.get(clientId);
    if (ws && ws.readyState === 1) { // WebSocket.OPEN
        const msg = {
            type: 'command',
            command: command,
            args: args
        };
        ws.send(JSON.stringify(msg));
        return true;
    }
    return false;
}

// 广播命令给所有连接的客户端
function broadcastControlCommand(command, args = {}) {
    let sentCount = 0;
    for (const [clientId, ws] of connectedClients) {
        if (sendControlCommand(clientId, command, args)) {
            sentCount++;
        }
    }
    return sentCount;
}

// 工具调用接口
async function processToolCall(params) {
    const command = params.command;

    if (command === 'switch_desktop_mode') {
        const active = params.active === 'true' || params.active === true;

        isActiveMode = active;
        updateStatusPlaceholder();

        if (connectedClients.size === 0) {
            return `桌面监控模式已设为 ${active ? "开启" : "关闭"}，但当前没有连接的桌面客户端。请运行 VCPDesktop 客户端。`;
        }

        const cmdToSend = active ? 'start_capture' : 'stop_capture';
        broadcastControlCommand(cmdToSend);

        return `桌面监控模式已${active ? "开启" : "关闭"}。客户端已收到指令。`;
    }

    throw new Error(`未知的命令: ${command}`);
}

// 消息预处理器：将 {{VCPDesktopImage}} 标记替换为实际的 Image Object
async function processMessages(messages, config) {
    // 如果没有最新图片，或者不处于活跃模式且缓存太旧（超过30秒），则不注入图片
    // 或者我们允许“被动查询”时也注入（如果用户手动开启了模式）
    // 只要有 latestImageBase64 且 MARKER 存在，就替换

    if (!latestImageBase64) {
        // 如果没有图片，我们可以把标记替换为提示文本
        return replaceMarkerWithText(messages, " [当前无桌面画面数据] ");
    }

    // 深拷贝消息以避免副作用
    const processedMessages = JSON.parse(JSON.stringify(messages));

    for (let i = 0; i < processedMessages.length; i++) {
        const msg = processedMessages[i];

        // 只有 user 或 system 消息可能包含该标记 (通常在 system prompt 或 user template 中)
        if (msg.content) {
            if (typeof msg.content === 'string') {
                if (msg.content.includes(MARKER_STRING)) {
                    // 字符串包含标记，转换为数组并注入图片
                    msg.content = splitAndInjectImage(msg.content, latestImageBase64);
                }
            } else if (Array.isArray(msg.content)) {
                // 已经是数组，遍历 Text Parts 寻找标记
                const newContent = [];
                for (const part of msg.content) {
                    if (part.type === 'text' && typeof part.text === 'string' && part.text.includes(MARKER_STRING)) {
                        const injectedParts = splitAndInjectImage(part.text, latestImageBase64);
                        newContent.push(...injectedParts);
                    } else {
                        newContent.push(part);
                    }
                }
                msg.content = newContent;
            }
        }
    }

    return processedMessages;
}

function splitAndInjectImage(text, base64Data) {
    const parts = text.split(MARKER_STRING);
    const result = [];

    // 如果文本以标记开头，parts[0] 为空字符串
    if (parts[0]) result.push({ type: 'text', text: parts[0] });

    // 插入图片对象
    // 注意：标准的 OpenAI Vision 格式。如果是 Claude 或其他，可能需要不同的适配。
    // VCP 的 ImageProcessor 似乎使用 { type: "image_url", image_url: { url: ... } }
    result.push({
        type: "image_url",
        image_url: {
            url: `data:image/jpeg;base64,${base64Data}` // 假设客户端发送的是 JPEG
        }
    });

    // 处理剩余部分
    // split 会产生 n+1 个部分，中间夹着 n 个标记
    // 这里简化处理：假设只有一个标记或每个标记都替换
    for (let i = 1; i < parts.length; i++) {
        if (parts[i]) result.push({ type: 'text', text: parts[i] });
        if (i < parts.length - 1) {
            // 如果还有更多部分，说明有多个标记，继续插入图片
             result.push({
                type: "image_url",
                image_url: {
                    url: `data:image/jpeg;base64,${base64Data}`
                }
            });
        }
    }

    return result;
}

function replaceMarkerWithText(messages, replacementText) {
    const processedMessages = JSON.parse(JSON.stringify(messages));
    for (const msg of processedMessages) {
        if (typeof msg.content === 'string') {
            msg.content = msg.content.replaceAll(MARKER_STRING, replacementText);
        } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
                if (part.type === 'text' && part.text) {
                    part.text = part.text.replaceAll(MARKER_STRING, replacementText);
                }
            }
        }
    }
    return processedMessages;
}

function shutdown() {
    console.log('[DesktopBridge] Shutting down...');
    connectedClients.clear();
    latestImageBase64 = null;
}

module.exports = {
    initialize,
    handleNewClient,
    handleClientMessage,
    processToolCall,
    processMessages, // 导出预处理器
    shutdown
};