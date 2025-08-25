console.log('VCPChrome background.js loaded.');
let ws = null;
let isConnected = false;
const defaultServerUrl = 'ws://localhost:8088'; // 默认服务器地址
const defaultVcpKey = 'your_secret_key'; // 默认密钥

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('WebSocket is already connected.');
        return;
    }

    // 从storage获取URL和Key
    chrome.storage.local.get(['serverUrl', 'vcpKey'], (result) => {
        const serverUrlToUse = result.serverUrl || defaultServerUrl;
        const keyToUse = result.vcpKey || defaultVcpKey;

        const fullUrl = `${serverUrlToUse}/vcp-chrome-observer/VCP_Key=${keyToUse}`;
        console.log('Connecting to:', fullUrl);

        ws = new WebSocket(fullUrl);

        ws.onopen = () => {
            console.log('WebSocket connection established.');
            isConnected = true;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
        };

        ws.onmessage = (event) => {
            console.log('Message from server:', event.data);
            const message = JSON.parse(event.data);

            // 处理来自服务器的指令
            if (message.type === 'command') {
                const commandData = message.data;
                console.log('Received commandData:', commandData);
                // 检查是否是 open_url 指令
                if (commandData.command === 'open_url' && commandData.url) {
                    handleOpenUrl(commandData);
                } else if (commandData.command === 'get_tabs') {
                    handleGetTabs(commandData);
                } else if (commandData.command === 'close_tabs') {
                    handleCloseTabs(commandData);
                } else if (commandData.command === 'navigate_tab') {
                    handleNavigateTab(commandData);
                } else if (commandData.command === 'take_screenshot') {
                    handleTakeScreenshot(commandData);
                } else if (commandData.command === 'search_history') {
                    handleSearchHistory(commandData);
                } else if (commandData.command === 'search_bookmarks') {
                    handleSearchBookmarks(commandData);
                } else if (commandData.command === 'add_bookmark') {
                    handleAddBookmark(commandData);
                } else {
                    console.log('Forwarding command to content script:', commandData);
                    forwardCommandToContentScript(commandData);
                }
            }
        };

        ws.onclose = () => {
            console.log('WebSocket connection closed.');
            isConnected = false;
            ws = null;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            isConnected = false;
            ws = null;
            updateIcon();
            broadcastStatusUpdate(); // 广播最新状态
        };
    });
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

function updateIcon() {
    const iconPath = isConnected ? 'icons/icon48.png' : 'icons/icon_disconnected.png'; // 你需要创建一个断开连接的图标
    // 为了简单起见，我们先只改变徽章
    chrome.action.setBadgeText({ text: isConnected ? 'On' : 'Off' });
    chrome.action.setBadgeBackgroundColor({ color: isConnected ? '#00C853' : '#FF5252' });
}

// 封装发送响应的函数
function sendResponseToVCP(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'command_result', data }));
    } else {
        console.error("WebSocket is not connected. Cannot send response to VCP.");
    }
}

// 封装不同命令的处理逻辑
function handleOpenUrl(commandData) {
    console.log('Handling open_url command. URL:', commandData.url);
    let fullUrl = commandData.url;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) {
        fullUrl = 'https://' + fullUrl;
    }
    chrome.tabs.create({ url: fullUrl }, (tab) => {
        if (chrome.runtime.lastError) {
            const errorMessage = `创建标签页失败: ${chrome.runtime.lastError.message}`;
            console.error('Error creating tab:', errorMessage);
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: errorMessage
            });
        } else {
            console.log('Tab created successfully. Tab ID:', tab.id, 'URL:', tab.url);
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: `成功打开URL: ${commandData.url}`
            });
        }
    });
}

function handleSearchHistory(commandData) {
    const { text, startTime, endTime, maxResults = 100 } = commandData;
    const query = {
        text: text || '',
        startTime: startTime ? parseInt(startTime) : undefined,
        endTime: endTime ? parseInt(endTime) : undefined,
        maxResults: maxResults
    };
    chrome.history.search(query, (results) => {
        if (chrome.runtime.lastError) {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: chrome.runtime.lastError.message
            });
        } else {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: JSON.stringify(results, null, 2)
            });
        }
    });
}

function handleSearchBookmarks(commandData) {
    const { query } = commandData;
    chrome.bookmarks.search(query || '', (results) => {
        if (chrome.runtime.lastError) {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: chrome.runtime.lastError.message
            });
        } else {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: JSON.stringify(results, null, 2)
            });
        }
    });
}

function handleAddBookmark(commandData) {
    const { url, title } = commandData;
    if (!url) {
        return sendResponseToVCP({
            requestId: commandData.requestId,
            sourceClientId: commandData.sourceClientId,
            status: 'error',
            error: 'URL is required to add a bookmark.'
        });
    }
    chrome.bookmarks.create({ url, title: title || '' }, (bookmark) => {
        if (chrome.runtime.lastError) {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: chrome.runtime.lastError.message
            });
        } else {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: `Successfully added bookmark: ${JSON.stringify(bookmark, null, 2)}`
            });
        }
    });
}

