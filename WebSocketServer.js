// WebSocketServer.js
const WebSocket = require('ws');
const url = require('url');

let wssInstance;
let pluginManager = null; // 为 PluginManager 实例占位
let serverConfig = {
    debugMode: false,
    vcpKey: null
};

// 用于存储不同类型的客户端
const clients = new Map(); // VCPLog 等普通客户端
const distributedServers = new Map(); // 分布式服务器客户端
const chromeObserverClients = new Map(); // 新增：ChromeObserver 客户端
const pendingToolRequests = new Map(); // 跨服务器工具调用的待处理请求
const pendingChromeCommands = new Map(); // 用于追踪发送给Chrome的命令
const distributedServerIPs = new Map(); // 新增：存储分布式服务器的IP信息

function generateClientId() {
    // 用于生成客户端ID和请求ID
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}

async function writeLog(message) {
    // 实际项目中，这里可以对接更完善的日志系统
    // 为了简化，暂时只在 debugMode 开启时打印到控制台
    if (serverConfig.debugMode) {
        console.log(`[WebSocketServer] ${new Date().toISOString()} - ${message}`);
    }
}

function initialize(httpServer, config) {
    if (!httpServer) {
        console.error('[WebSocketServer] Cannot initialize without an HTTP server instance.');
        return;
    }
    serverConfig = { ...serverConfig, ...config };

    if (!serverConfig.vcpKey && serverConfig.debugMode) {
        console.warn('[WebSocketServer] VCP_Key not set. WebSocket connections will not be authenticated if default path is used.');
    }

    wssInstance = new WebSocket.Server({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        const parsedUrl = url.parse(request.url, true);
        const pathname = parsedUrl.pathname;

        const vcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
        const distServerPathRegex = /^\/vcp-distributed-server\/VCP_Key=(.+)$/;
        const chromeObserverPathRegex = /^\/vcp-chrome-observer\/VCP_Key=(.+)$/;

        const vcpMatch = pathname.match(vcpLogPathRegex);
        const distMatch = pathname.match(distServerPathRegex);
        const chromeObserverMatch = pathname.match(chromeObserverPathRegex);

        let isAuthenticated = false;
        let clientType = null;
        let connectionKey = null;

        if (vcpMatch && vcpMatch[1]) {
            clientType = 'VCPLog';
            connectionKey = vcpMatch[1];
            writeLog(`VCPLog client attempting to connect.`);
        } else if (distMatch && distMatch[1]) {
            clientType = 'DistributedServer';
            connectionKey = distMatch[1];
            writeLog(`Distributed Server attempting to connect.`);
        } else if (chromeObserverMatch && chromeObserverMatch[1]) {
           clientType = 'ChromeObserver';
           connectionKey = chromeObserverMatch[1];
           writeLog(`ChromeObserver client attempting to connect.`);
        } else {
            writeLog(`WebSocket upgrade request for unhandled path: ${pathname}. Ignoring.`);
            socket.destroy();
            return;
        }

        if (serverConfig.vcpKey && connectionKey === serverConfig.vcpKey) {
            isAuthenticated = true;
        } else {
            writeLog(`${clientType} connection denied. Invalid or missing VCP_Key.`);
            socket.destroy();
            return;
        }

        if (isAuthenticated) {
            wssInstance.handleUpgrade(request, socket, head, (ws) => {
                const clientId = generateClientId();
                ws.clientId = clientId;
                ws.clientType = clientType;

                if (clientType === 'DistributedServer') {
                    const serverId = `dist-${clientId}`;
                    ws.serverId = serverId;
                    distributedServers.set(serverId, { ws, tools: [], ips: {} }); // 初始化ips字段
                    writeLog(`Distributed Server ${serverId} authenticated and connected.`);
                } else if (clientType === 'ChromeObserver') {
                    console.log(`[WebSocketServer FORCE LOG] A client with type 'ChromeObserver' (ID: ${clientId}) has connected.`); // 强制日志
                   const chromeObserverModule = pluginManager.getServiceModule('ChromeObserver');
                   chromeObserverClients.set(clientId, ws); // 新增：将客户端存入Map
                   writeLog(`ChromeObserver client ${clientId} connected and stored.`);
                   if (chromeObserverModule && typeof chromeObserverModule.handleNewClient === 'function') {
                       console.log(`[WebSocketServer FORCE LOG] Found ChromeObserver module. Calling handleNewClient...`); // 强制日志
                       chromeObserverModule.handleNewClient(ws);
                   } else {
                        writeLog(`Warning: ChromeObserver client connected, but module not found or handleNewClient is missing.`);
                        console.log(`[WebSocketServer FORCE LOG] ChromeObserver module not found or handleNewClient is missing.`); // 强制日志
                   }
                } else {
                    clients.set(clientId, ws);
                    writeLog(`Client ${clientId} (Type: ${clientType}) authenticated and connected.`);
                }

                wssInstance.emit('connection', ws, request);
            });
        }
    });

    wssInstance.on('connection', (ws, request) => {
        if (serverConfig.debugMode) {
            console.log(`[WebSocketServer] Client ${ws.clientId} connected.`);
        }

        // 发送连接确认消息给特定类型的客户端
        if (ws.clientType === 'VCPLog') {
            ws.send(JSON.stringify({ type: 'connection_ack', message: 'WebSocket connection successful for VCPLog.' }));
        }
        // 可以根据 ws.clientType 或其他标识符发送不同的欢迎消息

        ws.on('message', (message) => {
            if (serverConfig.debugMode) {
                // Buffer转为String以便日志记录
                const messageString = message.toString();
                console.log(`[WebSocketServer] Received message from ${ws.clientId} (${ws.clientType}): ${messageString.substring(0, 300)}...`);
            }
            try {
                const parsedMessage = JSON.parse(message);
                if (ws.clientType === 'DistributedServer') {
                    handleDistributedServerMessage(ws.serverId, parsedMessage);
                } else if (ws.clientType === 'ChromeObserver') {
                    // 检查是否是命令执行结果
                    if (parsedMessage.type === 'command_result' && parsedMessage.data && parsedMessage.data.requestId) {
                        const pendingCommand = pendingChromeCommands.get(parsedMessage.data.requestId);
                        if (pendingCommand) {
                            clearTimeout(pendingCommand.timeout);
                            if (parsedMessage.data.status === 'success') {
                                // The result from content_script is in the 'message' field
                                pendingCommand.resolve({ status: 'success', result: parsedMessage.data.result || parsedMessage.data.message });
                            } else {
                                pendingCommand.reject(new Error(parsedMessage.data.error || 'Chrome extension returned an error.'));
                            }
                            pendingChromeCommands.delete(parsedMessage.data.requestId);
                        }
                    } else {
                        // 否则，让ChromeObserver服务插件处理其他消息（如pageInfoUpdate）
                        const chromeObserverModule = pluginManager.getServiceModule('ChromeObserver');
                        if (chromeObserverModule && typeof chromeObserverModule.handleClientMessage === 'function') {
                            chromeObserverModule.handleClientMessage(ws.clientId, parsedMessage);
                        }
                    }
                } else {
                    // 未来处理其他客户端类型的消息
                }
            } catch (e) {
                console.error(`[WebSocketServer] Failed to parse message from client ${ws.clientId}:`, message.toString(), e);
            }
        });

        ws.on('close', () => {
            if (ws.clientType === 'DistributedServer') {
                if (pluginManager) {
                    pluginManager.unregisterAllDistributedTools(ws.serverId);
                }
                distributedServers.delete(ws.serverId);
                distributedServerIPs.delete(ws.serverId); // 新增：移除IP信息
                writeLog(`Distributed Server ${ws.serverId} disconnected. Its tools and IP info have been unregistered.`);
            } else if (ws.clientType === 'ChromeObserver') {
              chromeObserverClients.delete(ws.clientId);
              writeLog(`ChromeObserver client ${ws.clientId} disconnected and removed.`);
           } else {
               clients.delete(ws.clientId);
           }
            if (serverConfig.debugMode) {
                console.log(`[WebSocketServer] Client ${ws.clientId} (${ws.clientType}) disconnected.`);
            }
        });

        ws.on('error', (error) => {
            console.error(`[WebSocketServer] Error with client ${ws.clientId}:`, error);
            writeLog(`WebSocket error for client ${ws.clientId}: ${error.message}`);
            // 确保在出错时也从 clients Map 中移除
            if(ws.clientId) clients.delete(ws.clientId);
        });
    });

    if (serverConfig.debugMode) {
        console.log(`[WebSocketServer] Initialized. Waiting for HTTP server upgrades.`);
    }
}

