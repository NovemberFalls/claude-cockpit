/**
 * Claude Cockpit — Main Application
 * Vanilla JS, no framework. Multi-pane session management with WebSocket.
 */

/* ═══════════════════════════════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════════════════════════════ */

const state = {
    sessions: [],           // {id, name, claudeSessionId, model, messages[], ws, usage{input,output,cost}, state:'idle'|'running'|'error', attachedFiles[]}
    activeLayout: 1,        // 1, 2, or 4
    panes: [null],          // array of session IDs assigned to each pane (null = empty)
    activePaneIndex: 0,
    sidebarVisible: true,
    nextSessionNum: 1,
};

/* ═══════════════════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════════════════ */

async function init() {
    // 1. Fetch user info
    try {
        const res = await fetch('/api/me');
        const user = await res.json();
        if (user.authenticated) {
            const info = document.getElementById('user-info');
            if (user.picture) {
                info.innerHTML = `<img class="user-avatar" src="${escapeAttr(user.picture)}" alt=""> ${escapeHtml(user.name || user.email)}`;
            } else {
                info.textContent = user.name || user.email;
            }
        }
    } catch (err) {
        console.warn('[cockpit] Failed to fetch user info:', err);
    }

    // 2. Populate theme picker
    const picker = document.getElementById('theme-picker');
    if (window.CockpitThemes) {
        const themes = CockpitThemes.listThemes();
        let lastGroup = '';
        let optgroup = null;
        for (const t of themes) {
            if (t.group !== lastGroup) {
                optgroup = document.createElement('optgroup');
                optgroup.label = t.group === 'dark' ? 'Dark' : 'Light';
                picker.appendChild(optgroup);
                lastGroup = t.group;
            }
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.label + (t.group === 'light' ? ' (Light)' : '');
            (optgroup || picker).appendChild(opt);
        }
        // Restore saved theme
        const saved = CockpitThemes.getSavedTheme() || 'tokyo-night-dark';
        picker.value = saved;
        CockpitThemes.applyTheme(saved);
    }

    // 3. Init hexgrid
    if (window.HexGrid && typeof HexGrid.init === 'function') {
        HexGrid.init('hex-bg');
    }

    // 4. Create initial session
    createSession();

    // 5. Set up event listeners
    setupEventListeners();
}

/* ═══════════════════════════════════════════════════════════════════
   SESSION MANAGEMENT
   ═══════════════════════════════════════════════════════════════════ */

function createSession(name) {
    const id = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const sessionName = name || ('Session ' + state.nextSessionNum);
    state.nextSessionNum++;

    const session = {
        id,
        name: sessionName,
        claudeSessionId: null,
        model: document.getElementById('model-select').value,
        messages: [],
        ws: null,
        usage: { input: 0, output: 0, cost: 0 },
        state: 'idle',
        attachedFiles: [],
    };

    state.sessions.push(session);
    connectSession(session);

    // Assign to active pane
    state.panes[state.activePaneIndex] = session.id;

    renderSidebar();
    renderPane(state.activePaneIndex);
    updateStatusBar();

    return session;
}

function deleteSession(id) {
    const session = state.sessions.find(s => s.id === id);
    if (!session) return;

    if (session.ws) {
        session.ws.close();
        session.ws = null;
    }

    state.sessions = state.sessions.filter(s => s.id !== id);

    // Clear from any panes
    for (let i = 0; i < state.panes.length; i++) {
        if (state.panes[i] === id) {
            state.panes[i] = null;
            renderPane(i);
        }
    }

    // If no sessions left, create a new one
    if (state.sessions.length === 0) {
        createSession();
        return;
    }

    renderSidebar();
    updateStatusBar();
}

