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
    let totalConversationTokens = 0;
    let contextLimit = 128000;

    // ── Placeholder rotation ───────────────────────────────────────────────────
    const PROMPT_EXAMPLES = [
        '检查当前文件的 LSP 错误并修复',
        '为 scripted_trigger 添加检查星球所有者特性的条件',
        '解释 from、root、prev 这三个作用域的区别',
        '创建一个每月给舰队补充护卫舰的 on_action',
        '在 common/buildings 中添加一个需要矿物的新建筑',
        '修复当前效果块中的作用域错误',
        '分析当前文件并列出潜在的语法问题',
        '给这个 scripted_effect 添加错误检测逻辑',
        '为当前事件添加 immediate 触发器初始化变量',
        '解释 scripted_trigger 和 limit 的区别',
        '帮我优化这个循环检查所有星球的触发器',
        '创建一个基于帝国科技等级的 modifier 公式',
    ];
    let placeholderIdx = Math.floor(Math.random() * PROMPT_EXAMPLES.length);
    let placeholderTimer = null;

    function startPlaceholderRotation() {
        stopPlaceholderRotation();
        placeholderTimer = setInterval(() => {
            if (input.value.trim() === '' && !isGenerating) {
                placeholderIdx = (placeholderIdx + 1) % PROMPT_EXAMPLES.length;
                input.placeholder = PROMPT_EXAMPLES[placeholderIdx];
            }
        }, 6500);
    }
    function stopPlaceholderRotation() {
        if (placeholderTimer) { clearInterval(placeholderTimer); placeholderTimer = null; }
    }
    input.placeholder = PROMPT_EXAMPLES[placeholderIdx];
    startPlaceholderRotation();

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isGenerating) {
            vscode.postMessage({ type: 'cancelGeneration' });
        }
    });

    // ── Suggestion cards ───────────────────────────────────────────────────────
    document.querySelectorAll('.suggest-card').forEach(btn => {
        btn.addEventListener('click', () => {
            const text = btn.getAttribute('data-suggest');
            if (text) {
                input.value = text;
                autoResizeInput();
                input.focus();
                setTimeout(() => sendMessage(), 120);
            }
        });
    });

    // ── Button logic ───────────────────────────────────────────────────────────
    sendBtn.addEventListener('click', () => {
        if (isGenerating) {
            vscode.postMessage({ type: 'cancelGeneration' });
        } else {
            sendMessage();
        }
    });
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isGenerating) sendMessage();
        }
    });
    input.addEventListener('input', autoResizeInput);
    input.addEventListener('focus', stopPlaceholderRotation);
    input.addEventListener('blur', () => { if (input.value.trim() === '') startPlaceholderRotation(); });

    function autoResizeInput() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    }

    function bindBtn(id, handler) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    const quickModelSel = document.getElementById('quickModelSelect');
    if (quickModelSel) {
        quickModelSel.addEventListener('change', () => {
            vscode.postMessage({ type: 'quickChangeModel', model: quickModelSel.value });
        });
    }

    bindBtn('btnNewTopic',      () => vscode.postMessage({ type: 'newTopic' }));
    bindBtn('btnTopics',        () => topicsPanel.classList.toggle('show'));
    bindBtn('btnNewTopicPanel', () => { vscode.postMessage({ type: 'newTopic' }); topicsPanel.classList.remove('show'); });
    bindBtn('btnSettings',      () => vscode.postMessage({ type: 'openSettings' }));
    bindBtn('buildModeBtn',     () => switchMode('build'));
    bindBtn('planModeBtn',      () => switchMode('plan'));
    bindBtn('settingsBackBtn',  closeSettings);
    bindBtn('testConnBtn',      testConnection);
    bindBtn('saveSettingsBtn',  saveSettings);
    bindBtn('keyToggleBtn',     () => { const k = document.getElementById('settingsApiKey'); if (k) k.type = k.type === 'password' ? 'text' : 'password'; });
    bindBtn('detectBtn',        detectOllamaModels);
    bindBtn('accChat',          () => toggleAccordion('chatModelSection'));
    bindBtn('accInline',        () => toggleAccordion('inlineSection'));
    bindBtn('accAgent',         () => toggleAccordion('agentSection'));

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
        stopPlaceholderRotation();
    }

    function switchMode(mode) {
        currentMode = mode;
        vscode.postMessage({ type: 'switchMode', mode });
        const build = document.getElementById('buildModeBtn');
        const plan  = document.getElementById('planModeBtn');
        if (build) build.classList.toggle('active', mode === 'build');
        if (plan)  plan.classList.toggle('active', mode === 'plan');
        document.body.classList.toggle('plan-mode', mode === 'plan');
    }

    function setGenerating(val) {
        isGenerating = val;
        if (val) {
            sendBtn.innerHTML = '<span class="stop-icon"></span>';
            sendBtn.title = '取消生成 (Esc)';
            sendBtn.className = 'send-btn cancel-mode';
        } else {
            sendBtn.innerHTML = '<span class="send-icon">↑</span>';
            sendBtn.title = '发送 (Enter)';
            sendBtn.className = 'send-btn';
            if (input.value.trim() === '') startPlaceholderRotation();
        }
    }

    // ── Token usage bar ────────────────────────────────────────────────────────
    function updateTokenUsage(used, limit) {
        if (!used) return;
        const bar   = document.getElementById('tokenUsageBar');
        const fill  = document.getElementById('tokenUsageFill');
        const label = document.getElementById('tokenUsageLabel');
        if (!bar || !fill || !label) return;
        const pct = Math.min(100, Math.round((used / limit) * 100));
        fill.style.width = pct + '%';
        fill.style.background = pct > 80 ? 'var(--error)' : pct > 60 ? 'var(--warning)' : 'var(--accent)';
        label.textContent = `~${formatNum(used)} / ${formatNum(limit)} tokens`;
        bar.style.display = '';
    }

    function formatNum(n) { return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n); }

    function formatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
    }

    // ── HTML escape ────────────────────────────────────────────────────────────
    function escapeHtml(t) {
        return String(t ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── Markdown renderer ──────────────────────────────────────────────────────
    function inlineMd(raw) {
        let s = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        s = s.replace(/`([^`]+)`/g, (_,c) => '<code>' + c.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') + '</code>');
        s = s.replace(/\*\*\*([^*]+)\*\*\*/g,'<strong><em>$1</em></strong>');
        s = s.replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>');
        s = s.replace(/__([^_]+)__/g,'<strong>$1</strong>');
        s = s.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
        s = s.replace(/_([^_\n]+)_/g,'<em>$1</em>');
        s = s.replace(/~~([^~]+)~~/g,'<del>$1</del>');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
        return s;
    }

    function renderMarkdown(rawText) {
        if (!rawText) return '';
        const blocks = [];
        let text = rawText.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_,lang,code) => {
            const i = blocks.length; blocks.push({lang:lang.trim(),code}); return '\x00BLOCK'+i+'\x00';
        });
        const paras = text.split(/\n{2,}/);
        const out = [];
        for (let para of paras) {
            para = para.trim(); if (!para) continue;
            if (/^\x00BLOCK\d+\x00$/.test(para)) {
                const {lang,code} = blocks[+para.match(/\d+/)[0]];
                out.push('<div class="md-codeblock"><div class="md-codeblock-lang">'+escapeHtml(lang)+'</div><code>'+escapeHtml(code)+'</code></div>'); continue;
            }
            const lines = para.split('\n');
            if (/^#{1,6}\s/.test(lines[0]) && lines.length===1) {
                const m = lines[0].match(/^(#{1,6})\s+(.+)$/); const lv = m[1].length;
                out.push('<h'+lv+'>'+inlineMd(m[2])+'</h'+lv+'>'); continue;
            }
            if (/^[-*_]{3,}$/.test(para)) { out.push('<hr>'); continue; }
            if (lines.every(l=>/^>/.test(l))) {
                out.push('<blockquote>'+renderMarkdown(lines.map(l=>l.replace(/^>\s?/,'')).join('\n'))+'</blockquote>'); continue;
            }
            if (lines.length>=2 && /^\|/.test(lines[0]) && /^[\|\s:-]+$/.test(lines[1])) {
                const headers = lines[0].split('|').map(c=>c.trim()).filter(Boolean);
                const rows = lines.slice(2).map(r=>r.split('|').map(c=>c.trim()).filter(Boolean));
                let tbl='<table><thead><tr>'+headers.map(h=>'<th>'+inlineMd(h)+'</th>').join('')+'</tr></thead><tbody>';
                rows.forEach(r=>{ tbl+='<tr>'+r.map(c=>'<td>'+inlineMd(c)+'</td>').join('')+'</tr>'; });
                out.push(tbl+'</tbody></table>'); continue;
            }
            if (/^[\-\*\+]\s/.test(lines[0])) {
                const items=[]; let cur=null;
                for (const l of lines) { const m=l.match(/^[\-\*\+]\s+(.+)/); if(m){if(cur!==null)items.push(cur);cur=m[1];}else if(cur!==null)cur+=' '+l.trim(); }
                if(cur!==null)items.push(cur);
                out.push('<ul>'+items.map(i=>'<li>'+inlineMd(i)+'</li>').join('')+'</ul>'); continue;
            }
            if (/^\d+\.\s/.test(lines[0])) {
                const items=[]; let cur=null;
                for (const l of lines) { const m=l.match(/^\d+\.\s+(.+)/); if(m){if(cur!==null)items.push(cur);cur=m[1];}else if(cur!==null)cur+=' '+l.trim(); }
                if(cur!==null)items.push(cur);
                out.push('<ol>'+items.map(i=>'<li>'+inlineMd(i)+'</li>').join('')+'</ol>'); continue;
            }
            const lineHtml = lines.map(line => {
                const t = line.trim();
                if (/^\x00BLOCK\d+\x00$/.test(t)) {
                    const {lang,code}=blocks[+t.match(/\d+/)[0]];
                    return '<div class="md-codeblock"><div class="md-codeblock-lang">'+escapeHtml(lang)+'</div><code>'+escapeHtml(code)+'</code></div>';
                }
                return inlineMd(line);
            });
            out.push('<p>'+lineHtml.join('<br>')+'</p>');
        }
        return out.join('');
    }

    function scrollBottom() { chatArea.scrollTop = chatArea.scrollHeight; }

    // ── OpenCode-style step rendering ─────────────────────────────────────────
    // Tool step icons — minimal, professional
    const TOOL_ICONS = {
        read_file:'📄', write_file:'💾', edit_file:'✏️',
        list_directory:'📁', search_mod_files:'🔍', validate_code:'✅',
        get_file_context:'📄', get_diagnostics:'🩺', get_completion_at:'💡',
        document_symbols:'🔖', workspace_symbols:'🔖', query_scope:'🔭',
        query_types:'📐', query_rules:'📏', query_references:'🔗', todo_write:'📋',
    };
    const WRITE_TOOL_NAMES = new Set(['edit_file','write_file','read_file','delete_file']);

    /**
     * Build ONE tool-pair <div class="tool-pair"> that shows:
     *   ┌─ ToolIcon  tool_name → file.txt
     *   └─ (result summary, only when toolResult is present)
     */
    function buildToolPair(callStep, resultStep) {
        const toolName = callStep.toolName || '';
        const args = callStep.toolArgs || {};
        const icon = TOOL_ICONS[toolName] || '⚙';
        const fp = args.filePath || args.file || args.path || args.directory || '';
        const fname = fp ? String(fp).split(/[\\/]/).pop() : '';

        let callHtml = `<span class="tp-icon">${icon}</span>`;
        callHtml += `<span class="tp-name">${escapeHtml(toolName)}</span>`;
        if (fname) callHtml += ` <span class="tp-file">${escapeHtml(fname)}</span>`;

        let resultHtml = '';
        if (resultStep && resultStep.toolResult) {
            const r = resultStep.toolResult;
            if (r && r.success === true) {
                const added   = r.stats ? r.stats.linesAdded   || 0 : 0;
                const removed = r.stats ? r.stats.linesRemoved || 0 : 0;
                const diffStr = (added || removed) ? ` +${added}/-${removed}` : '';
                resultHtml = `<div class="tp-result ok">✓${escapeHtml(diffStr)}</div>`;
            } else if (r && r.success === false) {
                resultHtml = `<div class="tp-result err">✗ ${escapeHtml(r.message||r.error||'')}</div>`;
            } else if (r && r.error) {
                resultHtml = `<div class="tp-result err">✗ ${escapeHtml(r.error)}</div>`;
            } else if (r && r.skipped) {
                resultHtml = `<div class="tp-result skip">— skipped</div>`;
            }
        }

        return `<div class="tool-pair"><div class="tp-call">${callHtml}</div>${resultHtml}</div>`;
    }

    // ── OpenCode-style: build complete assistant message DOM ────────────────────
    //   Structure (matches OpenCode's message anatomy):
    //   1. [Thinking block]  — extended reasoning, collapsible, at the top
    //   2. [Tool calls block] — list of tool-pair rows (call + result)
    //   3. [Text response]   — the final markdown answer

    function buildAssistantMessage(content, steps, msgTime) {
        const div = document.createElement('div');
        div.className = 'message assistant';

        // ── Header row ──
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" class="ai-star"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg>' +
            '<span class="msg-role">CWTools AI</span>' +
            '<span class="msg-time">' + (msgTime || '') + '</span>';
        div.appendChild(hdr);

        if (steps && steps.length > 0) {
            // 1. Thinking block (thinking_content AND narrative 'thinking' type)
            const thinkSteps = steps.filter(s => s.type === 'thinking_content' || s.type === 'thinking');
            if (thinkSteps.length > 0) {
                const thinkText = thinkSteps.map(s => s.content || '').join('\n\n').trim();
                const estTokens = Math.ceil(thinkText.length / 4);

                const det = document.createElement('details');
                det.className = 'thinking-block';
                const sum = document.createElement('summary');
                sum.innerHTML = '<span class="think-pulse"></span>Thinking · ' +
                    thinkSteps.length + ' block(s) &nbsp;<span class="think-tokens">~' + formatNum(estTokens) + ' tokens</span>';
                det.appendChild(sum);
                const body = document.createElement('div');
                body.className = 'thinking-body';
                body.textContent = thinkText;
                det.appendChild(body);
                div.appendChild(det);
            }

            // 2. Tool calls block — pair each tool_call with its tool_result
            const toolCallSteps = steps.filter(s => s.type === 'tool_call');
            const toolResultSteps = steps.filter(s => s.type === 'tool_result');

            if (toolCallSteps.length > 0) {
                const det = document.createElement('details');
                det.className = 'tool-group';
                det.open = false;
                const sum = document.createElement('summary');
                sum.innerHTML = '<span class="tg-icon">⚙</span>' +
                    toolCallSteps.length + ' tool call' + (toolCallSteps.length !== 1 ? 's' : '');
                det.appendChild(sum);

                const body = document.createElement('div');
                body.className = 'tool-group-body';
                for (let i = 0; i < toolCallSteps.length; i++) {
                    const call = toolCallSteps[i];
                    // Match corresponding result by index or toolName
                    const result = toolResultSteps.find(r => r.toolName === call.toolName && !r._matched);
                    if (result) result._matched = true;
                    body.innerHTML += buildToolPair(call, result);
                }
                det.appendChild(body);
                div.appendChild(det);
            }

            // Also show non-tool, non-thinking special steps (errors, compaction, etc.)
            const specialSteps = steps.filter(s =>
                s.type !== 'tool_call' && s.type !== 'tool_result' &&
                s.type !== 'thinking_content' && s.type !== 'thinking'
            );
            for (const s of specialSteps) {
                const el = document.createElement('div');
                const icon = s.type === 'error' ? '❌' : s.type === 'validation' ? '✅' : s.type === 'compaction' ? '🗜' : '·';
                el.className = 'special-step';
                el.textContent = icon + ' ' + (s.content || '');
                div.appendChild(el);
            }
        }

        // 3. Text response
        if (content && content.trim()) {
            const b = document.createElement('div');
            b.className = 'msg-bubble';
            b.innerHTML = renderMarkdown(content);
            div.appendChild(b);
        }

        return div;
    }

    // ── Live thinking/tool state builders ─────────────────────────────────────
    // We maintain a structured state for the live (streaming) assistant message.
    // liveState = { thinkSteps: AgentStep[], toolCalls: Map<toolName, {call,result}[]>, specialSteps }
    let liveState = null;

    function initLiveAssistantDiv() {
        const div = document.createElement('div');
        div.className = 'message assistant live-msg';
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" class="ai-star"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg>' +
            '<span class="msg-role">CWTools AI</span>';
        div.appendChild(hdr);

        // Thinking block — initially hidden
        const thinkDet = document.createElement('details');
        thinkDet.className = 'thinking-block'; thinkDet.id = 'liveThink'; thinkDet.style.display = 'none';
        const thinkSum = document.createElement('summary');
        thinkSum.id = 'liveThinkSum';
        thinkSum.innerHTML = '<span class="think-pulse spinning"></span>Thinking...';
        thinkDet.appendChild(thinkSum);
        const thinkBody = document.createElement('div');
        thinkBody.className = 'thinking-body'; thinkBody.id = 'liveThinkBody';
        thinkDet.appendChild(thinkBody);
        div.appendChild(thinkDet);

        // Tool group — initially hidden
        const toolDet = document.createElement('details');
        toolDet.className = 'tool-group'; toolDet.id = 'liveToolGroup'; toolDet.style.display = 'none'; toolDet.open = true;
        const toolSum = document.createElement('summary');
        toolSum.id = 'liveToolSum';
        toolSum.innerHTML = '<span class="tg-icon">⚙</span><span id="liveToolCount">0 tool calls</span>';
        toolDet.appendChild(toolSum);
        const toolBody = document.createElement('div');
        toolBody.className = 'tool-group-body'; toolBody.id = 'liveToolBody';
        toolDet.appendChild(toolBody);
        div.appendChild(toolDet);

        return div;
    }

    function applyLiveStep(s) {
        if (!currentAssistantDiv) return;

        if (s.type === 'thinking_content' || s.type === 'thinking') {
            const tb = document.getElementById('liveThink');
            const tbd = document.getElementById('liveThinkBody');
            const tsum = document.getElementById('liveThinkSum');
            if (tb) tb.style.display = '';
            if (tbd) {
                if (tbd.textContent) tbd.textContent += '\n\n---\n\n' + (s.content || '');
                else tbd.textContent = s.content || '';
                if (tsum) {
                    const est = Math.ceil(tbd.textContent.length / 4);
                    const thinkCount = tbd.textContent.split('\n\n---\n\n').length;
                    tsum.innerHTML = '<span class="think-pulse spinning"></span>Thinking · ' + thinkCount + ' block(s) &nbsp;<span class="think-tokens">~' + formatNum(est) + ' tokens</span>';
                }
            }
        } else if (s.type === 'tool_call') {
            const tg = document.getElementById('liveToolGroup');
            const tb = document.getElementById('liveToolBody');
            const tc = document.getElementById('liveToolCount');
            if (tg) tg.style.display = '';
            if (tb) {
                // Each call gets a pending <div class="tool-pair" data-tool="..."> that the result will update
                const pairDiv = document.createElement('div');
                pairDiv.className = 'tool-pair';
                pairDiv.dataset.tool = s.toolName || '';
                pairDiv.dataset.callIdx = String(tb.querySelectorAll('.tool-pair').length);
                pairDiv.innerHTML = buildToolPair(s, null);
                tb.appendChild(pairDiv);
            }
            if (tc) {
                const count = document.getElementById('liveToolBody')?.querySelectorAll('.tool-pair').length || 0;
                tc.textContent = count + ' tool call' + (count !== 1 ? 's' : '');
            }
        } else if (s.type === 'tool_result') {
            const tb = document.getElementById('liveToolBody');
            if (tb) {
                // Find the unresolved pair for this tool
                const pairs = Array.from(tb.querySelectorAll('.tool-pair[data-tool="' + s.toolName + '"]:not([data-resolved])'));
                if (pairs.length > 0) {
                    const pair = pairs[0];
                    pair.dataset.resolved = '1';
                    // Find the call step that matches this result
                    const callDiv = pair.querySelector('.tp-call');
                    // Build fresh pair with result
                    const fakeCall = { toolName: s.toolName, toolArgs: {} };
                    pair.innerHTML = buildToolPair(fakeCall, s);
                }
            }
        } else if (s.type === 'error' || s.type === 'validation' || s.type === 'compaction') {
            if (!currentAssistantDiv) return;
            const el = document.createElement('div');
            el.className = 'special-step';
            const icon = s.type === 'error' ? '❌' : s.type === 'validation' ? '✅' : '🗜';
            el.textContent = icon + ' ' + (s.content || '');
            currentAssistantDiv.appendChild(el);
        }
        scrollBottom();
    }

    // ── User message ───────────────────────────────────────────────────────────
    function addUserMessage(text, msgIdx) {
        emptyState.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'message user';
        if (msgIdx !== undefined && msgIdx >= 0) div.dataset.msgIndex = msgIdx;

        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span class="msg-role user-role">You</span><span class="msg-time">' + formatTime(Date.now()) + '</span>';

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble user-bubble';
        bubble.textContent = text;
        div.appendChild(hdr);
        div.appendChild(bubble);

        if (msgIdx !== undefined && msgIdx >= 0) {
            const rb = document.createElement('button');
            rb.className = 'retract-btn';
            rb.textContent = '↩ 撤回';
            rb.addEventListener('click', () => showRetractConfirm(msgIdx));
            div.appendChild(rb);
            messageIndexMap.set(msgIdx, div);
        }
        chatArea.appendChild(div);
        scrollBottom();
        return div;
    }

    // P3: Retract confirmation dialog
    function showRetractConfirm(messageIdx) {
        const overlay = document.createElement('div');
        overlay.className = 'retract-confirm';
        overlay.innerHTML = '<div class="retract-confirm-box">' +
            '<div class="retract-confirm-title">撤回此消息？</div>' +
            '<div class="retract-confirm-hint">这将同时撤回后续的 AI 回复</div>' +
            '<div class="retract-confirm-btns">' +
            '<button class="retract-ok">撤回</button>' +
            '<button class="retract-cancel">取消</button>' +
            '</div></div>';
        overlay.querySelector('.retract-ok').addEventListener('click', () => {
            overlay.remove();
            vscode.postMessage({ type: 'retractMessage', messageIndex: messageIdx });
        });
        overlay.querySelector('.retract-cancel').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }

    // ── Diff card ──────────────────────────────────────────────────────────────
    function showPendingWriteCard(file, messageId, isNewFile) {
        const fileName = (file || '').split(/[\\\/]/).pop() || file;
        const div = document.createElement('div');
        const card = document.createElement('div');
        card.className = 'diff-card';
        const safeId = escapeHtml(messageId);
        const hint = isNewFile ? '新文件已在编辑器中打开，请确认内容后决定' : '文件对比已在 VSCode 差异编辑器中打开';
        card.innerHTML =
            '<div class="diff-card-header">' +
            '✏️ 请求' + (isNewFile ? '创建' : '修改') + ': <strong>' + escapeHtml(fileName) + '</strong>' +
            '<span class="diff-card-hint">' + hint + '</span></div>' +
            '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn" data-msgid="' + safeId + '">✅ 接受</button>' +
            '<button class="diff-reject-btn" data-msgid="' + safeId + '">❌ 拒绝</button>' +
            '</div>';
        card.querySelector('.diff-accept-btn').addEventListener('click', function () {
            this.disabled = true; card.querySelector('.diff-reject-btn').disabled = true;
            this.textContent = '已接受 ✅';
            vscode.postMessage({ type: 'confirmWriteFile', messageId });
        });
        card.querySelector('.diff-reject-btn').addEventListener('click', function () {
            this.disabled = true; card.querySelector('.diff-accept-btn').disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
        });
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Message handler ────────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {

            case 'addUserMessage':
                setGenerating(true);
                addUserMessage(msg.text, msg.messageIndex);
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom();
                break;

            case 'agentStep':
                applyLiveStep(msg.step);
                break;

            case 'generationComplete': {
                setGenerating(false);
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                const r = msg.result;
                // Finalise thinking block: remove the spinning class
                const completedMsg = buildAssistantMessage(
                    r.explanation || (r.steps && r.steps.length ? '' : '完成'),
                    r.steps,
                    formatTime(Date.now())
                );
                chatArea.appendChild(completedMsg);
                // Update token estimate
                const stepTokens = r.steps ? r.steps.reduce((sum, s) => {
                    if (s.type === 'thinking_content' || s.type === 'thinking')
                        return sum + Math.ceil((s.content || '').length / 4);
                    return sum;
                }, 0) : 0;
                totalConversationTokens += Math.ceil((r.explanation || '').length / 4) + stepTokens + 500;
                updateTokenUsage(totalConversationTokens, contextLimit);
                scrollBottom();
                break;
            }

            case 'generationError':
                setGenerating(false);
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                {
                    const errDiv = buildAssistantMessage('❌ ' + msg.error, [], formatTime(Date.now()));
                    chatArea.appendChild(errDiv);
                }
                scrollBottom();
                break;

            case 'clearChat':
                while (chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                setGenerating(false);
                currentAssistantDiv = null;
                totalConversationTokens = 0;
                const bar = document.getElementById('tokenUsageBar');
                if (bar) bar.style.display = 'none';
                startPlaceholderRotation();
                break;

            case 'topicList': renderTopics(msg.topics); break;

            case 'topicTitleGenerated': {
                const list = document.getElementById('topicsList');
                if (list) {
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
                    else {
                        chatArea.appendChild(buildAssistantMessage(m.content, m.steps, ''));
                        scrollBottom();
                    }
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
                if (msg.current && msg.current.maxContextTokens > 0) contextLimit = msg.current.maxContextTokens;
                if (msg.showPanel) showSettingsPage(msg.providers, msg.current, msg.ollamaModels);
                else updateQuickModelSelector(msg.providers, msg.current, msg.ollamaModels);
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

    // ── Topic list with date groups ────────────────────────────────────────────
    function groupTopicsByDate(topics) {
        const now = Date.now(); const DAY = 86400000;
        const groups = [{ label:'今天',items:[] },{ label:'昨天',items:[] },{ label:'本周',items:[] },{ label:'更早',items:[] }];
        for (const t of topics) {
            const age = now - (t.updatedAt||0);
            if (age<DAY) groups[0].items.push(t);
            else if (age<DAY*2) groups[1].items.push(t);
            else if (age<DAY*7) groups[2].items.push(t);
            else groups[3].items.push(t);
        }
        return groups.filter(g=>g.items.length>0);
    }

    function renderTopics(topics) {
        const list = document.getElementById('topicsList');
        if (!topics.length) {
            list.innerHTML = '<div style="text-align:center;opacity:0.5;padding:20px;font-size:12px;">暂无历史话题</div>';
            return;
        }
        list.innerHTML = '';
        const groups = groupTopicsByDate(topics);
        for (const group of groups) {
            const header = document.createElement('div');
            header.className = 'topic-date-group';
            header.textContent = group.label;
            list.appendChild(header);
            for (const t of group.items) {
                const item = document.createElement('div');
                item.className = 'topic-item'; item.dataset.topicId = t.id;
                const title = document.createElement('span'); title.className = 'topic-title'; title.textContent = t.title;
                const del = document.createElement('button'); del.className = 'topic-delete'; del.textContent = '✕'; del.title = '删除';
                del.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'deleteTopic', topicId: t.id }); });
                item.appendChild(title); item.appendChild(del);
                item.addEventListener('click', () => { vscode.postMessage({ type: 'loadTopic', topicId: t.id }); topicsPanel.classList.remove('show'); });
                list.appendChild(item);
            }
        }
    }

    function renderTodos(todos) {
        if (!todos||!todos.length) { todoPanel.classList.remove('has-items'); document.getElementById('todoList').innerHTML=''; return; }
        todoPanel.classList.add('has-items');
        const icons = { pending:'○', in_progress:'●', done:'✓' };
        document.getElementById('todoList').innerHTML = todos.map(t => {
            const cls = t.status==='done'?'done':t.status==='in_progress'?'in_progress':'';
            return '<div class="todo-item '+cls+'"><span>'+(icons[t.status]||'○')+'</span>'+escapeHtml(t.content)+'</div>';
        }).join('');
    }

    function updateQuickModelSelector(providers, current, ollamaModels) {
        const qms = document.getElementById('quickModelSelect');
        if (!qms) return;
        const provider = providers.find(p=>p.id===current.provider);
        const models = current.provider==='ollama' ? (ollamaModels||[]).map(m=>m.name) : (provider?provider.models:[]);
        qms.innerHTML = '';
        if (models.length>0) {
            for (const m of models) { const opt=document.createElement('option'); opt.value=m; opt.textContent=m; opt.selected=m===current.model; qms.appendChild(opt); }
        } else { const opt=document.createElement('option'); opt.value=current.model||''; opt.textContent=current.model||'(未设置)'; qms.appendChild(opt); }
    }

    function showSettingsPage(providers, current, ollamaModels) {
        settingsProviders = providers;
        settingsOllamaModels = ollamaModels || [];
        updateQuickModelSelector(providers, current, ollamaModels);
        const sel = document.getElementById('settingsProvider');
        sel.innerHTML = providers.map(p=>'<option value="'+p.id+'"'+(p.id===current.provider?' selected':'')+'>'+escapeHtml(p.name)+'</option>').join('');
        const inlineSel = document.getElementById('inlineProvider');
        inlineSel.innerHTML = '<option value="">- 与对话相同 -</option>' + providers.map(p=>'<option value="'+p.id+'"'+(p.id===current.inlineCompletion?.provider?' selected':'')+'>'+escapeHtml(p.name)+'</option>').join('');
        document.getElementById('settingsApiKey').value = '';
        document.getElementById('settingsEndpoint').value = current.endpoint||'';
        document.getElementById('settingsCtx').value = current.maxContextTokens||0;
        document.getElementById('inlineEnabled').checked = current.inlineCompletion?.enabled??false;
        document.getElementById('inlineEndpoint').value = current.inlineCompletion?.endpoint||'';
        document.getElementById('inlineDebounce').value = current.inlineCompletion?.debounceMs||1500;
        document.getElementById('agentWriteMode').value = current.agentFileWriteMode||'confirm';
        function updateInlineModelSelect(pid, selectedModel, ollamaModels) {
            const s = document.getElementById('inlineModel'); const p2 = providers.find(p=>p.id===(pid||current.provider));
            const ms = (pid||current.provider)==='ollama'?(ollamaModels||[]).map(m=>m.name):(p2?p2.models:[]);
            s.innerHTML = '<option value="">- 与对话相同 -</option>';
            for (const m of ms) { const o=document.createElement('option'); o.value=m; o.textContent=m; o.selected=m===selectedModel; s.appendChild(o); }
            if (selectedModel&&!ms.includes(selectedModel)) { const o=document.createElement('option'); o.value=selectedModel; o.textContent=selectedModel; o.selected=true; s.appendChild(o); }
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

    function updateApiKeyStatus(providerId, providers) {
        const p = (providers||settingsProviders).find(x=>x.id===providerId);
        const status = document.getElementById('apiKeyStatus');
        const group = document.getElementById('apiKeyGroup');
        if (providerId==='ollama') { group.style.display='none'; return; }
        group.style.display = '';
        if (p&&p.hasKey) { status.textContent='✅ 已配置 API Key'; status.style.color='#4caf50'; }
        else { status.textContent='⚠️ 尚未配置 API Key'; status.style.color='#ff9800'; }
    }

    function onProviderChange() {
        const id = document.getElementById('settingsProvider').value;
        updateModelUI(id,'',settingsOllamaModels);
        updateEndpointHint(id);
        updateApiKeyStatus(id,settingsProviders);
    }

    function updateModelUI(providerId, currentModel, ollamaModels) {
        const provider = settingsProviders.find(p=>p.id===providerId);
        const modelSel = document.getElementById('settingsModelSelect');
        const modelInput = document.getElementById('settingsModelInput');
        const detectBtn = document.getElementById('detectBtn');
        const modelHint = document.getElementById('modelHint');
        if (providerId==='ollama') {
            document.getElementById('apiKeyGroup').style.display='none';
            if (ollamaModels&&ollamaModels.length>0) {
                modelSel.innerHTML=ollamaModels.map(m=>'<option value="'+escapeHtml(m.name)+'"'+(m.name===currentModel?' selected':'')+'>'+escapeHtml(m.name)+(m.parameterSize?' ('+m.parameterSize+')':'')+'</option>').join('');
                modelSel.style.display=''; modelInput.style.display='none';
                modelHint.textContent='已检测到 '+ollamaModels.length+' 个本地模型';
            } else { modelSel.style.display='none'; modelInput.style.display=''; detectBtn.style.display=''; modelInput.value=currentModel||''; modelHint.textContent='点击「检测」获取 Ollama 模型'; }
            detectBtn.style.display='';
        } else if (provider&&provider.models.length>0) {
            modelSel.innerHTML=provider.models.map(m=>'<option value="'+escapeHtml(m)+'"'+(m===currentModel?' selected':'')+'>'+escapeHtml(m)+'</option>').join('');
            if (!currentModel||!provider.models.includes(currentModel)) { modelSel.style.display='none'; modelInput.style.display=''; modelInput.value=currentModel||provider.defaultModel||''; modelHint.textContent='也可直接输入模型名称'; }
            else { modelSel.style.display=''; modelInput.style.display='none'; modelHint.textContent='或直接输入自定义模型名'; }
            detectBtn.style.display='none';
        } else { modelSel.style.display='none'; modelInput.style.display=''; detectBtn.style.display='none'; modelInput.value=currentModel||''; modelHint.textContent=''; }
        updateEndpointHint(providerId);
    }

    function updateEndpointHint(providerId) {
        const provider = settingsProviders.find(p=>p.id===providerId);
        const hint = document.getElementById('endpointHint');
        const ep = document.getElementById('settingsEndpoint');
        if (provider) { hint.textContent='默认: '+(provider.defaultEndpoint||'由 provider 决定'); if(!ep.value) ep.placeholder=provider.defaultEndpoint||'留空使用默认'; }
    }

    function onEndpointChange() {
        if (document.getElementById('settingsProvider').value==='ollama') {
            settingsOllamaModels=[];
            document.getElementById('settingsModelSelect').style.display='none';
            document.getElementById('settingsModelInput').style.display='';
            document.getElementById('modelHint').textContent='端点已更改，点击「检测」重新获取模型';
        }
    }

    function detectOllamaModels() {
        const btn=document.getElementById('detectBtn'); const ep=document.getElementById('settingsEndpoint').value.trim();
        btn.disabled=true; btn.textContent='检测中...';
        document.getElementById('modelHint').textContent='正在连接 Ollama...';
        vscode.postMessage({ type:'detectOllamaModels', endpoint: ep||'http://localhost:11434/v1' });
    }

    function getSelectedModel() {
        const sel=document.getElementById('settingsModelSelect'); const inp=document.getElementById('settingsModelInput');
        return sel.style.display!=='none'?sel.value:inp.value.trim();
    }

    function toggleAccordion(id) { document.getElementById(id).classList.toggle('open'); }

    function saveSettings() {
        vscode.postMessage({ type:'saveSettings', settings:{
            provider: document.getElementById('settingsProvider').value,
            model: getSelectedModel(),
            apiKey: document.getElementById('settingsApiKey').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            maxContextTokens: parseInt(document.getElementById('settingsCtx').value)||0,
            agentFileWriteMode: document.getElementById('agentWriteMode').value,
            inlineCompletion:{
                enabled: document.getElementById('inlineEnabled').checked,
                provider: document.getElementById('inlineProvider').value,
                model: document.getElementById('inlineModel').value.trim(),
                endpoint: document.getElementById('inlineEndpoint').value.trim(),
                debounceMs: parseInt(document.getElementById('inlineDebounce').value)||1500,
            },
        }});
    }

    function testConnection() {
        const tr = document.getElementById('testResult');
        tr.className='test-result'; tr.textContent='测试中...'; tr.style.display='block';
        vscode.postMessage({ type:'testConnection', settings:{
            provider: document.getElementById('settingsProvider').value,
            model: getSelectedModel(),
            apiKey: document.getElementById('settingsApiKey').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            maxContextTokens:0, agentFileWriteMode:'confirm',
            inlineCompletion:{enabled:false,provider:'',model:'',endpoint:'',debounceMs:1500},
        }});
    }
})();
