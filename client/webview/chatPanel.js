(function() {
    const vscode = acquireVsCodeApi();
    const chatArea = document.getElementById('chatArea');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('sendBtn');
    const emptyState = document.getElementById('emptyState');
    const topicsPanel = document.getElementById('topicsPanel');
    const settingsPage = document.getElementById('settingsPage');
    const chatHeader = document.querySelector('.header');
    const inputWrapper = document.querySelector('.input-wrapper');
    const planIndicator = document.getElementById('planIndicator');
    const todoPanel = document.getElementById('todoPanel');

    let isGenerating = false;
    let currentAssistantDiv = null;
    let currentMode = 'build';
    const messageIndexMap = new Map();
    let settingsProviders = [];
    let settingsOllamaModels = [];

    // ── Button bindings ──
    // Use a single unified click handler on sendBtn to avoid onclick / addEventListener conflicts
    sendBtn.addEventListener('click', () => {
        if (isGenerating) {
            vscode.postMessage({ type: 'cancelGeneration' });
        } else {
            sendMessage();
        }
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!isGenerating) sendMessage(); } });
    input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; });

    function bindBtn(id, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    // Model selector quick-change
    const quickModelSel = document.getElementById('quickModelSelect');
    if (quickModelSel) {
        quickModelSel.addEventListener('change', () => {
            vscode.postMessage({ type: 'quickChangeModel', model: quickModelSel.value });
        });
    }

    bindBtn('btnNewTopic', () => vscode.postMessage({ type: 'newTopic' }));
    bindBtn('btnTopics', () => topicsPanel.classList.toggle('show'));
    bindBtn('btnNewTopicPanel', () => {
        vscode.postMessage({ type: 'newTopic' });
        topicsPanel.classList.remove('show');
    });
    bindBtn('btnSettings', () => vscode.postMessage({ type: 'openSettings' }));
    bindBtn('buildModeBtn', () => switchMode('build'));
    bindBtn('planModeBtn', () => switchMode('plan'));
    bindBtn('settingsBackBtn', closeSettings);
    bindBtn('testConnBtn', testConnection);
    bindBtn('saveSettingsBtn', saveSettings);
    bindBtn('keyToggleBtn', () => { const k = document.getElementById('settingsApiKey'); if (k) k.type = k.type === 'password' ? 'text' : 'password'; });
    bindBtn('detectBtn', detectOllamaModels);
    bindBtn('accChat', () => toggleAccordion('chatModelSection'));
    bindBtn('accInline', () => toggleAccordion('inlineSection'));
    bindBtn('accAgent', () => toggleAccordion('agentSection'));

    const providerSel = document.getElementById('settingsProvider');
    if (providerSel) providerSel.addEventListener('change', onProviderChange);
    const endpointInp = document.getElementById('settingsEndpoint');
    if (endpointInp) endpointInp.addEventListener('input', onEndpointChange);

    function sendMessage() {
        const text = input.value.trim();
        if (!text) return;
        vscode.postMessage({ type: 'sendMessage', text });
        input.value = '';
        input.style.height = 'auto';
    }

    function switchMode(mode) {
        currentMode = mode;
        vscode.postMessage({ type: 'switchMode', mode });
        const build = document.getElementById('buildModeBtn');
        const plan = document.getElementById('planModeBtn');
        if (build) build.classList.toggle('active', mode === 'build');
        if (plan) plan.classList.toggle('active', mode === 'plan');
        document.body.classList.toggle('plan-mode', mode === 'plan');
    }

    function setGenerating(val) {
        isGenerating = val;
        // Update visual state only — the unified click listener checks isGenerating at runtime
        sendBtn.innerHTML = val ? '⬛' : '↑';
        sendBtn.className = val ? 'send-btn cancel-btn' : 'send-btn';
    }

    // ── Markdown renderer ──────────────────────────────────────────────────────
    // Supports: headings, bold, italic, del, inline-code, fenced code blocks,
    // unordered/ordered lists, blockquotes, tables, horizontal rules, links.

    function escapeHtml(t) {
        return String(t ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function inlineMd(raw) {
        let s = raw
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        // inline code first so inner content is not processed
        s = s.replace(/`([^`]+)`/g, (_, c) => '<code>' + c.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') + '</code>');
        s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
        s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>');
        s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        return s;
    }

    function renderMarkdown(rawText) {
        if (!rawText) return '';

        // 1. Extract fenced code blocks, replace with placeholders
        const blocks = [];
        let text = rawText.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const i = blocks.length;
            blocks.push({ lang: lang.trim(), code });
            return '\x00BLOCK' + i + '\x00';
        });

        // 2. Split into "paragraphs" by blank lines
        const paras = text.split(/\n{2,}/);
        const out = [];

        for (let para of paras) {
            para = para.trim();
            if (!para) continue;

            // Code block placeholder
            if (/^\x00BLOCK\d+\x00$/.test(para)) {
                const { lang, code } = blocks[+para.match(/\d+/)[0]];
                out.push(
                    '<div class="md-codeblock"><div class="md-codeblock-lang">' +
                    escapeHtml(lang) + '</div><code>' + escapeHtml(code) + '</code></div>'
                );
                continue;
            }

            // Para might have embedded placeholders (code in middle of text)
            const lines = para.split('\n');

            // Heading
            if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) {
                const m = lines[0].match(/^(#{1,6})\s+(.+)$/);
                const lv = m[1].length;
                out.push('<h' + lv + '>' + inlineMd(m[2]) + '</h' + lv + '>');
                continue;
            }

            // Horizontal rule
            if (/^[-*_]{3,}$/.test(para)) { out.push('<hr>'); continue; }

            // Blockquote
            if (lines.every(l => /^>/.test(l))) {
                const inner = lines.map(l => l.replace(/^>\s?/, '')).join('\n');
                out.push('<blockquote>' + renderMarkdown(inner) + '</blockquote>');
                continue;
            }

            // Table
            if (lines.length >= 2 && /^\|/.test(lines[0]) && /^[\|\s:-]+$/.test(lines[1])) {
                const headers = lines[0].split('|').map(c=>c.trim()).filter(Boolean);
                const rows = lines.slice(2).map(r => r.split('|').map(c=>c.trim()).filter(Boolean));
                let tbl = '<table><thead><tr>' + headers.map(h=>'<th>'+inlineMd(h)+'</th>').join('') + '</tr></thead><tbody>';
                rows.forEach(r => { tbl += '<tr>' + r.map(c=>'<td>'+inlineMd(c)+'</td>').join('') + '</tr>'; });
                tbl += '</tbody></table>';
                out.push(tbl);
                continue;
            }

            // Unordered list
            if (/^[\-\*\+]\s/.test(lines[0])) {
                const items = [];
                let cur = null;
                for (const l of lines) {
                    const m = l.match(/^[\-\*\+]\s+(.+)/);
                    if (m) { if (cur !== null) items.push(cur); cur = m[1]; }
                    else if (cur !== null) cur += ' ' + l.trim();
                }
                if (cur !== null) items.push(cur);
                out.push('<ul>' + items.map(i => '<li>' + inlineMd(i) + '</li>').join('') + '</ul>');
                continue;
            }

            // Ordered list
            if (/^\d+\.\s/.test(lines[0])) {
                const items = [];
                let cur = null;
                for (const l of lines) {
                    const m = l.match(/^\d+\.\s+(.+)/);
                    if (m) { if (cur !== null) items.push(cur); cur = m[1]; }
                    else if (cur !== null) cur += ' ' + l.trim();
                }
                if (cur !== null) items.push(cur);
                out.push('<ol>' + items.map(i => '<li>' + inlineMd(i) + '</li>').join('') + '</ol>');
                continue;
            }

            // Regular paragraph — process line by line in case there are block placeholders
            const lineHtmlParts = [];
            for (const line of lines) {
                const trimLine = line.trim();
                if (/^\x00BLOCK\d+\x00$/.test(trimLine)) {
                    const { lang, code } = blocks[+trimLine.match(/\d+/)[0]];
                    lineHtmlParts.push(
                        '<div class="md-codeblock"><div class="md-codeblock-lang">' +
                        escapeHtml(lang) + '</div><code>' + escapeHtml(code) + '</code></div>'
                    );
                } else {
                    lineHtmlParts.push(inlineMd(line));
                }
            }
            // Join: use <br> between plain lines but not before/after block elements
            out.push('<p>' + lineHtmlParts.join('<br>') + '</p>');
        }

        return out.join('');
    }

    function scrollBottom() { chatArea.scrollTop = chatArea.scrollHeight; }

    function addUserMessage(text, msgIdx) {
        emptyState.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'message user';
        const idx = msgIdx !== undefined ? msgIdx : -1;
        if (idx >= 0) div.dataset.msgIndex = idx;
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span style="opacity:0.5;font-size:11px;">You</span>';
        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble';
        bubble.textContent = text;
        div.appendChild(hdr);
        div.appendChild(bubble);
        if (idx >= 0) {
            const rb = document.createElement('button');
            rb.className = 'retract-btn';
            rb.textContent = '↩ 撤回';
            rb.addEventListener('click', () => vscode.postMessage({ type: 'retractMessage', messageIndex: idx }));
            div.appendChild(rb);
            messageIndexMap.set(idx, div);
        }
        chatArea.appendChild(div);
        scrollBottom();
        return div;
    }

    const STEP_ICONS = {
        tool_call: '⚙', tool_result: '📦', thinking: '💭',
        thinking_content: '🧠', validation: '✅', error: '❌',
        code_generated: '📝', compaction: '🗄', todo_update: '📝'
    };

    function addAssistantMessage(content, code, isValid, steps) {
        const div = document.createElement('div');
        div.className = 'message assistant';
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;flex-shrink:0"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg><span style="font-family:Georgia,serif;">CWTools AI</span>';
        div.appendChild(hdr);

        if (steps && steps.length > 0) {
            // Thinking block (thinking_content steps)
            const thinkSteps = steps.filter(s => s.type === 'thinking_content');
            if (thinkSteps.length > 0) {
                const det = document.createElement('details');
                det.className = 'thinking-block';
                const sum = document.createElement('summary');
                sum.textContent = '🧠 Thinking · ' + thinkSteps.length + ' block(s)';
                det.appendChild(sum);
                const body = document.createElement('div');
                body.className = 'thinking-body';
                body.textContent = thinkSteps.map(s => s.content).join('\n\n---\n\n');
                det.appendChild(body);
                div.appendChild(det);
            }

            // Tool calls group (all non-thinking steps)
            const toolSteps = steps.filter(s => s.type !== 'thinking_content');
            if (toolSteps.length > 0) {
                const toolCallCount = toolSteps.filter(s => s.type === 'tool_call').length;
                const det = document.createElement('details');
                det.className = 'tool-group';
                const sum = document.createElement('summary');
                sum.textContent = toolCallCount > 0
                    ? '🔧 工具调用 · ' + toolCallCount
                    : '📋 Agent 步骤';
                det.appendChild(sum);
                const body = document.createElement('div');
                body.className = 'tool-group-body';
                for (const s of toolSteps) {
                    const el = document.createElement('div');
                    el.className = 'step ' + s.type;
                    el.innerHTML = '<span class="step-icon">' + (STEP_ICONS[s.type] || '·') + '</span>' + escapeHtml(s.content);
                    body.appendChild(el);
                }
                det.appendChild(body);
                div.appendChild(det);
            }
        }

        if (content && content.trim()) {
            const b = document.createElement('div');
            b.className = 'msg-bubble';
            b.innerHTML = renderMarkdown(content);
            div.appendChild(b);
        }
        if (code) {
            const cb = document.createElement('div');
            cb.className = 'code-block';
            const ch = document.createElement('div');
            ch.className = 'code-header';
            const valid = isValid ? 'valid' : 'invalid';
            const vtext = isValid ? '✅ 验证通过' : '⚠ 存在问题';
            ch.innerHTML = '<span class="code-status ' + valid + '">' + vtext + '</span>';
            const ca = document.createElement('div');
            ca.className = 'code-actions';
            const cpBtn = document.createElement('button');
            cpBtn.className = 'code-btn'; cpBtn.textContent = '复制';
            cpBtn.addEventListener('click', () => vscode.postMessage({ type: 'copyCode', code: cb.querySelector('.code-content').textContent }));
            const inBtn = document.createElement('button');
            inBtn.className = 'code-btn'; inBtn.textContent = '插入';
            inBtn.addEventListener('click', () => vscode.postMessage({ type: 'insertCode', code: cb.querySelector('.code-content').textContent }));
            ca.appendChild(cpBtn); ca.appendChild(inBtn); ch.appendChild(ca);
            const cc = document.createElement('div');
            cc.className = 'code-content'; cc.textContent = code;
            cb.appendChild(ch); cb.appendChild(cc);
            div.appendChild(cb);
        }
        chatArea.appendChild(div);
        scrollBottom();
        return div;
    }

    function showPendingWriteCard(file, messageId, isNewFile) {
        const fileName = (file || '').split(/[\\\/]/).pop() || file;
        const div = document.createElement('div');
        const card = document.createElement('div');
        card.className = 'diff-card';
        const safeId = escapeHtml(messageId);
        const hint = isNewFile
            ? '新文件已在编辑器中打开，请确认内容后决定'
            : '文件对比已在 VSCode 差异编辑器中打开';
        card.innerHTML =
            '<div class="diff-card-header">' +
            '<span>✏️ 请求' + (isNewFile ? '创建' : '修改') + ': <strong>' + escapeHtml(fileName) + '</strong></span>' +
            '<span class="diff-card-hint">' + hint + '</span>' +
            '</div>' +
            '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn" data-msgid="' + safeId + '">✅ 接受</button>' +
            '<button class="diff-reject-btn" data-msgid="' + safeId + '">❌ 拒绝</button>' +
            '</div>';
        card.querySelector('.diff-accept-btn').addEventListener('click', function() {
            this.disabled = true;
            card.querySelector('.diff-reject-btn').disabled = true;
            this.textContent = '已接受 ✅';
            vscode.postMessage({ type: 'confirmWriteFile', messageId });
        });
        card.querySelector('.diff-reject-btn').addEventListener('click', function() {
            this.disabled = true;
            card.querySelector('.diff-accept-btn').disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
        });
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Messages from host ──
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {
            case 'addUserMessage':
                setGenerating(true);
                addUserMessage(msg.text, msg.messageIndex);
                currentAssistantDiv = document.createElement('div');
                currentAssistantDiv.className = 'message assistant';
                currentAssistantDiv.innerHTML =
                    '<div class="msg-header"><svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;flex-shrink:0"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg><span style="font-family:Georgia,serif;">CWTools AI</span></div>' +
                    '<details class="thinking-block" id="liveThinkingBlock" style="display:none"><summary>🧠 Thinking...</summary><div class="thinking-body" id="liveThinkingBody"></div></details>' +
                    '<details class="tool-group" id="liveToolGroup" style="display:none"><summary id="liveToolSummary">💭 처리중...</summary><div class="tool-group-body" id="liveToolBody"></div></details>';
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom();
                break;

            case 'agentStep': {
                if (!currentAssistantDiv) break;
                const s = msg.step;

                if (s.type === 'thinking_content') {
                    // Show in dedicated thinking block
                    const tb = currentAssistantDiv.querySelector('#liveThinkingBlock');
                    const tbd = currentAssistantDiv.querySelector('#liveThinkingBody');
                    if (tb) tb.style.display = '';
                    if (tbd) {
                        if (tbd.textContent) tbd.textContent += '\n\n---\n\n' + s.content;
                        else tbd.textContent = s.content;
                    }
                } else {
                    // All other steps go in tool group
                    const tg = currentAssistantDiv.querySelector('#liveToolGroup');
                    const tb = currentAssistantDiv.querySelector('#liveToolBody');
                    const ts = currentAssistantDiv.querySelector('#liveToolSummary');
                    if (tg) tg.style.display = '';
                    if (ts) {
                        // Update summary with most recent step type
                        const toolCallCount = currentAssistantDiv.querySelectorAll('.step.tool_call').length
                            + (s.type === 'tool_call' ? 1 : 0);
                        ts.textContent = toolCallCount > 0
                            ? '🔧 工具调用 · ' + toolCallCount
                            : '📋 处理中...';
                    }
                    if (tb) {
                        const el = document.createElement('div');
                        el.className = 'step ' + s.type;
                        el.innerHTML = '<span class="step-icon">' + (STEP_ICONS[s.type] || '·') + '</span>' + escapeHtml(s.content);
                        tb.appendChild(el);
                    }
                }
                scrollBottom();
                break;
            }

            case 'generationComplete':
                setGenerating(false);
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                { const r = msg.result; addAssistantMessage(r.explanation || '完成', r.code, r.isValid, r.steps); }
                break;

            case 'generationError':
                setGenerating(false);
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                addAssistantMessage('❌ ' + msg.error);
                break;

            case 'clearChat':
                // Remove all children except emptyState, then re-attach emptyState
                while (chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                setGenerating(false);
                currentAssistantDiv = null;
                break;

            case 'topicList': renderTopics(msg.topics); break;

            case 'topicTitleGenerated': {
                // Update the matching topic title in the sidebar without full re-render
                const list = document.getElementById('topicsList');
                if (list) {
                    const items = list.querySelectorAll('.topic-item');
                    // Topics are rendered in order; find by dataset or position matching
                    // Re-render the list to ensure consistency
                    const titleSpans = list.querySelectorAll('.topic-title');
                    // Store the topicId→title mapping in a WeakMap-friendly way via data attrs
                    for (const item of list.querySelectorAll('.topic-item[data-topic-id="' + escapeHtml(msg.topicId) + '"]')) {
                        const span = item.querySelector('.topic-title');
                        if (span) span.textContent = msg.title;
                    }
                }
                break;
            }

            case 'loadTopicMessages':
                for (const m of msg.messages) {
                    if (m.role === 'user') addUserMessage(m.content);
                    else addAssistantMessage(m.content, m.code, m.isValid, m.steps);
                }
                break;

            case 'messageRetracted': {
                const rd = messageIndexMap.get(msg.messageIndex);
                if (rd) { rd.classList.add('retracted'); const b = rd.querySelector('.msg-bubble'); if (b) b.textContent = '(已撤回)'; }
                const nx = rd ? rd.nextElementSibling : null;
                if (nx && nx.classList.contains('assistant')) nx.remove();
                break;
            }

            case 'pendingWriteFile': showPendingWriteCard(msg.file, msg.messageId, msg.isNewFile); break;

            case 'modeChanged':
                currentMode = msg.mode;
                document.getElementById('buildModeBtn').classList.toggle('active', msg.mode === 'build');
                document.getElementById('planModeBtn').classList.toggle('active', msg.mode === 'plan');
                document.body.classList.toggle('plan-mode', msg.mode === 'plan');
                break;

            case 'todoUpdate': renderTodos(msg.todos); break;
            case 'settingsData':
                if (msg.showPanel) {
                    showSettingsPage(msg.providers, msg.current, msg.ollamaModels);
                } else {
                    // Only sync the quick model selector — don't open the settings page
                    updateQuickModelSelector(msg.providers, msg.current, msg.ollamaModels);
                }
                break;

            case 'ollamaModels': {
                const db = document.getElementById('detectBtn');
                db.disabled = false; db.textContent = '🔍 检测';
                if (msg.error) { document.getElementById('modelHint').textContent = msg.error; }
                else { settingsOllamaModels = msg.models; updateModelUI(document.getElementById('settingsProvider').value, '', msg.models); }
                break;
            }

            case 'testConnectionResult': {
                const tr = document.getElementById('testResult');
                tr.className = 'test-result ' + (msg.ok ? 'ok' : 'fail');
                tr.textContent = msg.message;
                break;
            }
        }
    });

    function renderTopics(topics) {
        const list = document.getElementById('topicsList');
        if (!topics.length) {
            list.innerHTML = '<div style="text-align:center;opacity:0.5;padding:20px;font-size:12px;">暂无历史话题</div>';
            return;
        }
        list.innerHTML = '';
        for (const t of topics) {
            const item = document.createElement('div');
            item.className = 'topic-item';
            item.dataset.topicId = t.id;
            const title = document.createElement('span');
            title.className = 'topic-title';
            title.textContent = t.title;
            const del = document.createElement('button');
            del.className = 'topic-delete';
            del.textContent = '✕';
            del.title = '删除此话题';
            del.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({ type: 'deleteTopic', topicId: t.id });
            });
            item.appendChild(title);
            item.appendChild(del);
            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'loadTopic', topicId: t.id });
                topicsPanel.classList.remove('show');
            });
            list.appendChild(item);
        }
    }

    function renderTodos(todos) {
        if (!todos || !todos.length) { todoPanel.classList.remove('has-items'); document.getElementById('todoList').innerHTML = ''; return; }
        todoPanel.classList.add('has-items');
        const icons = { pending:'○', in_progress:'●', done:'✓' };
        document.getElementById('todoList').innerHTML = todos.map(t => {
            const cls = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in_progress' : '';
            return '<div class="todo-item ' + cls + '"><span>' + (icons[t.status]||'○') + '</span>' + escapeHtml(t.content) + '</div>';
        }).join('');
    }

    function updateQuickModelSelector(providers, current, ollamaModels) {
        const qms = document.getElementById('quickModelSelect');
        if (!qms) return;
        const provider = providers.find(p => p.id === current.provider);
        const models = current.provider === 'ollama'
            ? (ollamaModels || []).map(m => m.name)
            : (provider ? provider.models : []);
        qms.innerHTML = '';
        if (models.length > 0) {
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                opt.selected = m === current.model;
                qms.appendChild(opt);
            }
        } else {
            const opt = document.createElement('option');
            opt.value = current.model || '';
            opt.textContent = current.model || '(未设置模型)';
            qms.appendChild(opt);
        }
    }

    function showSettingsPage(providers, current, ollamaModels) {
        settingsProviders = providers;
        settingsOllamaModels = ollamaModels || [];

        // Sync the quick model selector
        updateQuickModelSelector(providers, current, ollamaModels);

        const sel = document.getElementById('settingsProvider');
        sel.innerHTML = providers.map(p => '<option value="' + p.id + '"' + (p.id === current.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        const inlineSel = document.getElementById('inlineProvider');
        inlineSel.innerHTML = '<option value="">- 与对话相同 -</option>' + providers.map(p => '<option value="' + p.id + '"' + (p.id === current.inlineCompletion?.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        document.getElementById('settingsApiKey').value = '';
        document.getElementById('settingsEndpoint').value = current.endpoint || '';
        document.getElementById('settingsCtx').value = current.maxContextTokens || 0;
        document.getElementById('inlineEnabled').checked = current.inlineCompletion?.enabled ?? false;
        document.getElementById('inlineEndpoint').value = current.inlineCompletion?.endpoint || '';
        document.getElementById('inlineDebounce').value = current.inlineCompletion?.debounceMs || 1500;
        document.getElementById('agentWriteMode').value = current.agentFileWriteMode || 'confirm';

        // Populate inline model dropdown dynamically
        function updateInlineModelSelect(selectedProviderId, selectedModel, ollamaModels) {
            const sel = document.getElementById('inlineModel');
            const pid = selectedProviderId || current.provider;
            const provider = providers.find(p => p.id === pid);
            const models = pid === 'ollama'
                ? (ollamaModels || []).map(m => m.name)
                : (provider ? provider.models : []);
            sel.innerHTML = '<option value="">- 与对话相同 -</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                opt.selected = m === selectedModel;
                sel.appendChild(opt);
            }
            // If current model isn't in the list (custom), add it
            if (selectedModel && !models.includes(selectedModel)) {
                const opt = document.createElement('option');
                opt.value = selectedModel;
                opt.textContent = selectedModel;
                opt.selected = true;
                sel.appendChild(opt);
            }
        }

        const inlineProviderSel = document.getElementById('inlineProvider');
        updateInlineModelSelect(current.inlineCompletion?.provider, current.inlineCompletion?.model, ollamaModels);
        inlineProviderSel.onchange = () => updateInlineModelSelect(inlineProviderSel.value, '', ollamaModels);

        updateModelUI(current.provider, current.model, ollamaModels);
        updateApiKeyStatus(current.provider, providers);
        chatHeader.style.display = 'none';
        document.getElementById('chatArea').style.display = 'none';
        if (inputWrapper) inputWrapper.style.display = 'none';
        if (planIndicator) planIndicator.style.display = 'none';
        if (todoPanel) todoPanel.style.display = 'none';
        settingsPage.classList.add('active');
        document.getElementById('testResult').className = 'test-result';
        document.getElementById('testResult').textContent = '';
    }

    function closeSettings() {
        settingsPage.classList.remove('active');
        chatHeader.style.display = '';
        document.getElementById('chatArea').style.display = 'flex';
        if (inputWrapper) inputWrapper.style.display = '';
        if (planIndicator) planIndicator.style.display = '';
        if (todoPanel) todoPanel.style.display = '';
    }

    /** Update the API key status label for the given provider */
    function updateApiKeyStatus(providerId, providers) {
        const p = (providers || settingsProviders).find(x => x.id === providerId);
        const status = document.getElementById('apiKeyStatus');
        const group = document.getElementById('apiKeyGroup');
        if (providerId === 'ollama') {
            group.style.display = 'none';
            return;
        }
        group.style.display = '';
        if (p && p.hasKey) {
            status.textContent = '✅ 已配置 API Key';
            status.style.color = '#4caf50';
        } else {
            status.textContent = '⚠️ 尚未配置 API Key';
            status.style.color = '#ff9800';
        }
    }

    function onProviderChange() {
        const id = document.getElementById('settingsProvider').value;
        updateModelUI(id, '', settingsOllamaModels);
        updateEndpointHint(id);
        updateApiKeyStatus(id, settingsProviders);
    }

    function updateModelUI(providerId, currentModel, ollamaModels) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const modelSel = document.getElementById('settingsModelSelect');
        const modelInput = document.getElementById('settingsModelInput');
        const detectBtn = document.getElementById('detectBtn');
        const modelHint = document.getElementById('modelHint');
        if (providerId === 'ollama') {
            document.getElementById('apiKeyGroup').style.display = 'none';
            if (ollamaModels && ollamaModels.length > 0) {
                modelSel.innerHTML = ollamaModels.map(m => '<option value="' + escapeHtml(m.name) + '"' + (m.name === currentModel ? ' selected' : '') + '>' + escapeHtml(m.name) + (m.parameterSize ? ' (' + m.parameterSize + ')' : '') + ' — ' + m.size + '</option>').join('');
                modelSel.style.display = ''; modelInput.style.display = 'none';
                modelHint.textContent = '已检测到 ' + ollamaModels.length + ' 个本地模型';
            } else {
                modelSel.style.display = 'none'; modelInput.style.display = ''; detectBtn.style.display = '';
                modelInput.value = currentModel || '';
                modelHint.textContent = '点击「检测」自动获取正在运行的 Ollama 模型';
            }
            detectBtn.style.display = '';
        } else if (provider && provider.models.length > 0) {
            modelSel.innerHTML = provider.models.map(m => '<option value="' + escapeHtml(m) + '"' + (m === currentModel ? ' selected' : '') + '>' + escapeHtml(m) + '</option>').join('');
            if (!currentModel || !provider.models.includes(currentModel)) {
                modelSel.style.display = 'none'; modelInput.style.display = '';
                modelInput.value = currentModel || provider.defaultModel || '';
                modelHint.textContent = '也可直接输入模型名称';
            } else {
                modelSel.style.display = ''; modelInput.style.display = 'none';
                modelHint.textContent = '或直接输入自定义模型名';
            }
            detectBtn.style.display = 'none';
        } else {
            modelSel.style.display = 'none'; modelInput.style.display = ''; detectBtn.style.display = 'none';
            modelInput.value = currentModel || ''; modelHint.textContent = '';
        }
        updateEndpointHint(providerId);
    }

    function updateEndpointHint(providerId) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const hint = document.getElementById('endpointHint');
        const ep = document.getElementById('settingsEndpoint');
        if (provider) { hint.textContent = '默认: ' + (provider.defaultEndpoint || '由 provider 决定'); if (!ep.value) ep.placeholder = provider.defaultEndpoint || '留空使用默认'; }
    }

    function onEndpointChange() {
        if (document.getElementById('settingsProvider').value === 'ollama') {
            settingsOllamaModels = [];
            document.getElementById('settingsModelSelect').style.display = 'none';
            document.getElementById('settingsModelInput').style.display = '';
            document.getElementById('modelHint').textContent = '端点已更改，点击「检测」重新获取模型';
        }
    }

    function detectOllamaModels() {
        const btn = document.getElementById('detectBtn');
        const ep = document.getElementById('settingsEndpoint').value.trim();
        btn.disabled = true; btn.textContent = '检测中...';
        document.getElementById('modelHint').textContent = '正在连接 Ollama...';
        vscode.postMessage({ type: 'detectOllamaModels', endpoint: ep || 'http://localhost:11434/v1' });
    }

    function getSelectedModel() {
        const sel = document.getElementById('settingsModelSelect');
        const inp = document.getElementById('settingsModelInput');
        return sel.style.display !== 'none' ? sel.value : inp.value.trim();
    }

    function toggleAccordion(id) { document.getElementById(id).classList.toggle('open'); }

    function saveSettings() {
        vscode.postMessage({ type: 'saveSettings', settings: {
            provider: document.getElementById('settingsProvider').value,
            model: getSelectedModel(),
            apiKey: document.getElementById('settingsApiKey').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            maxContextTokens: parseInt(document.getElementById('settingsCtx').value) || 0,
            agentFileWriteMode: document.getElementById('agentWriteMode').value,
            inlineCompletion: {
                enabled: document.getElementById('inlineEnabled').checked,
                provider: document.getElementById('inlineProvider').value,
                model: document.getElementById('inlineModel').value.trim(),
                endpoint: document.getElementById('inlineEndpoint').value.trim(),
                debounceMs: parseInt(document.getElementById('inlineDebounce').value) || 1500,
            },
        }});
        // Don't close — backend will push fresh settingsData with updated hasKey
    }

    function testConnection() {
        const tr = document.getElementById('testResult');
        tr.className = 'test-result'; tr.textContent = '测试中...'; tr.style.display = 'block';
        vscode.postMessage({ type: 'testConnection', settings: {
            provider: document.getElementById('settingsProvider').value,
            model: getSelectedModel(),
            apiKey: document.getElementById('settingsApiKey').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            maxContextTokens: 0, agentFileWriteMode: 'confirm',
            inlineCompletion: { enabled: false, provider: '', model: '', endpoint: '', debounceMs: 1500 },
        }});
    }
})();