// 广播给所有已连接且认证的客户端，或者根据 clientType 筛选
function broadcast(data, targetClientType = null) {
    if (!wssInstance) return;
    const messageString = JSON.stringify(data);

    const clientsToBroadcast = new Map([
       ...clients,
       ...Array.from(distributedServers.values()).map(ds => [ds.ws.clientId, ds.ws])
   ]);

    clientsToBroadcast.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            if (targetClientType === null || clientWs.clientType === targetClientType) {
                clientWs.send(messageString);
            }
        }
    });
    writeLog(`Broadcasted (Target: ${targetClientType || 'All'}): ${messageString.substring(0, 200)}...`);
}

// 发送给特定客户端
function sendMessageToClient(clientId, data) {
   // Check all client maps
   const clientWs = clients.get(clientId) ||
                    (Array.from(distributedServers.values()).find(ds => ds.ws.clientId === clientId) || {}).ws ||
                    chromeObserverClients.get(clientId);

    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(data));
        writeLog(`Sent message to client ${clientId}: ${JSON.stringify(data)}`);
        return true;
    }
    writeLog(`Failed to send message to client ${clientId}: Not found or not open.`);
    return false;
}

function shutdown() {
    if (serverConfig.debugMode) {
        console.log('[WebSocketServer] Shutting down...');
    }
    if (wssInstance) {
        wssInstance.clients.forEach(client => {
            client.close();
        });
        wssInstance.close(() => {
            if (serverConfig.debugMode) {
                console.log('[WebSocketServer] Server closed.');
            }
        });
    }
    writeLog('WebSocketServer shutdown.');
}