function renameSession(id, name) {
    const session = state.sessions.find(s => s.id === id);
    if (!session) return;
    session.name = name;
    renderSidebar();
    // Update pane headers that show this session
    for (let i = 0; i < state.panes.length; i++) {
        if (state.panes[i] === id) {
            const titleEl = document.querySelector(`.pane[data-pane="${i}"] .pane-title`);
            if (titleEl) titleEl.textContent = name;
        }
    }
}

function getSessionForPane(paneIndex) {
    const id = state.panes[paneIndex];
    if (!id) return null;
    return state.sessions.find(s => s.id === id) || null;
}

/* ═══════════════════════════════════════════════════════════════════
   WEBSOCKET
   ═══════════════════════════════════════════════════════════════════ */

function connectSession(session) {
    if (session.ws && session.ws.readyState <= WebSocket.OPEN) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws/session`);
    session.ws = ws;

    ws.onopen = () => {
        session.state = 'idle';
        addMessage(session.id, 'system', 'Connected to Claude Cockpit server.');
        renderSidebar();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerMessage(session.id, data);
        } catch {
            addMessage(session.id, 'assistant', event.data);
        }
    };

    ws.onclose = () => {
        session.state = 'idle';
        session.ws = null;
        addMessage(session.id, 'system', 'Connection closed. Click to reconnect.');
        renderSidebar();
    };

    ws.onerror = () => {
        session.state = 'error';
        addMessage(session.id, 'system', 'Connection error.');
        renderSidebar();
    };
}

function handleServerMessage(sessionId, data) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    const type = data.type || '';

    switch (type) {
        case 'system':
            addMessage(sessionId, 'system', data.message || JSON.stringify(data));
            break;

        case 'assistant': {
            const content = data.message?.content || [];
            for (const block of content) {
                if (block.type === 'text') {
                    addMessage(sessionId, 'assistant', block.text);
                } else if (block.type === 'tool_use') {
                    addMessage(sessionId, 'tool', `Using tool: ${block.name}`);
                }
            }
            break;
        }

        case 'result': {
            const result = data.result || '';
            if (result) {
                addMessage(sessionId, 'assistant', result);
            }
            // Update usage
            const usage = data.usage || {};
            session.usage.input += usage.input_tokens || 0;
            session.usage.output += usage.output_tokens || 0;
            session.usage.cost += data.cost_usd || 0;

            // Add usage line
            const tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
            const cost = data.cost_usd || 0;
            addUsageLine(sessionId, tokens, cost);

            session.state = 'idle';
            updateSessionBusy(sessionId, false);
            updateStatusBar();
            renderSidebar();
            break;
        }

        case 'error':
            addMessage(sessionId, 'system', data.message || 'Unknown error');
            session.state = 'error';
            updateSessionBusy(sessionId, false);
            renderSidebar();
            break;

        case 'output':
            addMessage(sessionId, 'assistant', data.text || data.message || '');
            break;

        default:
            // Unknown message type — show raw
            if (data.message) {
                addMessage(sessionId, 'system', data.message);
            }
            break;
    }
}

/* ═══════════════════════════════════════════════════════════════════
   SENDING MESSAGES
   ═══════════════════════════════════════════════════════════════════ */

async function sendMessage(paneIndex) {
    const session = getSessionForPane(paneIndex);
    if (!session) return;

    const textarea = document.getElementById(`input-${paneIndex}`);
    if (!textarea) return;

    const text = textarea.value.trim();
    if (!text && session.attachedFiles.length === 0) return;

    // Check WebSocket connection
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
        addMessage(session.id, 'system', 'Not connected. Reconnecting...');
        connectSession(session);
        return;
    }

    // Add user message to chat
    if (text) {
        addMessage(session.id, 'user', text);
    }

    // Upload files if any
    let uploadedPaths = [];
    if (session.attachedFiles.length > 0) {
        try {
            uploadedPaths = await uploadFiles(session.attachedFiles);
            const fileNames = session.attachedFiles.map(f => f.name).join(', ');
            addMessage(session.id, 'system', `Attached: ${fileNames}`);
        } catch (err) {
            addMessage(session.id, 'system', `File upload failed: ${err.message}`);
            return;
        }
    }

    // Send via WebSocket
    const payload = {
        type: 'prompt',
        text: text,
        model: document.getElementById('model-select').value,
    };
    if (uploadedPaths.length > 0) {
        payload.files = uploadedPaths;
    }
    session.ws.send(JSON.stringify(payload));

    // Clear input and files
    textarea.value = '';
    autoResizeTextarea(textarea);
    session.attachedFiles = [];
    renderAttachedFiles(paneIndex);

    // Set busy state
    session.state = 'running';
    updateSessionBusy(session.id, true);
    renderSidebar();
}

async function uploadFiles(files) {
    const formData = new FormData();
    for (const file of files) {
        formData.append('files', file);
    }
    const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
    });
    if (!res.ok) {
        throw new Error(`Upload failed (${res.status})`);
    }
    const data = await res.json();
    return data.paths || [];
}

function cancelRequest(paneIndex) {
    const session = getSessionForPane(paneIndex);
    if (!session) return;

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify({ type: 'cancel' }));
    }
    session.state = 'idle';
    updateSessionBusy(session.id, false);
    renderSidebar();
}

function updateSessionBusy(sessionId, busy) {
    // Update send/cancel buttons for all panes showing this session
    for (let i = 0; i < state.panes.length; i++) {
        if (state.panes[i] !== sessionId) continue;
        const sendBtn = document.getElementById(`send-${i}`);
        const cancelBtn = document.getElementById(`cancel-${i}`);
        const statusEl = document.getElementById('stat-status');

        if (sendBtn) sendBtn.style.display = busy ? 'none' : '';
        if (cancelBtn) cancelBtn.style.display = busy ? '' : 'none';
        if (statusEl) statusEl.innerHTML = busy
            ? '<span class="stat-running">Thinking...</span>'
            : 'Ready';
    }
}

/* ═══════════════════════════════════════════════════════════════════
   FILE HANDLING
   ═══════════════════════════════════════════════════════════════════ */

function handleFileDrop(paneIndex, event) {
    event.preventDefault();
    event.stopPropagation();

    const dropZone = document.getElementById(`drop-${paneIndex}`);
    if (dropZone) dropZone.classList.remove('drag-over');

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    for (const file of files) {
        addAttachedFile(paneIndex, file);
    }
}

function handleFileSelect(paneIndex, input) {
    if (!input.files || input.files.length === 0) return;
    for (const file of input.files) {
        addAttachedFile(paneIndex, file);
    }
    input.value = '';
}

function addAttachedFile(paneIndex, file) {
    const session = getSessionForPane(paneIndex);
    if (!session) return;
    session.attachedFiles.push(file);
    renderAttachedFiles(paneIndex);
}

function removeAttachedFile(paneIndex, index) {
    const session = getSessionForPane(paneIndex);
    if (!session) return;
    session.attachedFiles.splice(index, 1);
    renderAttachedFiles(paneIndex);
}

function renderAttachedFiles(paneIndex) {
    const container = document.getElementById(`files-${paneIndex}`);
    if (!container) return;

    const session = getSessionForPane(paneIndex);
    if (!session || session.attachedFiles.length === 0) {
        container.innerHTML = '';
        container.style.display = 'none';
        return;
    }

    container.style.display = 'flex';
    container.innerHTML = '';

    session.attachedFiles.forEach((file, idx) => {
        const chip = document.createElement('div');
        chip.className = 'file-chip';

        if (file.type && file.type.startsWith('image/')) {
            const thumb = document.createElement('img');
            thumb.className = 'file-thumb';
            const url = URL.createObjectURL(file);
            thumb.src = url;
            thumb.onload = () => URL.revokeObjectURL(url);
            chip.appendChild(thumb);
        } else {
            const icon = document.createElement('span');
            icon.className = 'file-icon';
            icon.textContent = getFileIcon(file.name);
            chip.appendChild(icon);
        }

        const nameEl = document.createElement('span');
        nameEl.className = 'file-name';
        nameEl.textContent = truncateFilename(file.name, 20);
        nameEl.title = file.name;
        chip.appendChild(nameEl);

        const removeBtn = document.createElement('span');
        removeBtn.className = 'file-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.dataset.pane = paneIndex;
        removeBtn.dataset.fileIndex = idx;
        chip.appendChild(removeBtn);

        container.appendChild(chip);
    });
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const icons = {
        pdf: '\ud83d\udcc4', doc: '\ud83d\udcc4', docx: '\ud83d\udcc4',
        txt: '\ud83d\udcc3', md: '\ud83d\udcc3', csv: '\ud83d\udcca',
        xls: '\ud83d\udcca', xlsx: '\ud83d\udcca',
        js: '\ud83d\udcdc', py: '\ud83d\udcdc', rs: '\ud83d\udcdc', ts: '\ud83d\udcdc',
        json: '\ud83d\udcdc', html: '\ud83d\udcdc', css: '\ud83d\udcdc',
        zip: '\ud83d\udce6', tar: '\ud83d\udce6', gz: '\ud83d\udce6',
    };
    return icons[ext] || '\ud83d\udcc1';
}

function truncateFilename(name, maxLen) {
    if (name.length <= maxLen) return name;
    const ext = name.includes('.') ? '.' + name.split('.').pop() : '';
    const base = name.slice(0, maxLen - ext.length - 3);
    return base + '...' + ext;
}

/* ═══════════════════════════════════════════════════════════════════
   LAYOUT MANAGEMENT
   ═══════════════════════════════════════════════════════════════════ */

function setLayout(n) {
    if (![1, 2, 4].includes(n)) return;

    state.activeLayout = n;

    // Adjust panes array length
    while (state.panes.length < n) {
        state.panes.push(null);
    }
    state.panes.length = n;

    // Ensure active pane index is valid
    if (state.activePaneIndex >= n) {
        state.activePaneIndex = 0;
    }

    // Update CSS class on container
    const container = document.getElementById('pane-container');
    container.className = 'pane-container layout-' + n;

    // Update layout buttons
    document.querySelectorAll('.layout-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.layout) === n);
    });

    // Render all panes
    renderAllPanes();
}

function renderAllPanes() {
    const container = document.getElementById('pane-container');
    container.innerHTML = '';

    for (let i = 0; i < state.activeLayout; i++) {
        renderPane(i);
    }
}

/* ═══════════════════════════════════════════════════════════════════
   PANE RENDERING
   ═══════════════════════════════════════════════════════════════════ */

function renderPane(paneIndex) {
    const container = document.getElementById('pane-container');
    const session = getSessionForPane(paneIndex);

    // Find or create pane element
    let pane = container.querySelector(`.pane[data-pane="${paneIndex}"]`);
    if (!pane) {
        pane = document.createElement('div');
        pane.className = 'pane';
        pane.dataset.pane = paneIndex;
        container.appendChild(pane);
    }

    // Mark active pane
    container.querySelectorAll('.pane').forEach((p, i) => {
        p.classList.toggle('pane-active', parseInt(p.dataset.pane) === state.activePaneIndex);
    });

    const sessionName = session ? escapeHtml(session.name) : 'Empty';
    const modelName = session ? session.model : '';
    const isBusy = session && session.state === 'running';

    pane.innerHTML = `
        <div class="pane-header">
            <span class="pane-title">${sessionName}</span>
            ${modelName ? `<span class="pane-model">${escapeHtml(modelName)}</span>` : ''}
        </div>
        <div class="pane-chat" id="chat-${paneIndex}"></div>
        <div class="pane-input">
            <div class="file-drop-zone" id="drop-${paneIndex}">Drop files here</div>
            <div class="attached-files" id="files-${paneIndex}" style="display:none"></div>
            <div class="input-row">
                <button class="attach-btn" data-pane="${paneIndex}" title="Attach file">\ud83d\udcce</button>
                <input type="file" class="file-input" id="file-input-${paneIndex}" multiple hidden>
                <textarea id="input-${paneIndex}" placeholder="Message Claude..." rows="1"${session ? '' : ' disabled'}></textarea>
                <button class="btn btn-primary send-btn" id="send-${paneIndex}"${session ? '' : ' disabled'} style="${isBusy ? 'display:none' : ''}">Send</button>
                <button class="btn cancel-btn" id="cancel-${paneIndex}" style="${isBusy ? '' : 'display:none'}">Cancel</button>
            </div>
        </div>
    `;

    // Render messages if session exists
    if (session) {
        renderMessages(paneIndex);
        renderAttachedFiles(paneIndex);
    }
}

/* ═══════════════════════════════════════════════════════════════════
   MESSAGE RENDERING
   ═══════════════════════════════════════════════════════════════════ */

function addMessage(sessionId, role, text) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    session.messages.push({ role, text, time: new Date() });

    // Re-render any pane showing this session
    for (let i = 0; i < state.panes.length; i++) {
        if (state.panes[i] === sessionId) {
            renderMessages(i);
        }
    }
}

function addUsageLine(sessionId, tokens, cost) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    session.messages.push({ role: 'usage', tokens, cost, time: new Date() });

    for (let i = 0; i < state.panes.length; i++) {
        if (state.panes[i] === sessionId) {
            renderMessages(i);
        }
    }
}

function renderMessages(paneIndex) {
    const chatEl = document.getElementById(`chat-${paneIndex}`);
    if (!chatEl) return;

    const session = getSessionForPane(paneIndex);
    if (!session) {
        chatEl.innerHTML = '<div class="empty-state">No session assigned</div>';
        return;
    }

    chatEl.innerHTML = '';

    for (const msg of session.messages) {
        if (msg.role === 'usage') {
            const div = document.createElement('div');
            div.className = 'usage-line';
            div.textContent = `\u2500\u2500 tokens: ${formatTokens(msg.tokens)} \u00b7 cost: $${msg.cost.toFixed(4)} \u2500\u2500`;
            chatEl.appendChild(div);
        } else if (msg.role === 'tool') {
            const div = document.createElement('div');
            div.className = 'tool-use';
            div.textContent = msg.text;
            chatEl.appendChild(div);
        } else {
            const div = document.createElement('div');
            div.className = `message ${msg.role}`;

            const label = msg.role === 'user' ? 'You'
                : msg.role === 'assistant' ? 'Claude'
                : 'System';

            const timestamp = msg.time ? formatTimestamp(msg.time) : '';

            div.innerHTML = `
                <div class="msg-header">
                    <span>${label}</span>
                    ${timestamp ? `<span class="msg-time">${timestamp}</span>` : ''}
                </div>
                <div class="msg-body">${escapeHtml(msg.text)}</div>
            `;
            chatEl.appendChild(div);
        }
    }

    // Auto-scroll to bottom
    chatEl.scrollTop = chatEl.scrollHeight;
}

/* ═══════════════════════════════════════════════════════════════════
   SIDEBAR RENDERING
   ═══════════════════════════════════════════════════════════════════ */

function renderSidebar() {
    const list = document.getElementById('session-list');
    if (!list) return;

    list.innerHTML = '';

    for (const session of state.sessions) {
        const item = document.createElement('div');
        const isActive = state.panes.includes(session.id);
        item.className = 'session-item' + (isActive ? ' active' : '');
        item.dataset.sessionId = session.id;

        // Status dot color
        let dotClass = 'dot-idle';
        if (session.state === 'running') dotClass = 'dot-running';
        else if (session.state === 'error') dotClass = 'dot-error';
        else if (!session.ws || session.ws.readyState !== WebSocket.OPEN) dotClass = 'dot-disconnected';

        const tokenCount = session.usage.input + session.usage.output;

        item.innerHTML = `
            <span class="session-dot ${dotClass}"></span>
            <span class="session-name" title="Double-click to rename">${escapeHtml(session.name)}</span>
            <span class="session-model">${escapeHtml(session.model)}</span>
            ${tokenCount > 0 ? `<span class="session-tokens">${formatTokens(tokenCount)}</span>` : ''}
        `;

        list.appendChild(item);
    }

    // Update session count in status bar
    const countEl = document.getElementById('stat-sessions');
    if (countEl) countEl.textContent = state.sessions.length;
}

/* ═══════════════════════════════════════════════════════════════════
   STATUS BAR
   ═══════════════════════════════════════════════════════════════════ */

function updateStatusBar() {
    let totalTokens = 0;
    let totalCost = 0;

    for (const session of state.sessions) {
        totalTokens += session.usage.input + session.usage.output;
        totalCost += session.usage.cost;
    }

    const tokensEl = document.getElementById('stat-tokens');
    const costEl = document.getElementById('stat-cost');
    const sessionsEl = document.getElementById('stat-sessions');

    if (tokensEl) tokensEl.textContent = formatTokens(totalTokens);
    if (costEl) costEl.textContent = '$' + totalCost.toFixed(4);
    if (sessionsEl) sessionsEl.textContent = state.sessions.length;
}

/* ═══════════════════════════════════════════════════════════════════
   THEME INTEGRATION
   ═══════════════════════════════════════════════════════════════════ */

function applySelectedTheme() {
    const picker = document.getElementById('theme-picker');
    if (!picker || !window.CockpitThemes) return;

    const themeId = picker.value;
    CockpitThemes.applyTheme(themeId);

    // HexGrid colors are updated automatically by applyTheme if HexGrid exists
}

/* ═══════════════════════════════════════════════════════════════════
   TEXTAREA AUTO-RESIZE
   ═══════════════════════════════════════════════════════════════════ */

function autoResizeTextarea(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
}

/* ═══════════════════════════════════════════════════════════════════
   CONTEXT MENU
   ═══════════════════════════════════════════════════════════════════ */

let contextMenuEl = null;

function showContextMenu(x, y, sessionId) {
    hideContextMenu();

    contextMenuEl = document.createElement('div');
    contextMenuEl.className = 'context-menu';
    contextMenuEl.innerHTML = `
        <div class="context-item" data-action="rename">Rename</div>
        <div class="context-item" data-action="reconnect">Reconnect</div>
        <div class="context-divider"></div>
        <div class="context-item context-danger" data-action="delete">Delete</div>
    `;

    contextMenuEl.style.left = x + 'px';
    contextMenuEl.style.top = y + 'px';
    document.body.appendChild(contextMenuEl);

    contextMenuEl.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (!action) return;

        if (action === 'rename') {
            promptRename(sessionId);
        } else if (action === 'reconnect') {
            const session = state.sessions.find(s => s.id === sessionId);
            if (session) connectSession(session);
        } else if (action === 'delete') {
            deleteSession(sessionId);
        }

        hideContextMenu();
    });

    // Close on next click outside
    setTimeout(() => {
        document.addEventListener('click', hideContextMenu, { once: true });
    }, 0);
}

function hideContextMenu() {
    if (contextMenuEl) {
        contextMenuEl.remove();
        contextMenuEl = null;
    }
}

function promptRename(sessionId) {
    const session = state.sessions.find(s => s.id === sessionId);
    if (!session) return;

    const nameEl = document.querySelector(`.session-item[data-session-id="${sessionId}"] .session-name`);
    if (!nameEl) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'rename-input';
    input.value = session.name;

    nameEl.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
        const newName = input.value.trim() || session.name;
        renameSession(sessionId, newName);
    };

    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = session.name; input.blur(); }
    });
}

/* ═══════════════════════════════════════════════════════════════════
   EVENT LISTENERS
   ═══════════════════════════════════════════════════════════════════ */

function setupEventListeners() {
    // Theme picker
    document.getElementById('theme-picker').addEventListener('change', applySelectedTheme);

    // Model select — update active session model
    document.getElementById('model-select').addEventListener('change', (e) => {
        const session = getSessionForPane(state.activePaneIndex);
        if (session) {
            session.model = e.target.value;
            renderSidebar();
            // Update pane header model badge
            const modelEl = document.querySelector(`.pane[data-pane="${state.activePaneIndex}"] .pane-model`);
            if (modelEl) modelEl.textContent = e.target.value;
        }
    });

    // Sidebar toggle
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        state.sidebarVisible = !state.sidebarVisible;
        document.getElementById('sidebar').classList.toggle('collapsed', !state.sidebarVisible);
    });

    // New session button
    document.getElementById('new-session-btn').addEventListener('click', () => {
        createSession();
    });

    // Layout control buttons
    document.getElementById('layout-controls').addEventListener('click', (e) => {
        const btn = e.target.closest('.layout-btn');
        if (!btn) return;
        const n = parseInt(btn.dataset.layout);
        if (n) setLayout(n);
    });

    // ── Delegated events on pane-container ──

    const paneContainer = document.getElementById('pane-container');

    // Click on pane to make active
    paneContainer.addEventListener('mousedown', (e) => {
        const pane = e.target.closest('.pane');
        if (!pane) return;
        const idx = parseInt(pane.dataset.pane);
        if (!isNaN(idx) && idx !== state.activePaneIndex) {
            state.activePaneIndex = idx;
            paneContainer.querySelectorAll('.pane').forEach(p => {
                p.classList.toggle('pane-active', parseInt(p.dataset.pane) === idx);
            });
            // Sync model selector with active pane's session
            const session = getSessionForPane(idx);
            if (session) {
                document.getElementById('model-select').value = session.model;
            }
        }
    });

    // Send button click (delegated)
    paneContainer.addEventListener('click', (e) => {
        // Send button
        const sendBtn = e.target.closest('.send-btn');
        if (sendBtn) {
            const pane = sendBtn.closest('.pane');
            if (pane) sendMessage(parseInt(pane.dataset.pane));
            return;
        }

        // Cancel button
        const cancelBtn = e.target.closest('.cancel-btn');
        if (cancelBtn) {
            const pane = cancelBtn.closest('.pane');
            if (pane) cancelRequest(parseInt(pane.dataset.pane));
            return;
        }

        // Attach button
        const attachBtn = e.target.closest('.attach-btn');
        if (attachBtn) {
            const pi = parseInt(attachBtn.dataset.pane);
            const fileInput = document.getElementById(`file-input-${pi}`);
            if (fileInput) fileInput.click();
            return;
        }

        // File remove button
        const removeBtn = e.target.closest('.file-remove');
        if (removeBtn) {
            const pi = parseInt(removeBtn.dataset.pane);
            const fi = parseInt(removeBtn.dataset.fileIndex);
            if (!isNaN(pi) && !isNaN(fi)) removeAttachedFile(pi, fi);
            return;
        }
    });

    // File input change (delegated)
    paneContainer.addEventListener('change', (e) => {
        if (e.target.matches('.file-input')) {
            const pane = e.target.closest('.pane');
            if (pane) handleFileSelect(parseInt(pane.dataset.pane), e.target);
        }
    });

    // Textarea keydown (delegated)
    paneContainer.addEventListener('keydown', (e) => {
        if (!e.target.matches('textarea')) return;

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const pane = e.target.closest('.pane');
            if (pane) sendMessage(parseInt(pane.dataset.pane));
        }
    });

    // Textarea auto-resize (delegated)
    paneContainer.addEventListener('input', (e) => {
        if (e.target.matches('textarea')) {
            autoResizeTextarea(e.target);
        }
    });

    // Drag and drop on panes (delegated)
    paneContainer.addEventListener('dragover', (e) => {
        const dropZone = e.target.closest('.file-drop-zone');
        if (dropZone) {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        }
    });

    paneContainer.addEventListener('dragleave', (e) => {
        const dropZone = e.target.closest('.file-drop-zone');
        if (dropZone) {
            dropZone.classList.remove('drag-over');
        }
    });

    paneContainer.addEventListener('drop', (e) => {
        const dropZone = e.target.closest('.file-drop-zone');
        if (dropZone) {
            const pane = dropZone.closest('.pane');
            if (pane) handleFileDrop(parseInt(pane.dataset.pane), e);
        }
    });

    // ── Sidebar events (delegated) ──

    const sessionList = document.getElementById('session-list');

    // Click session to assign to active pane
    sessionList.addEventListener('click', (e) => {
        const item = e.target.closest('.session-item');
        if (!item) return;

        const sessionId = item.dataset.sessionId;
        state.panes[state.activePaneIndex] = sessionId;

        // Sync model select
        const session = state.sessions.find(s => s.id === sessionId);
        if (session) {
            document.getElementById('model-select').value = session.model;
        }

        renderPane(state.activePaneIndex);
        renderSidebar();
    });

    // Double-click to rename
    sessionList.addEventListener('dblclick', (e) => {
        const item = e.target.closest('.session-item');
        if (!item) return;
        promptRename(item.dataset.sessionId);
    });

    // Right-click context menu
    sessionList.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.session-item');
        if (!item) return;
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, item.dataset.sessionId);
    });

    // ── Global keyboard shortcuts ──

    document.addEventListener('keydown', (e) => {
        // Ctrl+N — New session
        if (e.ctrlKey && e.key === 'n') {
            e.preventDefault();
            createSession();
            return;
        }

        // Ctrl+B — Toggle sidebar
        if (e.ctrlKey && e.key === 'b') {
            e.preventDefault();
            state.sidebarVisible = !state.sidebarVisible;
            document.getElementById('sidebar').classList.toggle('collapsed', !state.sidebarVisible);
            return;
        }

        // Ctrl+K — Cancel current request
        if (e.ctrlKey && e.key === 'k') {
            e.preventDefault();
            cancelRequest(state.activePaneIndex);
            return;
        }

        // Ctrl+1/2/3/4 — Switch layout or pane focus
        if (e.ctrlKey && e.key >= '1' && e.key <= '4') {
            e.preventDefault();
            const n = parseInt(e.key);

            if (n <= state.activeLayout) {
                // Switch pane focus
                state.activePaneIndex = n - 1;
                document.querySelectorAll('.pane').forEach(p => {
                    p.classList.toggle('pane-active', parseInt(p.dataset.pane) === state.activePaneIndex);
                });
                // Focus the textarea
                const textarea = document.getElementById(`input-${state.activePaneIndex}`);
                if (textarea) textarea.focus();
                // Sync model select
                const session = getSessionForPane(state.activePaneIndex);
                if (session) {
                    document.getElementById('model-select').value = session.model;
                }
            } else {
                // Switch to that layout
                setLayout(n <= 2 ? n : 4);
            }
            return;
        }
    });

    // ── Window resize ──

    window.addEventListener('resize', () => {
        if (window.HexGrid && typeof HexGrid.resize === 'function') {
            HexGrid.resize();
        }
    });
}

/* ═══════════════════════════════════════════════════════════════════
   UTILITY FUNCTIONS
   ═══════════════════════════════════════════════════════════════════ */

function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return n.toString();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatTimestamp(date) {
    if (!(date instanceof Date)) date = new Date(date);
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
}

/* ═══════════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', init);
