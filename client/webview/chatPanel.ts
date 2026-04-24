// @ts-nocheck  
(function () {
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

    // Custom absolute positioned dropdown logic
    function setupApDropdown(inputId, dropdownId, getOptions, onSelect) {
        const input = document.getElementById(inputId);
        const dropdown = document.getElementById(dropdownId);
        if (!input || !dropdown) return;

        function render(filter) {
            const term = (filter || '').toLowerCase();
            const opts = getOptions() || [];
            const html = opts.filter(m => m.toLowerCase().includes(term))
                .map(m => '<div class="ap-dropdown-item">' + escapeHtml(m) + '</div>').join('');
            dropdown.innerHTML = html;
            Array.from(dropdown.children).forEach(el => {
                el.onmousedown = (e) => {
                    e.preventDefault();
                    input.value = el.textContent;
                    dropdown.style.display = 'none';
                    if (onSelect) onSelect(input.value);
                };
            });
        }

        input.addEventListener('focus', () => { render(input.value); dropdown.style.display = 'block'; });
        input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 150); });
        input.addEventListener('input_ap', () => { render(input.value); });
        input.addEventListener('input', () => { render(input.value); });
    }

    /** Per-model context window sizes received from backend — used to auto-fill settingsCtx */
    let settingsModelContextTokens = {};
    /** Thinking model prefixes — these models are excluded from inline completion selectors */
    let settingsThinkingPrefixes = [];
    let totalConversationTokens = 0;
    let contextLimit = 128000;
    /** Pending images (base64 data URLs) to attach to next sent message */
    let pendingImages = [];
    /** Pending @-mentioned file paths to attach */
    let pendingFiles = [];
    /** Available workspace files received from host for @ popup */
    let workspaceFiles = [];

    // Notify host that WebView JS has fully loaded and is ready to receive messages
    vscode.postMessage({ type: 'ready' });

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

    bindBtn('btnNewTopic', () => vscode.postMessage({ type: 'newTopic' }));
    bindBtn('btnTopics', () => topicsPanel.classList.toggle('show'));
    bindBtn('btnNewTopicPanel', () => { vscode.postMessage({ type: 'newTopic' }); topicsPanel.classList.remove('show'); });
    bindBtn('btnSettings', () => vscode.postMessage({ type: 'openSettings' }));
    bindBtn('settingsBackBtn', closeSettings);
    bindBtn('testConnBtn', testConnection);
    bindBtn('saveSettingsBtn', saveSettings);
    bindBtn('keyToggleBtn', () => { const k = document.getElementById('settingsApiKey'); if (k) k.type = k.type === 'password' ? 'text' : 'password'; });
    bindBtn('fetchApiModelsBtn', () => { fetchApiModels(); });
    bindBtn('detectBtn', detectOllamaModels);
    bindBtn('accChat', () => toggleAccordion('chatModelSection'));
    bindBtn('accInline', () => toggleAccordion('inlineSection'));
    bindBtn('accMcp', () => toggleAccordion('mcpSection'));
    bindBtn('accAgent', () => toggleAccordion('agentSection'));
    bindBtn('addMcpServerBtn', () => addMcpServerBlock());
    bindBtn('accUsage', () => { toggleAccordion('usageSection'); vscode.postMessage({ type: 'requestUsageStats' }); });
    bindBtn('refreshUsageBtn', () => vscode.postMessage({ type: 'requestUsageStats' }));
    bindBtn('clearUsageBtn', () => {
        if (confirm('确定要清空所有 Token 消耗统计吗？此操作不可逆转。')) {
            vscode.postMessage({ type: 'clearUsageStats' });
        }
    });

    // ── Topic search (debounced 300ms) ─────────────────────────────────────────
    (() => {
        const si = document.getElementById('topicsSearch');
        if (!si) return;
        let _timer = null;
        si.addEventListener('input', () => {
            clearTimeout(_timer);
            _timer = setTimeout(() => {
                vscode.postMessage({ type: 'searchTopics', query: si.value.trim() });
            }, 300);
        });
        si.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                si.value = '';
                vscode.postMessage({ type: 'searchTopics', query: '' });
            }
        });
    })();

    // ── Export current topic as Markdown ───────────────────────────────────────
    bindBtn('btnExportTopic', () => {
        vscode.postMessage({ type: 'exportTopic', topicId: undefined });
        topicsPanel.classList.remove('show');
    });


    // ── Mode dropdown ──────────────────────────────────────────────────────────
    const modeSel = document.getElementById('modeSel');
    if (modeSel) {
        modeSel.addEventListener('change', () => {
            switchMode(modeSel.value, /* fromUI */ true);
        });
    }

    // ── Slash command popup ────────────────────────────────────────────────────
    const SLASH_COMMANDS = [
        { cmd: '/init', desc: '扫描项目，生成 CWTOOLS.md 规则文件（类 OpenCode /init）' },
        { cmd: '/clear', desc: '清空当前对话，开始新话题' },
        { cmd: '/fork', desc: '从当前位置分叉对话' },
        { cmd: '/archive', desc: '归档当前话题' },
        { cmd: '/mode:build', desc: '切换到 Build 模式（生成代码）' },
        { cmd: '/mode:plan', desc: '切换到 Plan 模式（只读规划）' },
        { cmd: '/mode:explore', desc: '切换到 Explore 模式（分析代码库）' },
        { cmd: '/mode:general', desc: '切换到 General 模式（通用问答）' },
        { cmd: '/mode:review', desc: '切换到 Review 模式（代码审查）' },
    ];
    const slashPopup = document.getElementById('slashPopup');

    function showSlashPopup(filter) {
        if (!slashPopup) return;
        const q = filter.toLowerCase();
        const matches = SLASH_COMMANDS.filter(c => c.cmd.includes(q));
        if (!matches.length) { slashPopup.classList.remove('show'); return; }
        slashPopup.innerHTML = matches.map(c =>
            `<div class="slash-popup-item" data-cmd="${c.cmd}"><span class="slash-popup-cmd">${c.cmd}</span><span class="slash-popup-desc">${c.desc}</span></div>`
        ).join('');
        slashPopup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('click', () => {
                const cmd = el.dataset.cmd;
                slashPopup.classList.remove('show');
                vscode.postMessage({ type: 'slashCommand', command: cmd });
                input.value = '';
                input.style.height = 'auto';
            });
        });
        slashPopup.classList.add('show');
    }

    input.addEventListener('input', () => {
        autoResizeInput();
        const v = input.value;
        if (v.startsWith('/') && v.length > 0) showSlashPopup(v);
        else slashPopup && slashPopup.classList.remove('show');
        // @ file mention: request file list on first @
        const atIdx = v.lastIndexOf('@');
        if (atIdx >= 0 && (atIdx === 0 || v[atIdx - 1] === ' ' || v[atIdx - 1] === '\n')) {
            const afterAt = v.slice(atIdx + 1);
            showAtPopup(afterAt);
        } else {
            closeAtPopup();
        }
    });
    document.addEventListener('click', e => { if (slashPopup && !slashPopup.contains(e.target) && e.target !== input) slashPopup.classList.remove('show'); });
    document.addEventListener('click', e => { if (!e.target.closest('#atPopup') && e.target !== input) closeAtPopup(); });
    input.addEventListener('keydown', e => {
        if (e.key === 'Escape' && slashPopup && slashPopup.classList.contains('show')) {
            e.stopPropagation();
            slashPopup.classList.remove('show');
        }
    });

    // ── @ file mention popup ───────────────────────────────────────────────────
    const atPopup = (() => {
        const el = document.createElement('div');
        el.id = 'atPopup';
        el.className = 'slash-popup'; // reuse slash-popup styles
        el.style.cssText = 'display:none;position:absolute;bottom:100%;left:0;right:0;max-height:200px;overflow-y:auto;z-index:200;';
        inputWrapper && inputWrapper.appendChild(el);
        return el;
    })();
    let _atPopupVisible = false;

    function showAtPopup(filter) {
        if (!atPopup) return;
        if (workspaceFiles.length === 0) {
            vscode.postMessage({ type: 'requestFileList' });
        }
        const q = filter.toLowerCase();
        const matches = workspaceFiles.filter(f => f.toLowerCase().includes(q)).slice(0, 15);
        if (!matches.length && filter.length === 0 && workspaceFiles.length === 0) {
            atPopup.style.display = 'none'; _atPopupVisible = false; return;
        }
        if (!matches.length && filter.length > 0) { atPopup.style.display = 'none'; _atPopupVisible = false; return; }
        atPopup.innerHTML = matches.map(f =>
            `<div class="slash-popup-item" data-file="${escapeHtml(f)}"><span class="slash-popup-cmd">@${escapeHtml(f.split('/').pop())}</span><span class="slash-popup-desc" style="opacity:0.5;font-size:10px">${escapeHtml(f)}</span></div>`
        ).join('');
        atPopup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('click', () => {
                const file = el.dataset.file;
                closeAtPopup();
                // Replace the @partial in input with @filename display
                const v = input.value;
                const atIdx = v.lastIndexOf('@');
                input.value = v.slice(0, atIdx) + '@' + file.split('/').pop() + ' ';
                // Track the actual full path
                if (!pendingFiles.includes(file)) pendingFiles.push(file);
                addFileBadge(file);
                autoResizeInput();
                input.focus();
            });
        });
        atPopup.style.display = 'block'; _atPopupVisible = true;
    }

    function closeAtPopup() { if (atPopup) { atPopup.style.display = 'none'; _atPopupVisible = false; } }

    function addFileBadge(file) {
        let area = document.getElementById('fileBadgeArea');
        if (!area) {
            area = document.createElement('div');
            area.id = 'fileBadgeArea';
            area.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:4px 8px 0;';
            inputWrapper && inputWrapper.insertBefore(area, inputWrapper.firstChild);
        }
        const badge = document.createElement('span');
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:rgba(100,120,255,0.15);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:11px;';
        badge.innerHTML = `📄 ${escapeHtml(file.split('/').pop())} <button style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:10px;" data-file="${escapeHtml(file)}">✕</button>`;
        badge.querySelector('button').addEventListener('click', () => {
            pendingFiles = pendingFiles.filter(f => f !== file);
            badge.remove();
        });
        area.appendChild(badge);
    }

    // ── Image compression helper ───────────────────────────────────────────────
    // Unifies all image input (paste / drag / file picker) to a clean JPEG data URL.
    // Max dimension: 1024px  |  JPEG quality: 0.85  |  Output: single-line string.
    // This ensures:
    //   • No base64 line-breaks that break Claude / GLM regex matching on the backend
    //   • Consistent "data:image/jpeg;base64,..." format accepted by all providers
    //   • Payload is always ≤ ~400 KB (well within postMessage limits)
    function compressImage(file, callback) {
        const reader = new FileReader();
        reader.onload = ev => {
            const original = ev.target && ev.target.result;
            if (typeof original !== 'string') return;
            const img = new Image();
            img.onload = () => {
                const MAX = 1024;
                let w = img.width, h = img.height;
                if (w > MAX || h > MAX) {
                    if (w >= h) { h = Math.round(h * MAX / w); w = MAX; }
                    else { w = Math.round(w * MAX / h); h = MAX; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                // toDataURL always returns a single-line string — no embedded newlines
                const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                callback(dataUrl);
            };
            img.onerror = () => callback(original); // fallback: use original if img fails
            img.src = original;
        };
        reader.onerror = () => { };  // silently ignore unreadable files
        reader.readAsDataURL(file);
    }

    // ── Image paste (Ctrl+V or paste event on input) ───────────────────────────
    // Supports multiple images per paste (no break limit)
    input.addEventListener('paste', e => {
        const items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (!blob) continue;
                compressImage(blob, dataUrl => {
                    pendingImages.push(dataUrl);
                    addImagePreview(dataUrl);
                });
            }
        }
    });

    // ── Drag-and-drop images onto input area ───────────────────────────────────
    inputWrapper && inputWrapper.addEventListener('dragover', e => {
        e.preventDefault();
        inputWrapper.classList.add('drag-over');
    });
    inputWrapper && inputWrapper.addEventListener('dragleave', () => {
        inputWrapper.classList.remove('drag-over');
    });
    inputWrapper && inputWrapper.addEventListener('drop', e => {
        e.preventDefault();
        inputWrapper.classList.remove('drag-over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        for (const file of files) {
            if (!file.type.startsWith('image/')) continue;
            compressImage(file, dataUrl => {
                pendingImages.push(dataUrl);
                addImagePreview(dataUrl);
            });
        }
    });

    // ── Image file-picker button ───────────────────────────────────────────────
    (() => {
        const imgPickBtn = document.getElementById('imgPickBtn');
        if (!imgPickBtn) return;
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = 'image/*';
        fileInput.multiple = true;
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);
        imgPickBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            for (const file of fileInput.files) {
                compressImage(file, dataUrl => {
                    pendingImages.push(dataUrl);
                    addImagePreview(dataUrl);
                });
            }
            fileInput.value = '';
        });
    })();

    // ── Lightbox for full-size image preview ───────────────────────────────────
    function showImageLightbox(dataUrl) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);';
        overlay.appendChild(img);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    function addImagePreview(dataUrl) {
        let area = document.getElementById('imagePreviewArea');
        if (!area) {
            area = document.createElement('div');
            area.id = 'imagePreviewArea';
            area.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:6px 8px 0;';
            inputWrapper && inputWrapper.insertBefore(area, inputWrapper.firstChild);
        }
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,0.1);cursor:zoom-in;transition:transform 0.15s;';
        img.title = '点击放大';
        img.addEventListener('click', () => showImageLightbox(dataUrl));
        img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.07)'; });
        img.addEventListener('mouseleave', () => { img.style.transform = ''; });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'position:absolute;top:-5px;right:-5px;width:16px;height:16px;border-radius:50%;background:#444;color:#fff;border:none;cursor:pointer;font-size:10px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;';
        del.addEventListener('click', () => {
            pendingImages = pendingImages.filter(u => u !== dataUrl);
            wrap.remove();
        });
        wrap.appendChild(img); wrap.appendChild(del);
        area.appendChild(wrap);
    }


    const providerSel = document.getElementById('settingsProvider');
    if (providerSel) providerSel.addEventListener('change', onProviderChange);
    const endpointInp = document.getElementById('settingsEndpoint');
    if (endpointInp) endpointInp.addEventListener('input', onEndpointChange);

    function sendMessage() {
        const text = input.value.trim();
        if (!text && pendingImages.length === 0) return;
        vscode.postMessage({
            type: 'sendMessage',
            text,
            images: pendingImages.length > 0 ? [...pendingImages] : undefined,
            attachedFiles: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
        });
        input.value = '';
        input.style.height = 'auto';
        stopPlaceholderRotation();
        // Clear image previews
        pendingImages = [];
        pendingFiles = [];
        const preview = document.getElementById('imagePreviewArea');
        if (preview) preview.innerHTML = '';
        // Clear @file badges
        const fileBadges = document.getElementById('fileBadgeArea');
        if (fileBadges) fileBadges.innerHTML = '';
    }

    const MODE_META = {
        build: { icon: '📝', label: null, bodyClass: null },
        plan: { icon: '📋', label: '📋 Plan Mode — 只读分析，不修改文件', bodyClass: 'plan-mode' },
        explore: { icon: '🔭', label: '🔭 Explore Mode — 探索代码库结构', bodyClass: 'explore-mode' },
        general: { icon: '💬', label: '💬 General Mode — 通用问答', bodyClass: 'general-mode' },
        review: { icon: '🔎', label: '🔎 Review Mode — 代码审查', bodyClass: 'review-mode' },
    };

    /**
     * switchMode(mode, fromUI)
     * fromUI=true  → user clicked dropdown → send message to backend + update UI
     * fromUI=false → backend sent modeChanged message → only update UI (no echo back)
     */
    function switchMode(mode, fromUI) {
        if (currentMode === mode && !fromUI) return; // avoid redundant update
        currentMode = mode;
        // Sync dropdown value without re-triggering change event
        const sel = document.getElementById('modeSel');
        if (sel && sel.value !== mode) sel.value = mode;
        // Only post to backend when user initiated (avoids ping-pong)
        if (fromUI) vscode.postMessage({ type: 'switchMode', mode });
        // Remove all mode body classes, add correct one
        document.body.classList.remove('plan-mode', 'explore-mode', 'general-mode');
        const meta = MODE_META[mode];
        if (meta && meta.bodyClass) document.body.classList.add(meta.bodyClass);
        // Update inline mode indicator text
        const ind = document.getElementById('modeIndicator');
        if (ind) ind.textContent = meta && meta.label ? meta.label : '';
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
        const bar = document.getElementById('tokenUsageBar');
        const fill = document.getElementById('tokenUsageFill');
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
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }

    // ── HTML escape ────────────────────────────────────────────────────────────
    function escapeHtml(t) {
        return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Markdown renderer ──────────────────────────────────────────────────────
    function inlineMd(raw) {
        let s = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const codeBlocks = [];
        s = s.replace(/`([^`]+)`/g, (_, c) => {
            codeBlocks.push('<code>' + c.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') + '</code>');
            return '\x01CODE' + (codeBlocks.length - 1) + '\x01';
        });
        s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|\W)__([^_\n]+)__(\W|$)/g, '$1<strong>$2</strong>$3');
        s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        s = s.replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3');
        s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        s = s.replace(/\x01CODE(\d+)\x01/g, (_, i) => codeBlocks[parseInt(i)]);
        return s;
    }

    function renderMarkdown(rawText) {
        if (!rawText) return '';

        // Phase 1: extract fenced code blocks to avoid mis-parsing their content
        const blocks = [];
        let text = rawText.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const i = blocks.length; blocks.push({ lang: lang.trim(), code }); return '\x00BLOCK' + i + '\x00';
        });

        // Phase 2: line-by-line state machine — correctly handles ## headings at any position
        const lines = text.split('\n');
        const out = [];
        let i = 0;

        function flushPara(paraLines) {
            if (!paraLines.length) return;
            const lineHtml = paraLines.map(line => {
                const t = line.trim();
                if (/^\x00BLOCK\d+\x00$/.test(t)) {
                    const { lang, code } = blocks[+t.match(/\d+/)[0]];
                    return '<div class="md-codeblock"><div class="md-codeblock-lang">' + escapeHtml(lang) + '</div><code>' + escapeHtml(code) + '</code></div>';
                }
                return inlineMd(line);
            });
            out.push('<p>' + lineHtml.join('<br>') + '</p>');
        }

        let paraLines = [];

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            // Empty line: flush current paragraph
            if (!trimmed) { flushPara(paraLines); paraLines = []; i++; continue; }

            // Fenced code block placeholder (standalone line)
            if (/^\x00BLOCK\d+\x00$/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                const { lang, code } = blocks[+trimmed.match(/\d+/)[0]];
                out.push('<div class="md-codeblock"><div class="md-codeblock-lang">' + escapeHtml(lang) + '</div><code>' + escapeHtml(code) + '</code></div>');
                i++; continue;
            }

            // ATX Heading — works at ANY line position (key fix: no lines.length===1 restriction)
            const hdm = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (hdm) {
                flushPara(paraLines); paraLines = [];
                const lv = hdm[1].length;
                out.push('<h' + lv + '>' + inlineMd(hdm[2]) + '</h' + lv + '>');
                i++; continue;
            }

            // Horizontal rule
            if (/^[-*_]{3,}$/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                out.push('<hr>'); i++; continue;
            }

            // Blockquote — collect consecutive > lines
            if (/^>/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                const bqLines = [];
                while (i < lines.length && /^>/.test(lines[i].trim())) {
                    bqLines.push(lines[i].replace(/^>\s?/, '')); i++;
                }
                out.push('<blockquote>' + renderMarkdown(bqLines.join('\n')) + '</blockquote>');
                continue;
            }

            // GFM Table — header row | separator row | data rows (all consecutive)
            if (/^\|/.test(trimmed) && i + 1 < lines.length && /^[\|\s:-]+$/.test(lines[i + 1].trim())) {
                flushPara(paraLines); paraLines = [];
                const tblLines = [];
                while (i < lines.length && /^\|/.test(lines[i].trim())) { tblLines.push(lines[i]); i++; }
                if (tblLines.length >= 2) {
                    const headers = tblLines[0].split('|').map(c => c.trim()).filter(Boolean);
                    const rows = tblLines.slice(2).map(r => r.split('|').map(c => c.trim()).filter(Boolean));
                    let tbl = '<table><thead><tr>' + headers.map(h => '<th>' + inlineMd(h) + '</th>').join('') + '</tr></thead><tbody>';
                    rows.forEach(r => { tbl += '<tr>' + r.map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>'; });
                    out.push(tbl + '</tbody></table>');
                }
                continue;
            }

            // Unordered list — collect consecutive list items
            if (/^[-*+]\s/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                const items = []; let cur = null;
                while (i < lines.length) {
                    const ll = lines[i], lt = ll.trim();
                    if (!lt) { i++; break; }
                    const mm = lt.match(/^[-*+]\s+(.+)/);
                    if (mm) { if (cur !== null) items.push(cur); cur = mm[1]; i++; }
                    else if (cur !== null && /^\s{2,}/.test(ll)) { cur += ' ' + lt; i++; }
                    else break;
                }
                if (cur !== null) items.push(cur);
                out.push('<ul>' + items.map(it => '<li>' + inlineMd(it) + '</li>').join('') + '</ul>');
                continue;
            }

            // Ordered list — collect consecutive numbered items
            if (/^\d+\.\s/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                const items = []; let cur = null;
                while (i < lines.length) {
                    const ll = lines[i], lt = ll.trim();
                    if (!lt) { i++; break; }
                    const mm = lt.match(/^\d+\.\s+(.+)/);
                    if (mm) { if (cur !== null) items.push(cur); cur = mm[1]; i++; }
                    else if (cur !== null && /^\s{2,}/.test(ll)) { cur += ' ' + lt; i++; }
                    else break;
                }
                if (cur !== null) items.push(cur);
                out.push('<ol>' + items.map(it => '<li>' + inlineMd(it) + '</li>').join('') + '</ol>');
                continue;
            }

            // Default: accumulate into paragraph
            paraLines.push(line); i++;
        }

        flushPara(paraLines);
        return out.join('');
    }

    function scrollBottom() { chatArea.scrollTop = chatArea.scrollHeight; }

    // ── OpenCode-style step rendering ─────────────────────────────────────────
    // Tool step icons — minimal, professional
    const TOOL_ICONS = {
        read_file: '📄', write_file: '💾', edit_file: '✏️',
        list_directory: '📁', search_mod_files: '🔍', validate_code: '✅',
        get_file_context: '📄', get_diagnostics: '🩺', get_completion_at: '💡',
        document_symbols: '🔖', workspace_symbols: '🔖', query_scope: '🔭',
        query_types: '📐', query_rules: '📏', query_references: '🔗', todo_write: '📋',
    };
    const WRITE_TOOL_NAMES = new Set(['edit_file', 'write_file', 'read_file', 'delete_file']);

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
                const added = r.stats ? r.stats.linesAdded || 0 : 0;
                const removed = r.stats ? r.stats.linesRemoved || 0 : 0;
                const diffStr = (added || removed) ? ` +${added}/-${removed}` : '';
                resultHtml = `<div class="tp-result ok">✓${escapeHtml(diffStr)}</div>`;
            } else if (r && r.success === false) {
                resultHtml = `<div class="tp-result err">✗ ${escapeHtml(r.message || r.error || '')}</div>`;
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

            // 2.5 Text Delta block (raw streaming chunks)
            const textDeltaSteps = steps.filter(s => s.type === 'text_delta');
            if (textDeltaSteps.length > 0) {
                const textDeltaContent = textDeltaSteps.map(s => s.content || '').join('').trim();
                if (textDeltaContent) {
                    const det = document.createElement('details');
                    det.className = 'thinking-block';
                    const sum = document.createElement('summary');
                    sum.innerHTML = '<span class="think-pulse" style="background:#5da2ff"></span>Text_Delta · ' + textDeltaSteps.length + ' chunks';
                    det.appendChild(sum);
                    const body = document.createElement('div');
                    body.className = 'thinking-body';
                    body.style.whiteSpace = 'pre-wrap';
                    body.style.fontFamily = 'var(--vscode-editor-font-family)';
                    body.textContent = textDeltaContent;
                    det.appendChild(body);
                    div.appendChild(det);
                }
            }

            // Also show non-tool, non-thinking special steps (errors, compaction, etc.)
            const specialSteps = steps.filter(s =>
                s.type !== 'tool_call' && s.type !== 'tool_result' &&
                s.type !== 'thinking_content' && s.type !== 'thinking' &&
                s.type !== 'text_delta'
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

    // ── Streaming text-delta live bubble ──────────────────────────────────────
    let liveTextBubble = null;
    let liveTextContent = '';

    function ensureLiveTextBubble() {
        if (!currentAssistantDiv) return null;
        if (!liveTextBubble) {
            liveTextBubble = document.createElement('div');
            liveTextBubble.className = 'msg-bubble stream-cursor';
            currentAssistantDiv.appendChild(liveTextBubble);
        }
        return liveTextBubble;
    }

    function flushLiveText() {
        if (liveTextBubble) {
            liveTextBubble.classList.remove('stream-cursor');
            liveTextBubble.innerHTML = renderMarkdown(liveTextContent);
        }
        liveTextBubble = null;
        liveTextContent = '';
    }

    function applyLiveStep(s) {
        if (!currentAssistantDiv) return;

        // ── text_delta: streaming token ────────────────────────────────────────
        if (s.type === 'text_delta') {
            const bubble = ensureLiveTextBubble();
            if (bubble) {
                liveTextContent += s.content || '';
                // Show raw text with cursor while streaming (fast path, no markdown parse)
                bubble.textContent = liveTextContent;
            }
            scrollBottom();
            return;
        }

        // Non-text-delta: flush any pending streaming text first
        if (liveTextContent) flushLiveText();

        if (s.type === 'thinking_content' || s.type === 'thinking') {
            const tb = document.getElementById('liveThink');
            const tbd = document.getElementById('liveThinkBody');
            const tsum = document.getElementById('liveThinkSum');
            if (tb) tb.style.display = '';
            if (tbd) {
                // Append: use separator only for distinct reasoning blocks (type='thinking'),
                // streaming delta tokens (type='thinking_content') are appended directly
                if (s.type === 'thinking' && tbd.textContent) {
                    tbd.textContent += '\n\n---\n\n' + (s.content || '');
                } else {
                    tbd.textContent += (s.content || '');
                }
                if (tsum) {
                    const est = Math.ceil(tbd.textContent.length / 4);
                    tsum.innerHTML = '<span class="think-pulse spinning"></span>Thinking &nbsp;<span class="think-tokens">~' + formatNum(est) + ' tokens</span>';
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
    // Builds inline image thumbnails (clickable lightbox) from images array
    function buildImageRow(images) {
        if (!images || !images.length) return null;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;';
        for (const src of images) {
            const img = document.createElement('img');
            img.src = src;
            img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,0.12);cursor:zoom-in;transition:transform 0.15s;';
            img.title = '点击放大';
            img.addEventListener('click', () => showImageLightbox(src));
            img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.07)'; });
            img.addEventListener('mouseleave', () => { img.style.transform = ''; });
            row.appendChild(img);
        }
        return row;
    }

    function addUserMessage(text, msgIdx, images) {
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

        // M6 fix: display image thumbnails from the actual images array
        const imgRow = buildImageRow(images);
        if (imgRow) bubble.appendChild(imgRow);

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
            '<div class="retract-confirm-hint">这将同时撤回后续的 AI 回复，并恢复所有被 AI 修改或创建的文件</div>' +

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

    // ── Card dismiss helper ────────────────────────────────────────────────────
    function dismissCard(el, delay) {
        setTimeout(() => {
            el.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            el.style.opacity = '0';
            el.style.transform = 'translateY(-4px)';
            setTimeout(() => el.remove(), 260);
        }, delay || 400);
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
            dismissCard(div, 400);
        });
        card.querySelector('.diff-reject-btn').addEventListener('click', function () {
            this.disabled = true; card.querySelector('.diff-accept-btn').disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
            dismissCard(div, 400);
        });
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Permission request card ─────────────────────────────────────────────────
    function showPermissionCard(permissionId, tool, description, command) {
        const div = document.createElement('div');
        div.className = 'permission-card';
        div.dataset.permId = permissionId;
        const safeId = escapeHtml(permissionId);
        div.innerHTML =
            `<div class="permission-card-header">` +
            `<span class="permission-card-icon">🔑</span>` +
            `<div class="permission-card-body">` +
            `<div class="permission-card-title">${escapeHtml(description)}</div>` +
            (command ? `<div class="permission-card-cmd">${escapeHtml(command)}</div>` : '') +
            `</div></div>` +
            `<div class="permission-card-actions">` +
            `<button class="permission-allow-btn" data-permid="${safeId}">✅ 允许</button>` +
            `<button class="permission-deny-btn" data-permid="${safeId}">❌ 拒绝</button>` +
            `</div>`;
        div.querySelector('.permission-allow-btn').addEventListener('click', function () {
            this.disabled = true; div.querySelector('.permission-deny-btn').disabled = true;
            this.textContent = '已允许 ✅';
            vscode.postMessage({ type: 'permissionResponse', permissionId, allowed: true });
            dismissCard(div, 400);
        });
        div.querySelector('.permission-deny-btn').addEventListener('click', function () {
            this.disabled = true; div.querySelector('.permission-allow-btn').disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'permissionResponse', permissionId, allowed: false });
            dismissCard(div, 400);
        });
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Message handler ────────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {

            case 'addUserMessage':
                setGenerating(true);
                liveTextBubble = null; liveTextContent = '';
                addUserMessage(msg.text, msg.messageIndex, msg.images);
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom();
                break;

            case 'agentStep':
                applyLiveStep(msg.step);
                break;

            case 'generationComplete': {
                setGenerating(false);
                flushLiveText();
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                
                // Clear any unresolved interactive cards (permission, diff)
                document.querySelectorAll('.permission-card, .diff-card').forEach(el => dismissCard(el, 0));

                const r = msg.result;
                const completedMsg = buildAssistantMessage(
                    r.explanation || (r.steps && r.steps.length ? '' : '完成'),
                    r.steps,
                    formatTime(Date.now())
                );
                chatArea.appendChild(completedMsg);
                // Use real tokenUsage from result if available, else fall back to rough estimate
                if (r.tokenUsage && r.tokenUsage.total > 0) {
                    totalConversationTokens = r.tokenUsage.total;
                    updateTokenUsage(r.tokenUsage.total, contextLimit);
                    // Show cost badge
                    const label = document.getElementById('tokenUsageLabel');
                    if (label && r.tokenUsage.estimatedCostUsd > 0) {
                        const cost = r.tokenUsage.estimatedCostUsd < 0.001
                            ? '<$0.001'
                            : '$' + r.tokenUsage.estimatedCostUsd.toFixed(4);
                        label.textContent = label.textContent + '  ·  ' + cost;
                    }
                } else {
                    // Rough estimate fallback (no API usage data)
                    const stepTokens = r.steps ? r.steps.reduce((sum, s) => {
                        if (s.type === 'thinking_content' || s.type === 'thinking')
                            return sum + Math.ceil((s.content || '').length / 4);
                        return sum;
                    }, 0) : 0;
                    totalConversationTokens += Math.ceil((r.explanation || '').length / 4) + stepTokens + 500;
                    updateTokenUsage(totalConversationTokens, contextLimit);
                }
                scrollBottom();
                break;
            }

            case 'generationError':
                setGenerating(false);
                liveTextBubble = null; liveTextContent = '';
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                
                // Clear any unresolved interactive cards
                document.querySelectorAll('.permission-card, .diff-card').forEach(el => dismissCard(el, 0));

                chatArea.appendChild(buildAssistantMessage('❌ ' + msg.error, [], formatTime(Date.now())));
                scrollBottom();
                break;

            case 'clearChat':
                while (chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                setGenerating(false);
                currentAssistantDiv = null;
                liveTextBubble = null; liveTextContent = '';
                totalConversationTokens = 0;
                { const bar = document.getElementById('tokenUsageBar'); if (bar) bar.style.display = 'none'; }
                startPlaceholderRotation();
                break;

            case 'topicList': renderTopics(msg.topics); break;

            case 'fileList':
                // Cache workspace files for @ mention popup
                workspaceFiles = msg.files || [];
                // If @ popup is open, refresh it
                if (_atPopupVisible) {
                    const v = input.value;
                    const atIdx = v.lastIndexOf('@');
                    if (atIdx >= 0) showAtPopup(v.slice(atIdx + 1));
                }
                break;

            case 'topicTitleGenerated': {
                const list = document.getElementById('topicsList');
                if (list) {
                    for (const item of list.querySelectorAll(`.topic-item[data-topic-id="${escapeHtml(msg.topicId)}"]`)) {
                        const span = item.querySelector('.topic-title');
                        if (span) span.textContent = msg.title;
                    }
                }
                break;
            }

            case 'topicForked': {
                // Close the topics panel and show a notification
                topicsPanel.classList.remove('show');
                const notif = document.createElement('div');
                notif.className = 'special-step';
                notif.style.cssText = 'padding:6px 0;opacity:0.6;font-size:11px;';
                notif.textContent = `🔀 已从此处分叉为新话题: ${msg.title}`;
                chatArea.appendChild(notif);
                scrollBottom();
                break;
            }

            case 'loadTopicMessages':
                for (const m of msg.messages) {
                    // M4 fix: pass images array when restoring user messages from history
                    if (m.role === 'user') addUserMessage(m.content, undefined, m.images);
                    else { chatArea.appendChild(buildAssistantMessage(m.content, m.steps, '')); scrollBottom(); }
                }
                break;

            case 'messageRetracted': {
                // Find the retracted message element and remove it plus ALL subsequent siblings
                const rd = messageIndexMap.get(msg.messageIndex);
                if (rd) {
                    // Collect all nodes from rd onwards (inclusive) and remove them
                    const toRemove = [];
                    let cur = rd;
                    while (cur) {
                        toRemove.push(cur);
                        cur = cur.nextElementSibling;
                    }
                    for (const el of toRemove) el.remove();
                }
                // Clear all messageIndexMap entries whose index >= retracted index
                for (const [idx] of messageIndexMap) {
                    if (idx >= msg.messageIndex) messageIndexMap.delete(idx);
                }
                break;
            }

            case 'pendingWriteFile': showPendingWriteCard(msg.file, msg.messageId, msg.isNewFile); break;

            case 'permissionRequest':
                showPermissionCard(msg.permissionId, msg.tool, msg.description, msg.command);
                break;

            case 'modeChanged':
                switchMode(msg.mode, /* fromUI */ false);
                break;

            case 'setMode':
                // Restore mode selector state after panel rebuild (no backend call needed)
                switchMode(msg.mode, /* fromUI */ false);
                break;

            case 'replaySteps': {
                // Panel was hidden while AI was running — replay accumulated steps
                // Show a banner so user knows the AI is/was running in the background
                const banner = document.createElement('div');
                banner.className = 'special-step';
                banner.style.cssText = 'padding:6px 8px;background:rgba(255,200,50,0.08);border-left:2px solid #ffc832;font-size:11px;opacity:0.8;margin:4px 0;';
                banner.textContent = msg.isGenerating
                    ? '⚡ AI 正在后台运行（面板重新打开时恢复显示）'
                    : '📋 以下为 AI 上次运行记录';
                chatArea.appendChild(banner);
                // Replay each step
                for (const step of msg.steps) {
                    applyLiveStep(step);
                }
                if (msg.isGenerating) {
                    // Show generating indicator
                    sendBtn.classList.add('cancel-mode');
                    sendBtn.querySelector('.send-icon') && (sendBtn.querySelector('.send-icon').style.display = 'none');
                    sendBtn.querySelector('.stop-icon') && (sendBtn.querySelector('.stop-icon').style.display = 'inline-block');
                }
                scrollBottom();
                break;
            }

            case 'todoUpdate': renderTodos(msg.todos); break;

            case 'settingsData':
                if (msg.current && msg.current.maxContextTokens > 0) contextLimit = msg.current.maxContextTokens;
                // Cache model context token map for use in updateModelUI
                if (msg.modelContextTokens) settingsModelContextTokens = msg.modelContextTokens;
                if (msg.thinkingModelPrefixes) settingsThinkingPrefixes = msg.thinkingModelPrefixes;
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
            case 'apiModelsFetched': {
                const fb = document.getElementById('fetchApiModelsBtn');
                if (fb) { fb.disabled = false; fb.textContent = '☁️ 拉取支持的模型'; }
                if (msg.error) { document.getElementById('apiKeyStatus').textContent = '获取失败: ' + msg.error; document.getElementById('apiKeyStatus').style.color = '#ff9800'; }
                else {
                    const p = settingsProviders.find(p => p.id === msg.providerId);
                    if (p && msg.models && msg.models.length > 0) {
                        const newModels = msg.models.map(m => m.id);
                        for (const m of newModels) {
                            if (!p.models.includes(m)) p.models.push(m);
                        }
                        if (msg.dynContexts) {
                            Object.assign(settingsModelContextTokens, msg.dynContexts);
                        }
                        updateModelUI(msg.providerId, getSelectedModel(), null);
                        const ctxInfo = msg.ctxNote ? ` ${msg.ctxNote}` : '';
                        document.getElementById('modelHint').textContent = `成功从端点加载了 ${newModels.length} 个模型！${ctxInfo}`;
                        document.getElementById('apiKeyStatus').textContent = '✅ 已成功获取模型';
                        document.getElementById('apiKeyStatus').style.color = '#4caf50';
                    }
                }
                break;
            }
            case 'testConnectionResult': {
                const tr = document.getElementById('testResult');
                tr.className = 'test-result ' + (msg.ok ? 'ok' : 'fail');
                tr.textContent = msg.message;
                break;
            }
            case 'usageStats': {
                const stats = msg.stats;
                const c = document.getElementById('usageStatsContent');
                if (!c) break;

                if (!stats || stats.totalTokens === 0) {
                    c.innerHTML = '<div style="opacity:0.6; text-align:center; padding: 10px;">暂无 Token 消耗数据</div>';
                    break;
                }

                let html = '';

                // ── Summary ──
                html += `<div style="margin-bottom: 10px; font-weight: 600; font-size: 13px;">
                    总计消耗: <span style="color:var(--accent);">${stats.totalTokens.toLocaleString()}</span> tokens<br>
                    预估成本: <span style="color:#4caf50;">$${typeof stats.totalCostUsd === 'number' ? stats.totalCostUsd.toFixed(4) : '0.0000'}</span><br>
                    <span style="font-size:11px; opacity:0.6;">共 ${stats.totalCalls ?? 0} 次调用</span>
                </div>`;

                // ── Provider breakdown ──
                html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                html += '<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">按 Provider</div>';
                for (const [providerId, pStats] of Object.entries(stats.byProvider || {})) {
                    html += `<div style="display:flex; justify-content:space-between; margin-bottom: 3px;">
                                <span style="opacity:0.8;">${providerId}</span>
                                <span><b>${(pStats as any).tokens.toLocaleString()}</b> <span style="opacity:0.5; font-size:10px;">($${typeof (pStats as any).costUsd === 'number' ? (pStats as any).costUsd.toFixed(4) : '0.0000'})</span></span>
                             </div>`;
                }
                html += '</div>';

                // ── Model distribution ──
                if (stats.modelDistribution && stats.modelDistribution.length > 0) {
                    html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                    html += '<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">模型分布</div>';
                    for (const m of stats.modelDistribution) {
                        const barWidth = Math.max(2, m.percentage);
                        const shortModel = m.model.length > 24 ? m.model.slice(0, 22) + '…' : m.model;
                        html += `<div style="margin-bottom: 5px;">
                            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:2px;">
                                <span title="${m.model}" style="opacity:0.85;">${shortModel}</span>
                                <span style="opacity:0.6;">${m.percentage}% · ${m.callCount} 次</span>
                            </div>
                            <div style="background:var(--border); border-radius:3px; height:6px; overflow:hidden;">
                                <div style="width:${barWidth}%; height:100%; background:var(--accent); border-radius:3px; transition:width 0.3s;"></div>
                            </div>
                        </div>`;
                    }
                    html += '</div>';
                }

                // ── Daily trend (last 14 days) ──
                if (stats.dailyStats && stats.dailyStats.length > 0) {
                    const recent = stats.dailyStats.slice(0, 14);
                    const maxTokens = Math.max(...recent.map(d => d.tokens), 1);
                    html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px;">';
                    html += '<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">近期趋势 (每日)</div>';
                    html += '<div style="display:flex; justify-content:flex-end; align-items:flex-end; gap:4px; height:60px;">';
                    // Show in chronological order (reverse since dailyStats is desc)
                    for (const d of [...recent].reverse()) {
                        const h = Math.max(3, Math.round((d.tokens / maxTokens) * 56));
                        const dayLabel = d.date.slice(5); // MM-DD
                        html += `<div title="${d.date}: ${d.tokens.toLocaleString()} tokens, ${d.callCount} 次调用, $${d.costUsd.toFixed(4)}" style="flex:1; min-width:12px; max-width:28px;">
                            <div style="background:var(--accent); opacity:0.7; height:${h}px; border-radius:2px 2px 0 0;"></div>
                            <div style="font-size:7px; text-align:center; opacity:0.4; margin-top:1px; overflow:hidden; white-space:nowrap;">${dayLabel}</div>
                        </div>`;
                    }
                    html += '</div></div>';
                }

                c.innerHTML = html;
                break;
            }

            case 'planFileSaved': {
                // Compact card — just "open file" button; annotation is handled by renderPlan below
                const card = document.createElement('div');
                card.className = 'plan-file-card';
                card.innerHTML = `
                    <div class="plan-file-icon">📋</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">计划已导出</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                    </div>
                    <div class="plan-file-actions">
                        <button class="plan-open-btn" data-path="${escapeHtml(msg.filePath)}">📂 打开文件</button>
                    </div>`;
                card.querySelector('.plan-open-btn').addEventListener('click', e => {
                    vscode.postMessage({ type: 'openPlanFile', filePath: e.currentTarget.dataset.path });
                });
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'renderPlan': {
                // ── Interactive inline annotation view ──────────────────────────
                const annotations = [];   // { sectionIdx, section, note }

                const wrap = document.createElement('div');
                wrap.className = 'annotatable-plan';

                // Header row
                const header = document.createElement('div');
                header.className = 'ap-header';
                header.innerHTML = `<span class="ap-header-title">✏️ 在线批注</span>
                    <span class="ap-header-hint">点击段落添加批注</span>
                    <button class="ap-submit-btn" disabled>📤 提交批注 (0)</button>`;
                wrap.appendChild(header);

                const submitBtn = header.querySelector('.ap-submit-btn');

                function updateSubmitBtn() {
                    submitBtn.textContent = `📤 提交批注 (${annotations.length})`;
                    submitBtn.disabled = annotations.length === 0;
                }

                submitBtn.addEventListener('click', () => {
                    if (annotations.length === 0) return;
                    vscode.postMessage({
                        type: 'submitPlanAnnotations',
                        annotations: annotations.map(a => ({ section: a.section, note: a.note }))
                    });
                    // Visual feedback
                    submitBtn.textContent = '✅ 已提交';
                    submitBtn.disabled = true;
                });

                // Sections
                const sectionsWrap = document.createElement('div');
                sectionsWrap.className = 'ap-sections';

                msg.sections.forEach((section, idx) => {
                    const row = document.createElement('div');
                    row.className = 'ap-row';
                    row.dataset.idx = idx;

                    // Section text (rendered as simple markdown-lite)
                    const textDiv = document.createElement('div');
                    textDiv.className = 'ap-section-text';
                    // Basic heading/bold rendering
                    const html = section
                        .replace(/^(#{1,3})\s+(.+)$/m, (_, hashes, text) =>
                            `<strong class="ap-heading ap-h${hashes.length}">${escapeHtml(text)}</strong>`)
                        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                        .replace(/`(.+?)`/g, '<code>$1</code>')
                        .replace(/\n/g, '<br>');
                    textDiv.innerHTML = html === section ? escapeHtml(section).replace(/\n/g, '<br>') : html;

                    // Add-comment button (shows on hover)
                    const addBtn = document.createElement('button');
                    addBtn.className = 'ap-add-btn';
                    addBtn.title = '添加批注';
                    addBtn.textContent = '💬';

                    // Annotation bubble (hidden until annotated)
                    const bubble = document.createElement('div');
                    bubble.className = 'ap-bubble';
                    bubble.style.display = 'none';

                    // Inline input box (hidden until add-btn clicked)
                    const inputBox = document.createElement('div');
                    inputBox.className = 'ap-input-box';
                    inputBox.style.display = 'none';
                    inputBox.innerHTML = `
                        <textarea class="ap-textarea" rows="3" placeholder="输入批注内容…"></textarea>
                        <div class="ap-input-actions">
                            <button class="ap-confirm-btn">确定</button>
                            <button class="ap-cancel-btn">取消</button>
                        </div>`;

                    function openInput() {
                        const existingEntry = annotations.find(a => a.sectionIdx === idx);
                        const ta = inputBox.querySelector('.ap-textarea');
                        ta.value = existingEntry ? existingEntry.note : '';
                        inputBox.style.display = 'block';
                        ta.focus();
                        row.classList.add('ap-row-active');
                    }

                    function closeInput() {
                        inputBox.style.display = 'none';
                        row.classList.remove('ap-row-active');
                    }

                    function confirmAnnotation() {
                        const val = inputBox.querySelector('.ap-textarea').value.trim();
                        closeInput();
                        if (!val) {
                            // Remove annotation if cleared
                            const i = annotations.findIndex(a => a.sectionIdx === idx);
                            if (i >= 0) annotations.splice(i, 1);
                            bubble.style.display = 'none';
                            row.classList.remove('ap-row-annotated');
                        } else {
                            const existing = annotations.find(a => a.sectionIdx === idx);
                            if (existing) existing.note = val;
                            else annotations.push({ sectionIdx: idx, section, note: val });
                            bubble.innerHTML = `<span class="ap-bubble-icon">💬</span><span class="ap-bubble-text">${escapeHtml(val)}</span><button class="ap-bubble-edit">编辑</button>`;
                            bubble.querySelector('.ap-bubble-edit').addEventListener('click', e => {
                                e.stopPropagation(); openInput();
                            });
                            bubble.style.display = 'flex';
                            row.classList.add('ap-row-annotated');
                        }
                        updateSubmitBtn();
                    }

                    addBtn.addEventListener('click', e => { e.stopPropagation(); openInput(); });
                    row.addEventListener('click', () => {
                        if (inputBox.style.display === 'none') openInput();
                    });
                    inputBox.querySelector('.ap-confirm-btn').addEventListener('click', confirmAnnotation);
                    inputBox.querySelector('.ap-cancel-btn').addEventListener('click', closeInput);
                    inputBox.querySelector('.ap-textarea').addEventListener('keydown', e => {
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmAnnotation();
                        if (e.key === 'Escape') closeInput();
                    });
                    // Prevent row click from triggering when clicking inside input
                    inputBox.addEventListener('click', e => e.stopPropagation());

                    row.appendChild(textDiv);
                    row.appendChild(addBtn);
                    row.appendChild(bubble);
                    row.appendChild(inputBox);
                    sectionsWrap.appendChild(row);
                });

                wrap.appendChild(sectionsWrap);
                chatArea.appendChild(wrap);
                scrollBottom();
                break;
            }

            case 'tokenUsage': {
                // Override/supplement with actual counted tokens from the API
                // This fires AFTER generationComplete (for plan mode) or may duplicate normal mode;
                // only update if we don't already have real data (avoid double-counting).
                const u = msg.usage;
                if (u && u.total > 0) {
                    totalConversationTokens = u.total;
                    updateTokenUsage(u.total, contextLimit);
                    // Completely replace the label with token + cost info
                    const label = document.getElementById('tokenUsageLabel');
                    if (label) {
                        const base = `~${formatNum(u.total)} / ${formatNum(contextLimit)} tokens`;
                        const cost = u.estimatedCostUsd > 0
                            ? '  ·  ' + (u.estimatedCostUsd < 0.001 ? '<$0.001' : '$' + u.estimatedCostUsd.toFixed(4))
                            : '';
                        label.textContent = base + cost;
                    }
                }
                break;
            }

            case 'topicSearchResults': {
                const list = document.getElementById('topicsList');
                if (!list) break;
                if (!msg.results || msg.results.length === 0) {
                    list.innerHTML = '<div style="padding:12px 8px;opacity:0.5;font-size:11px;text-align:center;">无匹配结果</div>';
                    break;
                }
                list.innerHTML = msg.results.map(t =>
                    `<div class="topic-item" data-topic-id="${escapeHtml(t.id)}" onclick="this.dispatchEvent(new CustomEvent('topic-click',{bubbles:true,detail:'${escapeHtml(t.id)}'}))">
                        <span class="topic-title">${escapeHtml(t.title)}</span>
                        <span class="topic-date" style="font-size:10px;opacity:0.5">${new Date(t.updatedAt).toLocaleDateString('zh-CN')}</span>
                    </div>`
                ).join('');
                // Re-attach click handlers
                list.querySelectorAll('.topic-item').forEach(el => {
                    el.addEventListener('click', () => {
                        vscode.postMessage({ type: 'loadTopic', topicId: el.dataset.topicId });
                        topicsPanel.classList.remove('show');
                    });
                });
                break;
            }
        }
    });

    // ── Topic list with date groups ────────────────────────────────────────────
    function groupTopicsByDate(topics) {
        const now = Date.now(); const DAY = 86400000;
        const groups = [{ label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '本周', items: [] }, { label: '更早', items: [] }];
        for (const t of topics) {
            const age = now - (t.updatedAt || 0);
            if (age < DAY) groups[0].items.push(t);
            else if (age < DAY * 2) groups[1].items.push(t);
            else if (age < DAY * 7) groups[2].items.push(t);
            else groups[3].items.push(t);
        }
        return groups.filter(g => g.items.length > 0);
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
                // Action buttons: fork, archive, delete
                const actions = document.createElement('div'); actions.className = 'topic-actions';
                const forkBtn = document.createElement('button');
                forkBtn.className = 'topic-action-btn topic-fork-btn'; forkBtn.textContent = '⑂'; forkBtn.title = '分叉话题';
                forkBtn.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'forkTopic', topicId: t.id, messageIndex: 999 }); });
                const archBtn = document.createElement('button');
                archBtn.className = 'topic-action-btn topic-archive-btn'; archBtn.textContent = '📦'; archBtn.title = '归档';
                archBtn.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'archiveTopic', topicId: t.id }); });
                const del = document.createElement('button');
                del.className = 'topic-action-btn topic-delete'; del.textContent = '✕'; del.title = '删除';
                del.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'deleteTopic', topicId: t.id }); });
                actions.appendChild(forkBtn); actions.appendChild(archBtn); actions.appendChild(del);
                item.appendChild(title); item.appendChild(actions);
                item.addEventListener('click', () => { vscode.postMessage({ type: 'loadTopic', topicId: t.id }); topicsPanel.classList.remove('show'); });
                list.appendChild(item);
            }
        }
    }

    function renderTodos(todos) {
        if (!todos || !todos.length) { todoPanel.classList.remove('has-items'); document.getElementById('todoList').innerHTML = ''; return; }
        todoPanel.classList.add('has-items');
        const icons = { pending: '○', in_progress: '●', done: '✓' };
        document.getElementById('todoList').innerHTML = todos.map(t => {
            const cls = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in_progress' : '';
            return '<div class="todo-item ' + cls + '"><span>' + (icons[t.status] || '○') + '</span>' + escapeHtml(t.content) + '</div>';
        }).join('');
    }

    function updateQuickModelSelector(providers, current, ollamaModels) {
        const qms = document.getElementById('quickModelSelect');
        if (!qms) return;
        const provider = providers.find(p => p.id === current.provider);
        const models = current.provider === 'ollama' ? (ollamaModels || []).map(m => m.name) : (provider ? provider.models : []);
        qms.innerHTML = '';
        if (models.length > 0) {
            for (const m of models) { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; opt.selected = m === current.model; qms.appendChild(opt); }
        } else { const opt = document.createElement('option'); opt.value = current.model || ''; opt.textContent = current.model || '(未设置)'; qms.appendChild(opt); }
    }

    function showSettingsPage(providers, current, ollamaModels) {
        settingsProviders = providers;
        settingsOllamaModels = ollamaModels || [];
        updateQuickModelSelector(providers, current, ollamaModels);
        const sel = document.getElementById('settingsProvider');
        sel.innerHTML = providers.map(p => '<option value="' + p.id + '"' + (p.id === current.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        const inlineSel = document.getElementById('inlineProvider');
        inlineSel.innerHTML = '<option value="">- 与对话相同 -</option>' + providers.map(p => '<option value="' + p.id + '"' + (p.id === current.inlineCompletion?.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        document.getElementById('settingsApiKey').value = '';
        document.getElementById('settingsEndpoint').value = current.endpoint || '';
        // Auto-fill context size: prefer per-model lookup, then user-saved value
        const initCtx = autoFillContextForModel(current.model, current.provider) || current.maxContextTokens || 0;
        document.getElementById('settingsCtx').value = initCtx;
        document.getElementById('settingsReasoningEffort').value = current.reasoningEffort || 'high';
        document.getElementById('inlineEnabled').checked = current.inlineCompletion?.enabled ?? false;
        const overlapEl = document.getElementById('inlineOverlapStripping');
        if (overlapEl) overlapEl.checked = current.inlineCompletion?.overlapStripping ?? true;
        document.getElementById('inlineEndpoint').value = current.inlineCompletion?.endpoint || '';
        document.getElementById('inlineDebounce').value = current.inlineCompletion?.debounceMs || 500;
        document.getElementById('agentWriteMode').value = current.agentFileWriteMode || 'confirm';
        // Brave Search API key — show masked placeholder if already set
        const braveKeyEl = document.getElementById('braveSearchApiKey');
        if (braveKeyEl) braveKeyEl.value = current.braveSearchApiKey || '';

        // Render MCP Servers
        const mcpList = document.getElementById('mcpServersList');
        if (mcpList) mcpList.innerHTML = '';
        if (current.mcp?.servers) {
            current.mcp.servers.forEach(s => addMcpServerBlock(s));
        }

        function updateInlineProviderSelect() {
            const isFimChecked = document.getElementById('inlineFimMode')?.checked ?? false;
            const currentPid = inlineSel.value;
            const filteredProviders = isFimChecked
                ? providers.filter(p => p.supportsFIM)
                : providers;
            inlineSel.innerHTML = '<option value="">- 与对话相同 -</option>' + filteredProviders.map(p => '<option value="' + p.id + '"' + (p.id === currentPid ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
            // If previously selected provider is no longer in list, reset
            if (isFimChecked && currentPid && !filteredProviders.find(p => p.id === currentPid)) {
                inlineSel.value = '';
            }
        }

        function updateInlineModelSelect(pid, selectedModel, ollamaModels) {
            const p2 = providers.find(p => p.id === (pid || current.provider));
            let ms = (pid || current.provider) === 'ollama' ? (ollamaModels || []).map(m => m.name) : (p2 ? p2.models : []);
            // Filter out thinking/reasoning models — they can't do inline completion
            ms = ms.filter(m => !settingsThinkingPrefixes.some(prefix => m.toLowerCase().includes(prefix.toLowerCase())));

            // Filter out non-FIM models if FIM mode is enabled
            const isFimNode = document.getElementById('inlineFimMode');
            if (isFimNode && isFimNode.checked && p2) {
                const fimCapableModels = {
                    'deepseek-v4-pro': true, 'deepseek-v4-flash': true, 'deepseek-coder': true,
                    'qwen2.5-coder': true, 'codellama': true, 'starcoder': true,
                    'qwen': false, 'gpt-': false, 'claude-': false
                };
                ms = ms.filter(m => {
                    if (!m) return p2.supportsFIM;
                    const lower = m.toLowerCase();
                    for (const [key, capable] of Object.entries(fimCapableModels)) {
                        if (lower.includes(key.toLowerCase())) return capable;
                    }
                    return p2.supportsFIM;
                });
            }

            const inp = document.getElementById('inlineModelInput');
            inp.value = selectedModel || '';

            setupApDropdown('inlineModelInput', 'inlineModelDatalist', () => ms);
        }
        const inlineProviderSel = document.getElementById('inlineProvider');
        const fimModeSel = document.getElementById('inlineFimMode');
        if (fimModeSel) {
            fimModeSel.checked = current.inlineCompletion?.fimMode ?? false;
            fimModeSel.onchange = () => {
                updateInlineProviderSelect();
                updateInlineModelSelect(inlineProviderSel.value, '', ollamaModels);
            };
        }
        updateInlineProviderSelect();
        updateInlineModelSelect(current.inlineCompletion?.provider, current.inlineCompletion?.model, ollamaModels);
        inlineProviderSel.onchange = () => updateInlineModelSelect(inlineProviderSel.value, '', ollamaModels);
        updateModelUI(current.provider, current.model, ollamaModels);
        updateApiKeyStatus(current.provider, providers);
        chatHeader.style.display = 'none';
        document.getElementById('chatArea').style.display = 'none';
        if (inputWrapper) inputWrapper.style.display = 'none';
        const mi = document.getElementById('modeIndicator');
        if (mi) mi.style.display = 'none';
        if (todoPanel) todoPanel.style.display = 'none';
        settingsPage.classList.add('active');
        document.getElementById('testResult').className = 'test-result';
        document.getElementById('testResult').textContent = '';
    }

    /** Look up per-model context size with fallback to provider level */
    function autoFillContextForModel(model, providerId) {
        if (!model) return 0;
        // 1. Exact match
        if (settingsModelContextTokens[model]) return settingsModelContextTokens[model];
        // 2. Prefix match
        for (const key of Object.keys(settingsModelContextTokens)) {
            if (model.startsWith(key)) return settingsModelContextTokens[key];
        }
        // 3. Substring match
        for (const key of Object.keys(settingsModelContextTokens)) {
            if (model.includes(key)) return settingsModelContextTokens[key];
        }
        // 4. Provider-level fallback
        const provider = settingsProviders.find(p => p.id === providerId);
        return (provider && provider.maxContextTokens) ? provider.maxContextTokens : 0;
    }

    function closeSettings() {
        settingsPage.classList.remove('active');
        chatHeader.style.display = '';
        document.getElementById('chatArea').style.display = 'flex';
        if (inputWrapper) inputWrapper.style.display = '';
        const mi = document.getElementById('modeIndicator');
        if (mi) mi.style.display = '';
        if (todoPanel) todoPanel.style.display = '';
    }

    function updateApiKeyStatus(providerId, providers) {
        const p = (providers || settingsProviders).find(x => x.id === providerId);
        const status = document.getElementById('apiKeyStatus');
        const group = document.getElementById('apiKeyGroup');
        if (providerId === 'ollama') { group.style.display = 'none'; return; }
        group.style.display = '';
        if (p && p.hasKey) { status.textContent = '✅ 已配置 API Key'; status.style.color = '#4caf50'; }
        else { status.textContent = '⚠️ 尚未配置 API Key'; status.style.color = '#ff9800'; }
    }

    function onProviderChange() {
        const id = document.getElementById('settingsProvider').value;
        updateModelUI(id, '', settingsOllamaModels);
        updateEndpointHint(id);
        updateApiKeyStatus(id, settingsProviders);
        // Auto-fill context with provider default when user switches provider
        const provider = settingsProviders.find(p => p.id === id);
        if (provider && provider.maxContextTokens > 0) {
            document.getElementById('settingsCtx').value = provider.maxContextTokens;
        }
    }

    function updateModelUI(providerId, currentModel, ollamaModels) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const modelInput = document.getElementById('settingsModelInput');
        const detectBtn = document.getElementById('detectBtn');
        const modelHint = document.getElementById('modelHint');

        /** Auto-fill settingsCtx when a model is chosen */
        function onModelSelected(model) {
            const ctx = autoFillContextForModel(model, providerId);
            if (ctx > 0) document.getElementById('settingsCtx').value = ctx;
        }

        let currentDropdownOpts = [];

        if (providerId === 'ollama') {
            document.getElementById('apiKeyGroup').style.display = 'none';
            if (ollamaModels && ollamaModels.length > 0) {
                currentDropdownOpts = ollamaModels.map(m => m.name);
                modelHint.textContent = '已检测到 ' + ollamaModels.length + ' 个本地模型';
            } else { currentDropdownOpts = []; modelHint.textContent = '点击「检测」获取 Ollama 模型'; }
            detectBtn.style.display = '';
        } else if (provider && provider.models.length > 0) {
            currentDropdownOpts = provider.models;
            modelHint.textContent = '可选择下拉项，或直接输入自定义模型名';
            detectBtn.style.display = 'none';
        } else { currentDropdownOpts = []; modelHint.textContent = ''; detectBtn.style.display = 'none'; }

        // Setup dropdown logic
        setupApDropdown('settingsModelInput', 'settingsModelDatalist', () => currentDropdownOpts, onModelSelected);

        // Restore value
        modelInput.value = currentModel || '';

        // Bind auto-fill to model input changes
        let _modelInputTimer;
        modelInput.oninput = () => {
            clearTimeout(_modelInputTimer);
            _modelInputTimer = setTimeout(() => onModelSelected(modelInput.value.trim()), 400);
            const evt = new Event('input_ap');
            modelInput.dispatchEvent(evt); // trigger dropdown render
        };
        // Auto-fill immediately for current selection
        if (modelInput.value) onModelSelected(modelInput.value);

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
        const btn = document.getElementById('detectBtn'); const ep = document.getElementById('settingsEndpoint').value.trim();
        btn.disabled = true; btn.textContent = '检测中...';
        document.getElementById('modelHint').textContent = '正在连接 Ollama...';
        vscode.postMessage({ type: 'detectOllamaModels', endpoint: ep || 'http://localhost:11434/v1' });
    }

    document.getElementById('delModelBtn').addEventListener('click', () => {
        const providerId = document.getElementById('settingsProvider').value;
        const modelId = document.getElementById('settingsModelInput').value.trim();
        if (providerId && modelId) {
            vscode.postMessage({ type: 'deleteDynamicModel', providerId, modelId });
        }
    });

    function addMcpServerBlock(server = { name: '', transport: { type: 'stdio', command: '', args: [] } }) {
        const list = document.getElementById('mcpServersList');
        if (!list) return;
        const div = document.createElement('div');
        div.className = 'mcp-server-block';

        // Ensure transport exists
        const t = server.transport || { type: 'stdio', command: '', args: [] };

        div.innerHTML = `
            <div class="mcp-row">
                <input class="settings-input mcp-name" type="text" placeholder="Server 名称" value="${escapeHtml(server.name || '')}" style="flex:1" />
                <select class="settings-select mcp-type" style="width:90px">
                    <option value="stdio" ${t.type === 'stdio' ? 'selected' : ''}>stdio</option>
                    <option value="sse" ${t.type === 'sse' ? 'selected' : ''}>sse</option>
                </select>
                <button class="mcp-delete-btn" title="删除">🗑</button>
            </div>
            <div class="mcp-transport-content"></div>
        `;
        list.appendChild(div);

        const typeSel = div.querySelector('.mcp-type');
        const contentDiv = div.querySelector('.mcp-transport-content');

        function renderTransport() {
            if (typeSel.value === 'stdio') {
                contentDiv.innerHTML = `
                    <input class="settings-input mcp-command" type="text" placeholder="Command (例如: npx)" value="${t.type === 'stdio' ? escapeHtml(t.command || '') : ''}" />
                    <input class="settings-input mcp-args" type="text" placeholder="Args (空格分隔)" value="${t.type === 'stdio' && t.args ? escapeHtml(t.args.join(' ')) : ''}" style="margin-top:4px" />
                `;
            } else {
                contentDiv.innerHTML = `
                    <input class="settings-input mcp-url" type="text" placeholder="SSE URL (例如: http://localhost:3000/sse)" value="${t.type === 'sse' ? escapeHtml(t.url || '') : ''}" />
                `;
            }
        }

        renderTransport();
        typeSel.addEventListener('change', renderTransport);

        div.querySelector('.mcp-delete-btn').addEventListener('click', () => {
            div.remove();
        });
    }

    document.getElementById('detectBtn').addEventListener('click', detectOllamaModels);
    document.getElementById('fetchApiModelsBtn').addEventListener('click', fetchApiModels);

    function fetchApiModels() {
        const btn = document.getElementById('fetchApiModelsBtn');
        btn.disabled = true; btn.textContent = '拉取中...';
        document.getElementById('apiKeyStatus').textContent = '正在发起网络请求拉取支持模型...';
        document.getElementById('apiKeyStatus').style.color = 'inherit';
        vscode.postMessage({
            type: 'fetchApiModels',
            providerId: document.getElementById('settingsProvider').value,
            endpoint: document.getElementById('settingsEndpoint').value.trim(),
            apiKey: document.getElementById('settingsApiKey').value
        });
    }

    function getSelectedModel() {
        return document.getElementById('settingsModelInput').value.trim();
    }

    function toggleAccordion(id) { document.getElementById(id).classList.toggle('open'); }

    function saveSettings() {
        const mcpServers = Array.from(document.querySelectorAll('.mcp-server-block')).map(block => {
            const type = block.querySelector('.mcp-type').value;
            const transport = { type };
            if (type === 'stdio') {
                transport.command = block.querySelector('.mcp-command')?.value.trim() || '';
                const argsStr = block.querySelector('.mcp-args')?.value.trim() || '';
                transport.args = argsStr ? argsStr.split(/\s+/) : [];
            } else {
                transport.url = block.querySelector('.mcp-url')?.value.trim() || '';
            }
            return {
                name: block.querySelector('.mcp-name').value.trim(),
                transport
            };
        });

        vscode.postMessage({
            type: 'saveSettings', settings: {
                provider: document.getElementById('settingsProvider').value,
                model: getSelectedModel(),
                apiKey: document.getElementById('settingsApiKey').value,
                endpoint: document.getElementById('settingsEndpoint').value.trim(),
                maxContextTokens: parseInt(document.getElementById('settingsCtx').value) || 0,
                agentFileWriteMode: document.getElementById('agentWriteMode').value,
                reasoningEffort: document.getElementById('settingsReasoningEffort').value || 'high',
                braveSearchApiKey: (document.getElementById('braveSearchApiKey')?.value || '').trim(),
                inlineCompletion: {
                    enabled: document.getElementById('inlineEnabled').checked,
                    provider: document.getElementById('inlineProvider').value,
                    model: document.getElementById('inlineModelInput').value.trim(),
                    endpoint: document.getElementById('inlineEndpoint').value.trim(),
                    debounceMs: parseInt(document.getElementById('inlineDebounce').value) || 500,
                    overlapStripping: document.getElementById('inlineOverlapStripping')?.checked ?? true,
                    fimMode: document.getElementById('inlineFimMode')?.checked ?? false,
                },
                mcp: { servers: mcpServers }
            }
        });
    }

    function testConnection() {
        const tr = document.getElementById('testResult');
        tr.className = 'test-result'; tr.textContent = '测试中...'; tr.style.display = 'block';
        vscode.postMessage({
            type: 'testConnection', settings: {
                provider: document.getElementById('settingsProvider').value,
                model: getSelectedModel(),
                apiKey: document.getElementById('settingsApiKey').value,
                endpoint: document.getElementById('settingsEndpoint').value.trim(),
                maxContextTokens: 0, agentFileWriteMode: 'confirm',
                reasoningEffort: document.getElementById('settingsReasoningEffort').value || 'high',
                inlineCompletion: { enabled: false, provider: '', model: '', endpoint: '', debounceMs: 1500 },
                mcp: { servers: [] }
            }
        });
    }
})();