// --- 新增分布式服务器相关函数 ---

function setPluginManager(pm) {
    pluginManager = pm;
    if (serverConfig.debugMode) console.log('[WebSocketServer] PluginManager instance has been set.');
}

function handleDistributedServerMessage(serverId, message) {
    if (!pluginManager) {
        console.error('[WebSocketServer] PluginManager not set, cannot handle distributed server message.');
        return;
    }
    writeLog(`Received message from Distributed Server ${serverId}: ${JSON.stringify(message).substring(0, 200)}...`);
    switch (message.type) {
        case 'register_tools':
            const serverEntry = distributedServers.get(serverId);
            if (serverEntry && message.data && Array.isArray(message.data.tools)) {
                // 过滤掉内部工具，不让它们显示在插件列表中
                const externalTools = message.data.tools.filter(t => t.name !== 'internal_request_file');
                pluginManager.registerDistributedTools(serverId, externalTools);
                serverEntry.tools = externalTools.map(t => t.name);
                distributedServers.set(serverId, serverEntry);
                writeLog(`Registered ${externalTools.length} external tools from server ${serverId}.`);
            }
            break;
       case 'report_ip':
           const serverInfo = distributedServers.get(serverId);
           if (serverInfo && message.data) {
               const ipData = {
                   localIPs: message.data.localIPs || [],
                   publicIP: message.data.publicIP || null,
                   serverName: message.data.serverName || serverId
               };
               distributedServerIPs.set(serverId, ipData);

               // 将 serverName 也存储在主连接对象中，以便通过名字查找
               serverInfo.serverName = ipData.serverName;
               distributedServers.set(serverId, serverInfo);

               // 强制日志记录，无论debug模式如何
               console.log(`[IP Tracker] Received IP report from Distributed Server '${ipData.serverName}': Local IPs: [${ipData.localIPs.join(', ')}], Public IP: [${ipData.publicIP || 'N/A'}]`);
           }
           break;
        case 'tool_result':
            const pending = pendingToolRequests.get(message.data.requestId);
            if (pending) {
                clearTimeout(pending.timeout);
                if (message.data.status === 'success') {
                    pending.resolve(message.data.result);
                } else {
                    pending.reject(new Error(message.data.error || 'Distributed tool execution failed.'));
                }
                pendingToolRequests.delete(message.data.requestId);
            }
            break;
        default:
            writeLog(`Unknown message type '${message.type}' from server ${serverId}.`);
    }
}