function handleTakeScreenshot(commandData) {
    chrome.tabs.captureVisibleTab(null, { format: 'png' }, (dataUrl) => {
        if (chrome.runtime.lastError) {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: chrome.runtime.lastError.message
            });
        } else {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: 'Screenshot taken successfully.',
                result: dataUrl // 将截图的data URL放在result字段
            });
        }
    });
}

function handleGetTabs(commandData) {
    chrome.tabs.query({}, (tabs) => {
        const tabInfo = tabs.map(tab => ({
            id: tab.id,
            windowId: tab.windowId,
            title: tab.title,
            url: tab.url,
            active: tab.active,
            status: tab.status
        }));
        sendResponseToVCP({
            requestId: commandData.requestId,
            sourceClientId: commandData.sourceClientId,
            status: 'success',
            message: JSON.stringify(tabInfo, null, 2)
        });
    });
}

function handleCloseTabs(commandData) {
    const tabIds = commandData.tab_ids;
    if (!Array.isArray(tabIds) || tabIds.length === 0) {
        return sendResponseToVCP({
            requestId: commandData.requestId,
            sourceClientId: commandData.sourceClientId,
            status: 'error',
            error: 'tab_ids must be a non-empty array.'
        });
    }
    chrome.tabs.remove(tabIds, () => {
        if (chrome.runtime.lastError) {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: chrome.runtime.lastError.message
            });
        } else {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: `Successfully closed tabs: ${tabIds.join(', ')}`
            });
        }
    });
}

function handleNavigateTab(commandData) {
    const { tab_id, url } = commandData;
    if (typeof tab_id !== 'number' || !url) {
        return sendResponseToVCP({
            requestId: commandData.requestId,
            sourceClientId: commandData.sourceClientId,
            status: 'error',
            error: 'tab_id (number) and url (string) are required.'
        });
    }
    chrome.tabs.update(tab_id, { url: url }, (tab) => {
        if (chrome.runtime.lastError) {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'error',
                error: chrome.runtime.lastError.message
            });
        } else {
            sendResponseToVCP({
                requestId: commandData.requestId,
                sourceClientId: commandData.sourceClientId,
                status: 'success',
                message: `Successfully navigated tab ${tab_id} to ${url}`
            });
        }
    });
}

// 监听来自popup和content_script的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'GET_STATUS') {
        sendResponse({ isConnected: isConnected });
    } else if (request.type === 'TOGGLE_CONNECTION') {
        if (isConnected) {
            disconnect();
        } else {
            connect();
        }
        // 不再立即返回状态，而是等待广播
        // sendResponse({ isConnected: !isConnected });
    } else if (request.type === 'PAGE_INFO_UPDATE') {
        // 从content_script接收到页面信息，发送到服务器
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'pageInfoUpdate',
                data: { markdown: request.data.markdown }
            }));
        }
    } else if (request.type === 'COMMAND_RESULT') {
        // 从content_script接收到命令执行结果，发送到服务器
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'command_result',
                data: request.data
            }));
        }
    }
    return true; // 保持消息通道开放以进行异步响应
});

function forwardCommandToContentScript(commandData) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.tabs.sendMessage(tabs[0].id, {
                type: 'EXECUTE_COMMAND',
                data: commandData
            });
        }
    });
}

function broadcastStatusUpdate() {
    chrome.runtime.sendMessage({
        type: 'STATUS_UPDATE',
        isConnected: isConnected
    }).catch(error => {
        // 捕获当popup未打开时发送消息产生的错误，这是正常现象
        if (error.message.includes("Could not establish connection. Receiving end does not exist.")) {
            // This is expected if the popup is not open.
        } else {
            console.error("Error broadcasting status:", error);
        }
    });
}

// 监听标签页切换
chrome.tabs.onActivated.addListener((activeInfo) => {
    // 请求新激活的标签页更新信息
    chrome.tabs.sendMessage(activeInfo.tabId, { type: 'REQUEST_PAGE_INFO_UPDATE' }).catch(e => {
        if (!e.message.includes("Could not establish connection")) console.log("Error sending to content script on tab activation:", e.message);
    });
});

// 监听标签页URL变化或加载状态变化
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 当导航开始时，清除内容脚本的状态以防止内容累积
    if (changeInfo.status === 'loading') {
        chrome.tabs.sendMessage(tabId, { type: 'CLEAR_STATE' }).catch(e => {
            // This error is expected if the content script hasn't been injected yet
            if (!e.message.includes("Could not establish connection")) console.log("Error sending CLEAR_STATE:", e.message);
        });
    }
    // 当页面加载完成时，或者URL变化后加载完成时，请求更新
    if (changeInfo.status === 'complete' && tab.active) {
        chrome.tabs.sendMessage(tabId, { type: 'REQUEST_PAGE_INFO_UPDATE' }).catch(e => {
            if (!e.message.includes("Could not establish connection")) console.log("Error sending to content script on tab update:", e.message);
        });
    }
});

// 初始化图标状态
updateIcon();