// --- 新增Chrome命令发送函数 ---
async function sendCommandToChrome(commandData, timeout = 10000) {
    const observerClient = Array.from(chromeObserverClients.values())[0]; // 假设只有一个Observer
    if (!observerClient || observerClient.readyState !== WebSocket.OPEN) {
        throw new Error('Chrome extension is not connected.');
    }

    const requestId = commandData.requestId || generateClientId();
    commandData.requestId = requestId; // 确保命令中有requestId

    const payload = {
        type: 'command',
        data: commandData
    };

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            pendingChromeCommands.delete(requestId);
            reject(new Error(`Command request to Chrome timed out after ${timeout / 1000}s.`));
        }, timeout);

        pendingChromeCommands.set(requestId, { resolve, reject, timeout: timeoutId });

        observerClient.send(JSON.stringify(payload));
        writeLog(`Sent command request ${requestId} to Chrome client ${observerClient.clientId}.`);
    });
}

async function executeDistributedTool(serverIdOrName, toolName, toolArgs, timeout) {
    // 优先从插件 manifest 获取超时设置
    const plugin = pluginManager.getPlugin(toolName);
    const defaultTimeout = plugin?.communication?.timeout || 60000;
    const effectiveTimeout = timeout ?? defaultTimeout;

    let server = distributedServers.get(serverIdOrName); // 优先尝试通过 ID 查找

    // 如果通过 ID 找不到，则遍历并尝试通过 name 查找
    if (!server) {
        for (const srv of distributedServers.values()) {
            if (srv.serverName === serverIdOrName) {
                server = srv;
                break;
            }
        }
    }

    if (!server || server.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Distributed server ${serverIdOrName} is not connected or ready.`);
    }

    const requestId = generateClientId();
    const payload = {
        type: 'execute_tool',
        data: {
            requestId,
            toolName,
            toolArgs
        }
    };

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            pendingToolRequests.delete(requestId);
            reject(new Error(`Request to distributed tool ${toolName} on server ${serverIdOrName} timed out after ${effectiveTimeout / 1000}s.`));
        }, effectiveTimeout);

        pendingToolRequests.set(requestId, { resolve, reject, timeout: timeoutId });

        server.ws.send(JSON.stringify(payload));
        writeLog(`Sent tool execution request ${requestId} for ${toolName} to server ${serverIdOrName}.`);
    });
}

function findServerByIp(ip) {
   for (const [serverId, ipInfo] of distributedServerIPs.entries()) {
       if (ipInfo.publicIP === ip || (ipInfo.localIPs && ipInfo.localIPs.includes(ip))) {
           return ipInfo.serverName || serverId;
       }
   }
   return null;
}

module.exports = {
    initialize,
    setPluginManager,
    broadcast,
    sendMessageToClient,
    sendCommandToChrome, // 导出新函数
    executeDistributedTool,
    findServerByIp,
    shutdown
};
