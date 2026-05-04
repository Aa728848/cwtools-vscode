import { Icons, svgIcon, svgIconNoMargin } from './svgIcons';

/** Type-safe getElementById with generic cast */
function $id<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

(function () {
    const vscode = acquireVsCodeApi();
    const chatArea = document.getElementById('chatArea') as HTMLDivElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    const emptyState = document.getElementById('emptyState') as HTMLDivElement;
    const topicsPanel = document.getElementById('topicsPanel') as HTMLDivElement;
    const settingsPage = document.getElementById('settingsPage') as HTMLDivElement;
    const chatHeader = document.querySelector('.header') as HTMLElement;
    const inputWrapper = document.querySelector('.input-wrapper') as HTMLElement;
    const planIndicator = document.getElementById('planIndicator') as HTMLDivElement;
    const todoPanel = document.getElementById('todoPanel') as HTMLDivElement;

    let isGenerating = false;
    let currentAssistantDiv: HTMLDivElement | null = null;
    let currentMode = 'build';
    const messageIndexMap = new Map<number, HTMLDivElement>();
    let settingsProviders: any[] = [];
    let settingsOllamaModels: any[] = [];

    // Custom absolute positioned dropdown logic
    function setupApDropdown(inputId: string, dropdownId: string, getOptions: () => string[], onSelect?: (val: string) => void) {
        const input = document.getElementById(inputId) as HTMLInputElement | null;
        const dropdown = document.getElementById(dropdownId) as HTMLDivElement | null;
        if (!input || !dropdown) return;

        function render(filter: string) {
            const term = (filter || '').toLowerCase();
            const opts = getOptions() || [];
            const html = opts.filter((m: string) => m.toLowerCase().includes(term))
                .map((m: string) => '<div class="ap-dropdown-item">' + escapeHtml(m) + '</div>').join('');
            dropdown!.innerHTML = html;
            Array.from(dropdown!.children).forEach(el => {
                (el as HTMLElement).onmousedown = (e: MouseEvent) => {
                    e.preventDefault();
                    input!.value = el.textContent || '';
                    dropdown!.style.display = 'none';
                    if (onSelect) onSelect(input!.value);
                };
            });
        }

        input.addEventListener('focus', () => { render(input.value); dropdown.style.display = 'block'; });
        input.addEventListener('blur', () => { setTimeout(() => { dropdown.style.display = 'none'; }, 150); });
        input.addEventListener('input_ap', () => { render(input.value); });
        input.addEventListener('input', () => { render(input.value); });
    }

    /** Per-model context window sizes received from backend — used to auto-fill settingsCtx */
    let settingsModelContextTokens: Record<string, number> = {};
    /** Thinking model prefixes — these models are excluded from inline completion selectors */
    let settingsThinkingPrefixes: string[] = [];
    let totalConversationTokens = 0;
    let contextLimit = 128000;
    /** Pending images (base64 data URLs) to attach to next sent message */
    let pendingImages: string[] = [];
    /** Pending @-mentioned file paths to attach */
    let pendingFiles: string[] = [];
    /** Available workspace files received from host for @ popup */
    let workspaceFiles: string[] = [];

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
    let placeholderTimer: ReturnType<typeof setInterval> | null = null;

    function startPlaceholderRotation() {
        stopPlaceholderRotation();
        placeholderTimer = setInterval(() => {
            if (input.value.trim() === '' && !isGenerating) {
                placeholderIdx = (placeholderIdx + 1) % PROMPT_EXAMPLES.length;
                input.placeholder = PROMPT_EXAMPLES[placeholderIdx]!;
            }
        }, 6500);
    }
    function stopPlaceholderRotation() {
        if (placeholderTimer) { clearInterval(placeholderTimer); placeholderTimer = null; }
    }
    input!.placeholder = PROMPT_EXAMPLES[placeholderIdx]!;
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
            if (text && !isGenerating) {
                input.value = text;
                autoResizeInput();
                input.focus();
                setTimeout(() => sendMessage(), 120);
            }
        });
    });

    // ── Dynamic Event Delegation for AI Options ─────────────────────────────────
    chatArea.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const btn = target.closest('.ai-option-btn') as HTMLElement;
        if (btn) {
            const text = btn.getAttribute('data-suggest');
            if (text && !isGenerating) {
                // Check if this is part of a question-card wizard
                const card = btn.closest('.question-card') as HTMLElement;
                if (card) {
                    const bubble = card.closest('.message.assistant') as HTMLElement;
                    if (bubble) {
                        const allCards = Array.from(bubble.querySelectorAll('.question-card')) as HTMLElement[];
                        const cardIndex = allCards.indexOf(card);
                        
                        const titleSpan = card.querySelector('.permission-card-title');
                        const cardTitle = titleSpan && titleSpan.textContent ? titleSpan.textContent.replace('❓ ', '').trim() : `问题 ${cardIndex + 1}`;

                        // Always hide current card
                        card.style.display = 'none';

                        if (allCards.length > 1) {
                            // Wizard Mode
                            const answers = (bubble as any)._collectedAnswers || [];
                            answers[cardIndex] = text;
                            (bubble as any)._collectedAnswers = answers;
                            
                            // Show next card if available
                            if (cardIndex + 1 < allCards.length) {
                                allCards[cardIndex + 1]!.style.display = 'block';
                                return; // DO NOT send message yet
                            } else {
                                // Final card! Prepare the batched message
                                let combinedMessage = "";
                                allCards.forEach((c, idx) => {
                                    const tSpan = c.querySelector('.permission-card-title');
                                    const title = tSpan && tSpan.textContent ? tSpan.textContent.replace('❓ ', '').trim() : `问题 ${idx + 1}`;
                                    combinedMessage += `【${title}】: ${answers[idx]}\n`;
                                });
                                // Append to existing input
                                input.value = (input.value ? input.value + '\n\n' : '') + combinedMessage.trim() + '\n';
                                autoResizeInput();
                                input.focus();
                                return;
                            }
                        } else {
                            // Single Card Mode
                            const formattedText = `【${cardTitle}】: ${text}`;
                            input.value = (input.value ? input.value + '\n\n' : '') + formattedText + '\n';
                            autoResizeInput();
                            input.focus();
                            return;
                        }
                    }
                }
                
                // Normal behavior (not a question card)
                input.value = (input.value ? input.value + '\n' : '') + text;
                autoResizeInput();
                input.focus();
            }
        }
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
        } else if (e.key === 'Tab') {
            e.preventDefault();
            const modes = ['build', 'plan', 'explore', 'general', 'review'];
            const idx = modes.indexOf(currentMode);
            const cycleDir = e.shiftKey ? -1 : 1;
            const nextMode = modes[(idx + cycleDir + modes.length) % modes.length]!;
            switchMode(nextMode, true);
        }
    });
    input.addEventListener('input', autoResizeInput);
    input.addEventListener('focus', stopPlaceholderRotation);
    input.addEventListener('blur', () => { if (input.value.trim() === '') startPlaceholderRotation(); });

    function autoResizeInput() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    }

    function bindBtn(id: string, handler: () => void) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    const quickModelSel = document.getElementById('quickModelSelect');
    if (quickModelSel) {
        quickModelSel.addEventListener('change', () => {
            vscode.postMessage({ type: 'quickChangeModel', model: (quickModelSel as HTMLSelectElement).value });
        });
    }

    bindBtn('btnNewTopic', () => vscode.postMessage({ type: 'newTopic' }));
    bindBtn('btnTopics', () => topicsPanel.classList.toggle('show'));
    bindBtn('btnNewTopicPanel', () => { vscode.postMessage({ type: 'newTopic' }); topicsPanel.classList.remove('show'); });
    bindBtn('btnSettings', () => {
        vscode.postMessage({ type: 'openSettings' });
        topicsPanel.classList.remove('show');
    });
    bindBtn('settingsBackBtn', closeSettings);
    bindBtn('testConnBtn', testConnection);
    bindBtn('saveSettingsBtn', saveSettings);
    bindBtn('keyToggleBtn', () => { const k = document.getElementById('settingsApiKey') as HTMLInputElement | null; if (k) k.type = k.type === 'password' ? 'text' : 'password'; });
    bindBtn('fetchApiModelsBtn', () => { fetchApiModels(); });
    bindBtn('detectBtn', detectOllamaModels);
    
    bindBtn('installSkillBtn', () => {
        const source = (document.getElementById('skillSourceInput') as HTMLInputElement).value.trim();
        if (source) {
            const btn = document.getElementById('installSkillBtn') as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = '安装中...';
            vscode.postMessage({ type: 'installSkill', source });
        }
    });
    bindBtn('accChat', () => toggleAccordion('chatModelSection'));
    bindBtn('accInline', () => toggleAccordion('inlineSection'));
    bindBtn('accMcp', () => toggleAccordion('mcpSection'));
    bindBtn('accAgent', () => toggleAccordion('agentSection'));
    bindBtn('addMcpServerBtn', () => addMcpServerBlock());
    bindBtn('accUsage', () => { toggleAccordion('usageSection'); vscode.postMessage({ type: 'requestUsageStats' }); });
    bindBtn('refreshUsageBtn', () => vscode.postMessage({ type: 'requestUsageStats' }));
    bindBtn('clearUsageBtn', () => {
        vscode.postMessage({ type: 'promptClearUsageStats' });
    });

    // ── Topic search (debounced 300ms) ─────────────────────────────────────────
    (() => {
        const si = document.getElementById('topicsSearch') as HTMLInputElement | null;
        if (!si) return;
        let _timer: ReturnType<typeof setTimeout> | null = null;
        si.addEventListener('input', () => {
            if (_timer) clearTimeout(_timer);
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
    const modeSel = document.getElementById('modeSel') as HTMLSelectElement | null;
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
        { cmd: '/mode:build', desc: '切换到构建模式（生成代码）' },
        { cmd: '/mode:plan', desc: '切换到计划模式（只读规划）' },
        { cmd: '/mode:explore', desc: '切换到分析模式（探索代码库）' },
        { cmd: '/mode:general', desc: '切换到问答模式（通用问答）' },
        { cmd: '/mode:review', desc: '切换到审查模式（代码审查）' },
    ];
    const slashPopup = document.getElementById('slashPopup');

    function showSlashPopup(filter: string) {
        if (!slashPopup) return;
        const q = filter.toLowerCase();
        const matches = SLASH_COMMANDS.filter(c => c.cmd.includes(q));
        if (!matches.length) { slashPopup.classList.remove('show'); return; }
        slashPopup.innerHTML = matches.map(c =>
            `<div class="slash-popup-item" data-cmd="${c.cmd}"><span class="slash-popup-cmd">${c.cmd}</span><span class="slash-popup-desc">${c.desc}</span></div>`
        ).join('');
        slashPopup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('click', () => {
                const cmd = (el as HTMLElement).dataset.cmd;
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
        else slashPopup?.classList.remove('show');
        // @ file mention: request file list on first @
        const atIdx = v.lastIndexOf('@');
        if (atIdx >= 0) {
            const afterAt = v.slice(atIdx + 1);
            if (!/[\s\n]/.test(afterAt)) {
                showAtPopup(afterAt);
            } else {
                closeAtPopup();
            }
        } else {
            closeAtPopup();
        }
    });
    document.addEventListener('click', e => { if (slashPopup && !slashPopup.contains(e.target as Node) && e.target !== input) slashPopup.classList.remove('show'); });
    document.addEventListener('click', e => { const t = e.target as HTMLElement; if (t && !t.closest('#atPopup') && t !== input) closeAtPopup(); });
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
        inputWrapper?.appendChild(el);
        return el;
    })();
    let _atPopupVisible = false;

    function showAtPopup(filter: string) {
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
                const file = (el as HTMLElement).dataset.file;
                if (!file) return;
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

    function addFileBadge(file: string) {
        let area = document.getElementById('fileBadgeArea');
        if (!area) {
            area = document.createElement('div');
            area.id = 'fileBadgeArea';
            area.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:4px 8px 0;';
            inputWrapper?.insertBefore(area, inputWrapper.firstChild);
        }
        const badge = document.createElement('span');
        badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:rgba(100,120,255,0.15);color:var(--accent);border-radius:4px;padding:1px 6px;font-size:11px;';
        badge.innerHTML = `${svgIconNoMargin('file')} ${escapeHtml(file.split('/').pop())} <button style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:10px;" data-file="${escapeHtml(file)}">✕</button>`;
        badge.querySelector('button')!.addEventListener('click', () => {
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
    function compressImage(file: Blob, callback: (dataUrl: string) => void) {
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
                ctx!.drawImage(img, 0, 0, w, h);
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
        for (const item of Array.from(items)) {
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
    inputWrapper?.addEventListener('dragover', e => {
        e.preventDefault();
        inputWrapper.classList.add('drag-over');
    });
    inputWrapper?.addEventListener('dragleave', () => {
        inputWrapper.classList.remove('drag-over');
    });
    inputWrapper?.addEventListener('drop', e => {
        e.preventDefault();
        inputWrapper.classList.remove('drag-over');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (!files) return;
        for (const file of Array.from(files)) {
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
            for (const file of Array.from(fileInput.files || [])) {
                compressImage(file, dataUrl => {
                    pendingImages.push(dataUrl);
                    addImagePreview(dataUrl);
                });
            }
            fileInput.value = '';
        });
    })();

    // ── Lightbox for full-size image preview ───────────────────────────────────
    function showImageLightbox(dataUrl: string) {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);';
        overlay.appendChild(img);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
    }

    function addImagePreview(dataUrl: string) {
        let area = document.getElementById('imagePreviewArea');
        if (!area) {
            area = document.createElement('div');
            area.id = 'imagePreviewArea';
            area.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:6px 8px 0;';
            inputWrapper?.insertBefore(area, inputWrapper.firstChild);
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

    const MODE_META: Record<string, { label: string | null; bodyClass: string }> = {
        build: { label: null, bodyClass: 'build-mode' },
        plan: { label: '计划模式 — 只读分析，不修改文件', bodyClass: 'plan-mode' },
        explore: { label: '分析模式 — 探索代码库结构', bodyClass: 'explore-mode' },
        general: { label: '问答模式 — 通用问答', bodyClass: 'general-mode' },
        review: { label: '审查模式 — 代码审查', bodyClass: 'review-mode' },
        loc_translator: { label: '翻译模式 — 本地化文件翻译（子代理专用）', bodyClass: 'build-mode' },
        loc_writer: { label: '写作模式 — 本地化内容创作（子代理专用）', bodyClass: 'build-mode' },
    };

    /**
     * switchMode(mode, fromUI)
     * fromUI=true  → user clicked dropdown → send message to backend + update UI
     * fromUI=false → backend sent modeChanged message → only update UI (no echo back)
     */
    function switchMode(mode: string, fromUI?: boolean) {
        if (currentMode === mode && !fromUI) return; // avoid redundant update
        currentMode = mode;
        // Sync dropdown value without re-triggering change event
        const sel = document.getElementById('modeSel') as HTMLSelectElement | null;
        if (sel && sel.value !== mode) sel.value = mode;
        // Only post to backend when user initiated (avoids ping-pong)
        if (fromUI) vscode.postMessage({ type: 'switchMode', mode });
        // Remove all mode body classes, add correct one
        document.body.classList.remove('build-mode', 'plan-mode', 'explore-mode', 'general-mode', 'review-mode');
        const meta = MODE_META[mode as keyof typeof MODE_META];
        if (meta && meta.bodyClass) document.body.classList.add(meta.bodyClass);
        // Update inline mode indicator text
        const ind = document.getElementById('modeIndicator');
        if (ind) ind.textContent = meta && meta.label ? meta.label : '';
    }
    
    // Give initial mode its body class
    document.body.classList.add('build-mode');

    function setGenerating(val: boolean) {
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
    function updateTokenUsage(used: number, limit: number) {
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

    function formatNum(n: number) { return n >= 1000 ? (n / 1000).toFixed(0) + 'k' : String(n); }

    function formatTime(ts: number | string | null) {
        if (!ts) return '';
        const d = new Date(ts);
        return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
    }

    // ── HTML escape ────────────────────────────────────────────────────────────
    function escapeHtml(t: any): string {
        return String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Markdown renderer ──────────────────────────────────────────────────────
    function inlineMd(raw: string) {
        const mediaBlocks: string[] = [];
        let s = raw.replace(/<(video|audio)\s+([^>]+)>(?:<\/\1>)?/gi, (_: string, tag: string, attrs: string) => {
            if (!/controls/i.test(attrs)) attrs += ' controls';
            const style = tag.toLowerCase() === 'video' ? 'max-width:100%; border-radius:6px; margin:8px 0; display:block;' : 'width:100%; margin:8px 0; display:block;';
            mediaBlocks.push(`<${tag.toLowerCase()} ${attrs} style="${style}"></${tag.toLowerCase()}>`);
            return '\x01MEDIA' + (mediaBlocks.length - 1) + '\x01';
        });

        s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const codeBlocks: string[] = [];
        s = s.replace(/`([^`]+)`/g, (_: string, c: string) => {
            codeBlocks.push('<code>' + c.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') + '</code>');
            return '\x01CODE' + (codeBlocks.length - 1) + '\x01';
        });
        s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
        s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|\W)__([^_\n]+)__(\W|$)/g, '$1<strong>$2</strong>$3');
        s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
        s = s.replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3');
        s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
        s = s.replace(/\[Option:\s*([^\]]+)\]/gi, '<button class="suggest-card ai-option-btn popup-option" data-suggest="$1" style="display:flex; margin:6px 0; width:fit-content; max-width:98%; text-align:left; word-wrap:break-word; white-space:normal; align-items:flex-start;"><span class="suggest-card-icon" style="margin-top:2px;">👉</span>$1</button>');
        
        // Media links detection
        s = s.replace(/!?\[([^\]]*)\]\(([^)]+\.(?:mp3|wav|ogg|aac|m4a|flac)(?:\?[^)]*)?)\)/gi, '<audio src="$2" controls style="width:100%; margin: 8px 0; display: block;"></audio>');
        s = s.replace(/!?\[([^\]]*)\]\(([^)]+\.(?:mp4|webm|ogv|mov)(?:\?[^)]*)?)\)/gi, '<video src="$2" controls style="max-width:100%; border-radius:6px; margin: 8px 0; display: block;"></video>');
        
        s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%; border-radius:6px; margin: 8px 0; display: block;" />');
        s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
        
        // eslint-disable-next-line no-control-regex
        s = s.replace(/\x01CODE(\d+)\x01/g, (_: string, i: string) => codeBlocks[parseInt(i)]!);
        // eslint-disable-next-line no-control-regex
        s = s.replace(/\x01MEDIA(\d+)\x01/g, (_: string, i: string) => mediaBlocks[parseInt(i)]!);
        return s;
    }

    function renderMarkdown(rawText: string): string {
        if (!rawText) return '';

        // Phase 1: extract fenced code blocks to avoid mis-parsing their content
        const blocks: {lang: string; code: string; isCard?: boolean}[] = [];
        let text = rawText.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const i = blocks.length; blocks.push({ lang: lang.trim(), code }); return '\n\x00BLOCK' + i + '\x00\n';
        });

        // Phase 1.5: extract Question Cards (Highly resilient parser for smaller models)
        let finalOutputText = "";
        let questionCardIndex = 0;
        let inQuestion = false;
        let qTitle = '';
        let qOptions: {text: string, desc: string}[] = [];

        function flushQuestionCard() {
            if (!inQuestion) return;
            inQuestion = false;
            if (qOptions.length > 0) {
                const optionsHtml = qOptions.map(opt => `
                    <button class="permission-allow-btn ai-option-btn popup-option" data-suggest="${escapeHtml(opt.text)}" style="display:flex; flex-direction:column; align-items:flex-start; text-align:left; width:100%; margin:4px 0; padding:6px 10px; line-height:1.4;">
                        <span style="font-weight:600; font-size:13px; display:flex; align-items:center; gap:6px;">${svgIcon('pointer')} ${escapeHtml(opt.text)}</span>
                        ${opt.desc.trim() ? `<span style="font-size:11.5px; opacity:0.75; margin-top:2px; font-weight:normal;">${escapeHtml(opt.desc.trim())}</span>` : ''}
                    </button>
                `).join('');
                
                const displayStyle = questionCardIndex === 0 ? "block" : "none";
                const qIndex = questionCardIndex++;
                const cardHtml = `
                <div class="permission-card question-card" data-qindex="${qIndex}" style="margin: 12px 0; display:${displayStyle};">
                    <div class="permission-card-header">
                        <span class="permission-card-icon" style="font-size:16px;">${svgIcon('question')}</span>
                        <div class="permission-card-body">
                            <div class="permission-card-title" style="font-weight:600; font-size:14px; margin-bottom:4px;">${escapeHtml(qTitle)}</div>
                        </div>
                    </div>
                    <div class="permission-card-actions" style="display:block; padding:0 12px 12px;">
                        ${optionsHtml}
                    </div>
                </div>`;
                const bIdx = blocks.length;
                blocks.push({ lang: 'html', code: cardHtml, isCard: true });
                finalOutputText += '\n\x00BLOCK' + bIdx + '\x00\n';
            } else {
                // False alarm, wasn't a valid card or had no options
                finalOutputText += `:::question ${qTitle}\n`;
            }
            qOptions = [];
            qTitle = '';
        }

        const lines15 = text.split('\n');
        for (let j = 0; j < lines15.length; j++) {
            const line = (lines15[j] || '').trim();
            // Start of a question block
            const qStartMatch = line.match(/^(?::::\s*)?question\s+(.+)$/i);
            if (qStartMatch) {
                flushQuestionCard(); // Flush previous if it wasn't gracefully closed
                inQuestion = true;
                qTitle = qStartMatch[1] || '';
                continue;
            }
            
            if (inQuestion) {
                if (line === ':::') {
                    flushQuestionCard();
                    continue;
                }
                const optMatch = line.match(/^\[Option:\s*([^\]]+)\]\s*(.*)$/i);
                if (optMatch) {
                    qOptions.push({ text: optMatch[1] || '', desc: optMatch[2] || '' });
                } else if (qOptions.length > 0 && line !== '') {
                    // Accumulate broken newline descriptions
                    qOptions[qOptions.length - 1]!.desc += ' ' + line;
                } else if (line !== '') {
                    // Plain text before any options? We can just append it safely to finalOutputText.
                    finalOutputText += line + '\n';
                }
            } else {
                // Not in question block, preserve raw text
                finalOutputText += (lines15[j] || '') + '\n';
            }
        }
        flushQuestionCard(); // Flush any trailing unclosed block
        text = finalOutputText;

        // Phase 2: line-by-line state machine — correctly handles ## headings at any position
        const lines = text.split('\n');
        const out: string[] = [];
        let i = 0;

        function flushPara(paraLines: string[]) {
            if (!paraLines.length) return;
            const lineHtml = paraLines.map(line => {
                const t = line.trim();
                // eslint-disable-next-line no-control-regex
                if (/^\x00BLOCK\d+\x00$/.test(t)) {
                    const block = blocks[+t.match(/\d+/)![0]!]!;
                    if (block.isCard) return block.code;
                    return '<div class="md-codeblock"><div class="md-codeblock-lang">' + escapeHtml(block.lang) + '</div><code>' + escapeHtml(block.code) + '</code></div>';
                }
                return inlineMd(line);
            });
            out.push('<p>' + lineHtml.join('<br>') + '</p>');
        }

        let paraLines: string[] = [];

        while (i < lines.length) {
            const line = lines[i]!;
            const trimmed = line.trim();

            // Empty line: flush current paragraph
            if (!trimmed) { flushPara(paraLines); paraLines = []; i++; continue; }

            // Fenced code block placeholder (standalone line)
            // eslint-disable-next-line no-control-regex
            if (/^\x00BLOCK\d+\x00$/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                const block = blocks[+trimmed.match(/\d+/)![0]!]!;
                if (block.isCard) {
                    out.push(block.code);
                } else {
                    out.push('<div class="md-codeblock"><div class="md-codeblock-lang">' + escapeHtml(block.lang) + '</div><code>' + escapeHtml(block.code) + '</code></div>');
                }
                i++; continue;
            }

            // ATX Heading — works at ANY line position (key fix: no lines.length===1 restriction)
            const hdm = trimmed.match(/^(#{1,6})\s+(.+)$/);
            if (hdm) {
                flushPara(paraLines); paraLines = [];
                const lv = hdm[1]!.length;
                out.push('<h' + lv + '>' + inlineMd(hdm[2]!) + '</h' + lv + '>');
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
                const bqLines: string[] = [];
                while (i < lines.length && /^>/.test(lines[i]!.trim())) {
                    bqLines.push(lines[i]!.replace(/^>\s?/, '')); i++;
                }
                out.push('<blockquote>' + renderMarkdown(bqLines.join('\n')) + '</blockquote>');
                continue;
            }

            // GFM Table — header row | separator row | data rows (all consecutive)
            if (/^\|/.test(trimmed) && i + 1 < lines.length && /^[/|\s:-]+$/.test(lines[i + 1]!.trim())) {
                flushPara(paraLines); paraLines = [];
                const tblLines: string[] = [];
                while (i < lines.length && /^\|/.test(lines[i]!.trim())) { tblLines.push(lines[i]!); i++; }
                if (tblLines.length >= 2) {
                    const headers = tblLines[0]!.split('|').map(c => c.trim()).filter(Boolean);
                    const rows = tblLines.slice(2).map(r => r.split('|').map(c => c.trim()).filter(Boolean));
                    let tbl = '<table><thead><tr>' + headers.map(h => '<th>' + inlineMd(h) + '</th>').join('') + '</tr></thead><tbody>';
                    rows.forEach(r => { tbl += '<tr>' + r.map(c => '<td>' + inlineMd(c) + '</td>').join('') + '</tr>'; });
                    out.push(tbl + '</tbody></table>');
                }
                continue;
            }

            // Unordered list — collect consecutive list items, supporting nested lists
            if (/^[-*+]\s/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                // Stack of { tag:'ul'|'ol', indent:number } for nesting
                const stack: {tag: string; indent: number}[] = [];
                const htmlParts: string[] = [];
                const getIndent = (line: string) => { const m = line.match(/^(\s*)/); return m ? m[1]!.length : 0; };
                const startList = (tag: string, indent: number) => { stack.push({ tag, indent }); htmlParts.push('<' + tag + '>'); };
                const closeList = () => { const item = stack.pop(); if (item) htmlParts.push('</' + item.tag + '>'); };

                startList('ul', getIndent(lines[i]!));
                while (i < lines.length) {
                    const ll = lines[i]!, lt = ll.trim();
                    if (!lt) { i++; break; }
                    const indent = getIndent(ll);
                    const ulMatch = lt.match(/^[-*+]\s+(.*)/);
                    const olMatch = lt.match(/^\d+\.\s+(.*)/);
                    if (ulMatch || olMatch) {
                        const content = ulMatch ? ulMatch[1]! : olMatch![1]!;
                        const listTag = ulMatch ? 'ul' : 'ol';
                        // Close lists deeper than current indent
                        while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
                            htmlParts.push('</li>');
                            closeList();
                        }
                        // Open new nested list if deeper
                        if (stack.length > 0 && indent > stack[stack.length - 1]!.indent) {
                            startList(listTag, indent);
                        } else if (stack.length > 0 && htmlParts[htmlParts.length - 1] !== '<' + stack[stack.length - 1]!.tag + '>') {
                            htmlParts.push('</li>');
                        }
                        htmlParts.push('<li>' + inlineMd(content));
                        i++;
                    } else if (/^\s{2,}/.test(ll) && stack.length > 0) {
                        // Continuation line — append to current item
                        htmlParts.push(' ' + lt);
                        i++;
                    } else {
                        break;
                    }
                }
                // Close all remaining open lists
                while (stack.length > 0) {
                    htmlParts.push('</li>');
                    closeList();
                }
                out.push(htmlParts.join(''));
                continue;
            }

            // Ordered list — collect consecutive numbered items with nesting
            if (/^\d+\.\s/.test(trimmed)) {
                flushPara(paraLines); paraLines = [];
                const stack: {tag: string; indent: number}[] = [];
                const htmlParts: string[] = [];
                const getIndent = (line: string) => { const m = line.match(/^(\s*)/); return m ? m[1]!.length : 0; };
                const startList = (tag: string, indent: number) => { stack.push({ tag, indent }); htmlParts.push('<' + tag + '>'); };
                const closeList = () => { const item = stack.pop(); if (item) htmlParts.push('</' + item.tag + '>'); };

                startList('ol', getIndent(lines[i]!));
                while (i < lines.length) {
                    const ll = lines[i]!, lt = ll.trim();
                    if (!lt) { i++; break; }
                    const indent = getIndent(ll);
                    const olMatch = lt.match(/^\d+\.\s+(.*)/);
                    const ulMatch = lt.match(/^[-*+]\s+(.*)/);
                    if (olMatch || ulMatch) {
                        const content = olMatch ? olMatch[1]! : ulMatch![1]!;
                        const listTag = olMatch ? 'ol' : 'ul';
                        while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
                            htmlParts.push('</li>');
                            closeList();
                        }
                        if (stack.length > 0 && indent > stack[stack.length - 1]!.indent) {
                            startList(listTag, indent);
                        } else if (stack.length > 0 && htmlParts[htmlParts.length - 1] !== '<' + stack[stack.length - 1]!.tag + '>') {
                            htmlParts.push('</li>');
                        }
                        htmlParts.push('<li>' + inlineMd(content));
                        i++;
                    } else if (/^\s{2,}/.test(ll) && stack.length > 0) {
                        htmlParts.push(' ' + lt);
                        i++;
                    } else {
                        break;
                    }
                }
                while (stack.length > 0) {
                    htmlParts.push('</li>');
                    closeList();
                }
                out.push(htmlParts.join(''));
                continue;
            }

            // Default: accumulate into paragraph
            paraLines.push(line); i++;
        }

        flushPara(paraLines);
        return out.join('');
    }

    let isUserScrolledUp = false;
    chatArea.addEventListener('scroll', () => {
        isUserScrolledUp = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight > 65;
    });

    function scrollBottom(force = false) {
        if (force || !isUserScrolledUp) {
            chatArea.scrollTop = chatArea.scrollHeight;
            isUserScrolledUp = false;
        }
    }

    // ── Batch 3.1: Virtual scroll — IntersectionObserver offscreen optimization ──
    // Adds CSS class 'offscreen' to messages far from the viewport, enabling
    // content-visibility:auto to skip layout/paint for off-screen DOM subtrees.
    // This dramatically reduces memory and rendering cost for 100+ message sessions.
    const virtualScrollObserver = new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                const el = entry.target as HTMLElement;
                if (entry.isIntersecting) {
                    el.classList.remove('offscreen');
                } else {
                    // Only mark offscreen if the message is NOT the live streaming message
                    if (!el.classList.contains('live-msg')) {
                        el.classList.add('offscreen');
                    }
                }
            }
        },
        { root: chatArea, rootMargin: '200% 0px' } // ±2 screens buffer
    );

    /** Register a message element for virtual scroll observation */
    function observeMessage(el: HTMLElement) {
        virtualScrollObserver.observe(el);
    }

    // ── Batch 3.2: Code block copy button enhancer ──────────────────────────
    // After rendering markdown, attach copy buttons to all code blocks.
    function enhanceCodeBlocks(container: HTMLElement) {
        const blocks = container.querySelectorAll('.md-codeblock');
        blocks.forEach(block => {
            // Skip if already enhanced
            if (block.querySelector('.md-codeblock-copy')) return;
            const codeEl = block.querySelector('code');
            if (!codeEl) return;
            const btn = document.createElement('button');
            btn.className = 'md-codeblock-copy';
            btn.textContent = 'Copy';
            btn.setAttribute('aria-label', '复制代码');
            btn.addEventListener('click', () => {
                navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
                    btn.textContent = '✓';
                    btn.classList.add('copied');
                    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
                }).catch(() => { /* clipboard not available in webview sandbox */ });
            });
            block.appendChild(btn);
        });
    }

    // ── Batch 3.2: Task list checkbox rendering ──────────────────────────────
    // Converts GFM-style task list items (- [x] / - [ ]) to styled checkboxes.
    function enhanceTaskLists(container: HTMLElement) {
        const lists = container.querySelectorAll('ul, ol');
        lists.forEach(list => {
            const items = Array.from(list.children) as HTMLElement[];
            let hasTask = false;
            for (const li of items) {
                const text = li.innerHTML;
                const checkedMatch = text.match(/^\s*\[x\]\s*/i);
                const uncheckedMatch = text.match(/^\s*\[\s?\]\s*/);
                if (checkedMatch || uncheckedMatch) {
                    hasTask = true;
                    const checked = !!checkedMatch;
                    const prefix = checked ? checkedMatch![0] : uncheckedMatch![0];
                    li.innerHTML = `<input type="checkbox" class="task-checkbox" ${checked ? 'checked' : ''} disabled aria-label="${checked ? '已完成' : '未完成'}">` +
                        text.substring(prefix.length);
                }
            }
            if (hasTask) list.classList.add('task-list');
        });
    }

    // ── Batch 3.3: ARIA role helpers for dynamic messages ─────────────────────
    function setMessageAria(el: HTMLElement, role: 'user' | 'assistant') {
        el.setAttribute('role', 'article');
        el.setAttribute('aria-label', role === 'user' ? 'User message' : 'AI response');
    }

    // ── OpenCode-style step rendering ─────────────────────────────────────────
    // Tool step icons — minimal, professional
    const TOOL_ICONS = {
        read_file: Icons.file, write_file: Icons.save, edit_file: Icons.edit,
        list_directory: Icons.folder, search_mod_files: Icons.search, validate_code: Icons.check,
        get_file_context: Icons.file, get_diagnostics: Icons.stethoscope, get_completion_at: Icons.lightbulb,
        document_symbols: Icons.bookmark, workspace_symbols: Icons.bookmark, query_scope: Icons.telescope,
        query_types: Icons.ruler, query_rules: Icons.ruler, query_references: Icons.link, todo_write: Icons.clipboard,
    };
    const WRITE_TOOL_NAMES = new Set(['edit_file', 'write_file', 'read_file', 'delete_file']);

    /**
     * Build ONE tool-pair <div class="tool-pair"> that shows:
     *   ┌─ ToolIcon  tool_name → file.txt
     *   └─ (result summary, only when toolResult is present)
     */
    function buildToolPair(callStep: any, resultStep?: any) {
        const toolName: string = callStep.toolName || '';
        const args = callStep.toolArgs || {};
        const icon = TOOL_ICONS[toolName as keyof typeof TOOL_ICONS] || '⚙';
        const fp = args.filePath || args.file || args.path || args.directory || '';
        const fname = fp ? String(fp).split(/[\\/]/).pop() : '';

        let callHtml = `<span class="tp-icon">${icon}</span>`;
        callHtml += `<span class="tp-name">${escapeHtml(toolName)}</span>`;
        
        let summaryText = fname;
        if (toolName === 'run_command' && args.command) {
            summaryText = String(args.command).substring(0, 30) + (String(args.command).length > 30 ? '...' : '');
        } else if ((toolName === 'search_web' || toolName === 'codesearch') && args.query) {
            summaryText = String(args.query).substring(0, 30);
        } else if (toolName === 'todo_write') {
            const todos = Array.isArray(args.todos) ? args.todos : [];
            summaryText = `${todos.length} items`;
        }
        
        if (summaryText) callHtml += ` <span class="tp-file">${escapeHtml(summaryText)}</span>`;

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

    function buildAssistantMessage(content: string, steps: any[], msgTime: number | null) {
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
            // 1. Thinking block (thinking_content, text_delta AND narrative 'thinking' type)
            const thinkSteps = steps.filter((s: any) => s.type === 'thinking_content' || s.type === 'thinking' || s.type === 'text_delta');
            if (thinkSteps.length > 0) {
                let thinkText = '';
                for (const s of thinkSteps) {
                    if (s.type === 'thinking' && thinkText) thinkText += '\n\n---\n\n' + (s.content || '');
                    else thinkText += (s.content || '');
                }
                thinkText = thinkText.trim();
                const estTokens = Math.ceil(thinkText.length / 4);

                const det = document.createElement('details');
                det.className = 'thinking-block';
                const sum = document.createElement('summary');
                sum.innerHTML = '<span class="think-pulse"></span>Thinking · ' +
                    thinkSteps.length + ' block(s) &nbsp;<span class="think-tokens">~' + formatNum(estTokens) + ' tokens</span>';
                det.appendChild(sum);
                const body = document.createElement('div');
                body.className = 'thinking-body markdown-body';
                body.innerHTML = renderMarkdown(thinkText);
                det.appendChild(body);
                div.appendChild(det);
            }

            // 2. Tool calls block — pair each tool_call with its tool_result
            const toolCallSteps = steps.filter((s: any) => s.type === 'tool_call');
            const toolResultSteps = steps.filter((s: any) => s.type === 'tool_result');

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
                    const result = toolResultSteps.find((r: any) => r.toolName === call.toolName && !r._matched);
                    if (result) result._matched = true;
                    body.innerHTML += buildToolPair(call, result);
                }
                det.appendChild(body);
                div.appendChild(det);
            }

            // Also show non-tool, non-thinking special steps (errors, compaction, etc.)
            const specialSteps = steps.filter((s: any) =>
                s.type !== 'tool_call' && s.type !== 'tool_result' &&
                s.type !== 'thinking_content' && s.type !== 'thinking' &&
                s.type !== 'text_delta'
            );
            for (const s of specialSteps) {
                const el = document.createElement('div');
                const icon = s.type === 'error' ? svgIconNoMargin('x') : s.type === 'validation' ? svgIconNoMargin('check') : s.type === 'compaction' ? svgIconNoMargin('gear') : '·';
                el.className = 'special-step';
                el.innerHTML = icon + ' ' + escapeHtml(s.content || '');
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

        // Batch 3: Enhance rendered content
        setMessageAria(div, 'assistant');
        enhanceCodeBlocks(div);
        enhanceTaskLists(div);
        observeMessage(div);

        return div;
    }

    // ── Live thinking/tool state builders ─────────────────────────────────────
    // We maintain a structured state for the live (streaming) assistant message.
    // liveState = { thinkSteps: AgentStep[], toolCalls: Map<toolName, {call,result}[]>, specialSteps }
    const liveState = null;

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
    let liveTextBubble: HTMLDivElement | null = null;
    let liveTextContent = '';
    let liveThinkContent = '';

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

    function applyLiveStep(s: any) {
        if (!currentAssistantDiv) return;

        // ── text_delta: streaming token ────────────────────────────────────────
        if (s.type === 'text_delta' || s.type === 'thinking_content' || s.type === 'thinking') {
            const tb = document.getElementById('liveThink');
            const tbd = document.getElementById('liveThinkBody');
            const tsum = document.getElementById('liveThinkSum');
            if (tb) tb.style.display = '';
            if (tbd) {
                // Append: use separator only for distinct reasoning blocks (type='thinking'),
                // streaming delta tokens (type='thinking_content' or 'text_delta') are appended directly
                if (s.type === 'thinking' && liveThinkContent) {
                    liveThinkContent += '\n\n---\n\n' + (s.content || '');
                } else {
                    liveThinkContent += (s.content || '');
                }
                tbd.className = 'thinking-body markdown-body';
                tbd.innerHTML = renderMarkdown(liveThinkContent);
                if (tsum) {
                    const est = Math.ceil(liveThinkContent.length / 4);
                    tsum.innerHTML = '<span class="think-pulse spinning"></span>Thinking &nbsp;<span class="think-tokens">~' + formatNum(est) + ' tokens</span>';
                }
            }
            if (s.transactionCard && s.transactionCard.status === 'pending') {
                showTransactionCard(s.transactionCard);
            }
            scrollBottom();
            return;
        }

        // Non-text-delta: flush any pending streaming text first
        if (liveTextContent) flushLiveText();

        if (s.type === 'tool_call') {
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
                    (pair as HTMLElement).dataset.resolved = '1';
                    // Find the call step that matches this result
                    const callDiv = pair!.querySelector('.tp-call');
                    // Build fresh pair with result
                    const fakeCall = { toolName: s.toolName, toolArgs: {} };
                    pair!.innerHTML = buildToolPair(fakeCall, s);
                }
            }
        } else if (s.type === 'error' || s.type === 'validation' || s.type === 'compaction') {
            if (!currentAssistantDiv) return;
            const el = document.createElement('div');
            el.className = 'special-step';
            const icon = s.type === 'error' ? svgIconNoMargin('x') : s.type === 'validation' ? svgIconNoMargin('check') : svgIconNoMargin('gear');
            el.innerHTML = icon + ' ' + escapeHtml(s.content || '');
            currentAssistantDiv.appendChild(el);
        }
        scrollBottom();
    }

    // ── User message ───────────────────────────────────────────────────────────
    // Builds inline image thumbnails (clickable lightbox) from images array
    function buildImageRow(images: string[]) {
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

    function addUserMessage(text: string, msgIdx: number, images?: string[]) {
        emptyState.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'message user';
        if (msgIdx !== undefined && msgIdx >= 0) div.dataset.msgIndex = String(msgIdx);

        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span class="msg-role user-role">You</span><span class="msg-time">' + formatTime(Date.now()) + '</span>';

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble user-bubble';
        bubble.textContent = text;

        // M6 fix: display image thumbnails from the actual images array
        const imgRow = buildImageRow(images || []);
        if (imgRow) bubble.appendChild(imgRow);

        div.appendChild(hdr);
        div.appendChild(bubble);

        if (msgIdx !== undefined && msgIdx >= 0) {
            const rb = document.createElement('button');
            rb.className = 'retract-btn';
            rb.textContent = '↩ 撤回';
            rb.setAttribute('aria-label', '撤回此消息');
            rb.addEventListener('click', () => showRetractConfirm(msgIdx));
            div.appendChild(rb);
            messageIndexMap.set(msgIdx, div);
        }
        // Batch 3: ARIA and virtual scroll
        setMessageAria(div, 'user');
        observeMessage(div);
        chatArea.appendChild(div);
        scrollBottom(true);
        return div;
    }

    // P3: Retract confirmation dialog
    function showRetractConfirm(messageIdx: number) {
        const overlay = document.createElement('div');
        overlay.className = 'retract-confirm';
        overlay.innerHTML = '<div class="retract-confirm-box">' +
            '<div class="retract-confirm-title">撤回此消息？</div>' +
            '<div class="retract-confirm-hint">这将同时撤回后续的 AI 回复，并恢复所有被 AI 修改或创建的文件</div>' +

            '<div class="retract-confirm-btns">' +
            '<button class="retract-ok">撤回</button>' +
            '<button class="retract-cancel">取消</button>' +
            '</div></div>';
        overlay.querySelector('.retract-ok')!.addEventListener('click', () => {
            overlay.remove();
            vscode.postMessage({ type: 'retractMessage', messageIndex: messageIdx });
        });
        overlay.querySelector('.retract-cancel')!.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }

    // ── Card dismiss helper ────────────────────────────────────────────────────
    function dismissCard(el: HTMLElement, delay: number, onComplete?: () => void) {
        setTimeout(() => {
            el.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            el.style.opacity = '0';
            el.style.transform = 'translateY(-4px)';
            setTimeout(() => {
                el.remove();
                if (onComplete) onComplete();
            }, 260);
        }, delay || 400);
    }
    
    // ── Transaction Card (Batch VFS Commit) ──────────────────────────────
    function showTransactionCard(cardInfo: any) {
        const div = document.createElement('div');
        const card = document.createElement('div');
        card.className = 'diff-card';
        const safeId = escapeHtml(cardInfo.id);
        const filesListHTML = (cardInfo.filesRequested || []).map((f: string) => `<li>${escapeHtml(f.split(/[\\/]/).pop() || f)}</li>`).join('');
        card.innerHTML =
            '<div class="diff-card-header">' +
            svgIcon('edit') + '请求批量应用更改 (' + (cardInfo.filesRequested?.length || 0) + ' 个文件):' +
            '<ul style="margin: 4px 0; padding-left: 16px; font-size: 11px; font-family: monospace; opacity: 0.8; max-height: 60px; overflow-y: auto;">' + filesListHTML + '</ul>' +
            '<span class="diff-card-hint">所有的修改会在内存中隔离准备</span></div>' +
            '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn" data-txid="' + safeId + '">' + svgIcon('check') + '接受批量提交</button>' +
            '<button class="diff-reject-btn" data-txid="' + safeId + '">' + svgIcon('x') + '拒绝</button>' +
            '</div>';
            
        (card.querySelector('.diff-accept-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-reject-btn') as HTMLButtonElement).disabled = true;
            this.innerHTML = svgIcon('check') + '已接受';
            vscode.postMessage({ type: 'approveTransaction', txId: cardInfo.id });
            dismissCard(div, 800);
        });
        (card.querySelector('.diff-reject-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-accept-btn') as HTMLButtonElement).disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'rejectTransaction', txId: cardInfo.id });
            dismissCard(div, 800);
        });
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Diff card ──────────────────────────────────────────────────────────────
    function showAutoWriteCard(file: string, isNewFile: boolean) {
        const wrap = document.createElement('div');
        wrap.className = 'msg-bubble assistant';
        wrap.style.border = '1px solid var(--accent)';
        wrap.style.background = 'rgba(100, 200, 100, 0.05)';

        const fileName = (file || '').split(/[\\/]/).pop() || file;

        wrap.innerHTML = `
            <div class="code-wrapper" style="margin: 0; border: none; background: transparent;">
                <div class="code-header" style="justify-content: space-between;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size: 16px;">${svgIconNoMargin('sparkles')}</span>
                        <span style="color:var(--accent); font-weight:600;">自动应用更改 (Auto Applied)</span>
                    </div>
                </div>
                <div class="code-content" style="padding: 12px; font-family: var(--vscode-editor-font-family, monospace); white-space: normal;">
                    <div style="margin-bottom: 8px;">
                        <span style="opacity: 0.6;">文件:</span> 
                        <span style="font-weight: 600; color: var(--vscode-textPreformat-foreground);">${escapeHtml(fileName)}</span>
                        ${isNewFile ? '<span style="border: 1px solid var(--accent); color: var(--accent); border-radius: 3px; padding: 1px 4px; font-size: 10px; margin-left: 6px;">新文件</span>' : ''}
                    </div>
                    <div style="font-size: 11px; opacity: 0.6; word-break: break-all; margin-bottom: 4px;">路径: ${escapeHtml(file)}</div>
                </div>
            </div>`;

        chatArea.appendChild(wrap);
        scrollBottom();
    }
    function showPendingWriteCard(file: string, messageId: string, isNewFile: boolean) {
        const fileName = (file || '').split(/[\\/]/).pop() || file;
        const div = document.createElement('div');
        const card = document.createElement('div');
        card.className = 'diff-card';
        const safeId = escapeHtml(messageId);
        const hint = isNewFile ? '新文件已在编辑器中打开，请确认内容后决定' : '文件对比已在 VSCode 差异编辑器中打开';
        card.innerHTML =
            '<div class="diff-card-header">' +
            svgIcon('edit') + '请求' + (isNewFile ? '创建' : '修改') + ': <strong>' + escapeHtml(fileName) + '</strong>' +
            '<span class="diff-card-hint">' + hint + '</span></div>' +
            '<div class="diff-card-actions">' +
            '<button class="diff-accept-btn" data-msgid="' + safeId + '">' + svgIcon('check') + '接受</button>' +
            '<button class="diff-reject-btn" data-msgid="' + safeId + '">' + svgIcon('x') + '拒绝</button>' +
            '</div>';
        (card.querySelector('.diff-accept-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-reject-btn') as HTMLButtonElement).disabled = true;
            this.innerHTML = svgIcon('check') + '已接受';
            vscode.postMessage({ type: 'confirmWriteFile', messageId });
            dismissCard(div, 400);
        });
        (card.querySelector('.diff-reject-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-accept-btn') as HTMLButtonElement).disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
            dismissCard(div, 400);
        });
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
    }

    // ── Floating Card Queue ──────────────────────────────────────────────────
    let floatingCardQueue: HTMLElement[] = [];
    let isShowingFloatingCard = false;

    function processFloatingCardQueue() {
        if (isShowingFloatingCard || floatingCardQueue.length === 0) return;
        const div = floatingCardQueue.shift()!;
        isShowingFloatingCard = true;
        const floatingCardArea = document.getElementById('floatingCardArea');
        if (floatingCardArea) {
            floatingCardArea.appendChild(div);
        } else {
            chatArea.appendChild(div);
        }
        scrollBottom();
    }

    // ── Permission request card ─────────────────────────────────────────────────
    function showPermissionCard(permissionId: string, tool: string, description: string, command: string) {
        const div = document.createElement('div');
        div.className = 'permission-card';
        div.dataset.permId = permissionId;
        const safeId = escapeHtml(permissionId);
        
        let actionsHtml = `<div class="permission-card-actions">` +
            `<button class="permission-allow-btn" data-permid="${safeId}">${svgIcon('check')}允许</button>` +
            `<button class="permission-deny-btn" data-permid="${safeId}">${svgIcon('x')}拒绝</button>`;
            
        if (tool === 'run_command') {
            actionsHtml += `<button class="permission-always-btn" data-permid="${safeId}" style="margin-left:auto; font-size:0.8em; opacity:0.8" title="当前会话期间一直允许">${svgIcon('check')}一直允许</button>`;
        }
        actionsHtml += `</div>`;
        
        div.innerHTML =
            `<div class="permission-card-header">` +
            `<span class="permission-card-icon">${svgIconNoMargin('key')}</span>` +
            `<div class="permission-card-body">` +
            `<div class="permission-card-title">${escapeHtml(description)}</div>` +
            (command ? `<div class="permission-card-cmd">${escapeHtml(command)}</div>` : '') +
            `</div></div>` +
            actionsHtml;
            
        (div.querySelector('.permission-allow-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; 
            const denyBtn = div.querySelector('.permission-deny-btn') as HTMLButtonElement;
            if (denyBtn) denyBtn.disabled = true;
            const alwaysBtn = div.querySelector('.permission-always-btn') as HTMLButtonElement;
            if (alwaysBtn) alwaysBtn.disabled = true;
            
            this.innerHTML = svgIcon('check') + '已允许';
            vscode.postMessage({ type: 'permissionResponse', permissionId, allowed: true });
            dismissCard(div, 400, () => {
                isShowingFloatingCard = false;
                processFloatingCardQueue();
            });
        });
        
        (div.querySelector('.permission-deny-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; 
            const allowBtn = div.querySelector('.permission-allow-btn') as HTMLButtonElement;
            if (allowBtn) allowBtn.disabled = true;
            const alwaysBtn = div.querySelector('.permission-always-btn') as HTMLButtonElement;
            if (alwaysBtn) alwaysBtn.disabled = true;
            
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'permissionResponse', permissionId, allowed: false });
            dismissCard(div, 400, () => {
                isShowingFloatingCard = false;
                processFloatingCardQueue();
            });
        });
        
        const alwaysBtn = div.querySelector('.permission-always-btn') as HTMLButtonElement;
        if (alwaysBtn) {
            alwaysBtn.addEventListener('click', function() {
                this.disabled = true;
                const denyBtn = div.querySelector('.permission-deny-btn') as HTMLButtonElement;
                if (denyBtn) denyBtn.disabled = true;
                const allowBtn = div.querySelector('.permission-allow-btn') as HTMLButtonElement;
                if (allowBtn) allowBtn.disabled = true;
                
                this.innerHTML = svgIcon('check') + '已一直允许';
                vscode.postMessage({ type: 'permissionResponse', permissionId, allowed: true, alwaysAllow: true });
                dismissCard(div, 400, () => {
                    isShowingFloatingCard = false;
                    processFloatingCardQueue();
                });
            });
        }
        
        floatingCardQueue.push(div);
        processFloatingCardQueue();
    }

    // ── Message handler ────────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {

            case 'addUserMessage':
                setGenerating(true);
                liveTextBubble = null; liveTextContent = ''; liveThinkContent = '';
                addUserMessage(msg.text, msg.messageIndex, msg.images);
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom(true);
                break;

            case 'startBackgroundGeneration':
                setGenerating(true);
                liveTextBubble = null; liveTextContent = ''; liveThinkContent = '';
                // Do not add user message bubble, but still render the assistant div
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom(true);
                break;

            case 'agentStep':
                applyLiveStep(msg.step);
                break;

            case 'generationComplete': {
                setGenerating(false);
                flushLiveText();
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                
                // Clear any unresolved interactive cards (permission, diff)
                floatingCardQueue = [];
                isShowingFloatingCard = false;
                document.querySelectorAll('.permission-card, .diff-card').forEach(el => dismissCard(el as HTMLElement, 0));

                const r = msg.result;
                const completedMsg = buildAssistantMessage(
                    r.explanation || (r.steps && r.steps.length ? '' : '完成'),
                    r.steps,
                    Date.now()
                );
                chatArea.appendChild(completedMsg);
                // Use real tokenUsage from result if available, else fall back to rough estimate
                if (r.tokenUsage && r.tokenUsage.total > 0) {
                    const gaugeUsage = r.tokenUsage.contextWindowTokens ?? r.tokenUsage.input ?? r.tokenUsage.total;
                    totalConversationTokens = r.tokenUsage.total;
                    updateTokenUsage(gaugeUsage, contextLimit);
                    // Show cost badge
                    const label = document.getElementById('tokenUsageLabel');
                    if (label && r.tokenUsage.estimatedCostCny > 0) {
                        const cost = r.tokenUsage.estimatedCostCny < 0.01
                            ? '<¥0.01'
                            : '¥' + r.tokenUsage.estimatedCostCny.toFixed(2);
                        label.textContent = label.textContent + '  ·  ' + cost;
                    }
                } else {
                    // Rough estimate fallback (no API usage data)
                    const stepTokens = r.steps ? r.steps.reduce((sum: number, s: any) => {
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
                liveTextBubble = null; liveTextContent = ''; liveThinkContent = '';
                if (currentAssistantDiv) { currentAssistantDiv.remove(); currentAssistantDiv = null; }
                
                // Clear any unresolved interactive cards
                floatingCardQueue = [];
                isShowingFloatingCard = false;
                document.querySelectorAll('.permission-card, .diff-card').forEach(el => dismissCard(el as HTMLElement, 0));

                chatArea.appendChild(buildAssistantMessage(svgIcon('x') + ' ' + msg.error, [], Date.now()));
                scrollBottom(true);
                break;

            case 'clearChat':
                while (chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                setGenerating(false);
                currentAssistantDiv = null;
                liveTextBubble = null; liveTextContent = ''; liveThinkContent = '';
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
                    for (const item of Array.from(list.querySelectorAll(`.topic-item[data-topic-id="${escapeHtml(msg.topicId)}"]`))) {
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
                notif.innerHTML = `${svgIconNoMargin('gitBranch')} 已从此处分叉为新话题: ${escapeHtml(msg.title)}`;
                chatArea.appendChild(notif);
                scrollBottom();
                break;
            }

            case 'loadTopicMessages':
                msg.messages.forEach((m: any, idx: number) => {
                    if (m.isHidden === true) return;
                    
                    // M4 fix: pass images array when restoring user messages from history
                    if (m.role === 'user') addUserMessage(m.content, idx, m.images);
                    else {
                        chatArea.appendChild(buildAssistantMessage(m.content, m.steps, null));
                        scrollBottom();
                        // Restore custom UI cards from steps
                        if (m.steps) {
                            const pCard = m.steps.find((s: any) => s.type === 'plan_card');
                            if (pCard && pCard.toolResult) {
                                window.dispatchEvent(new MessageEvent('message', {
                                    data: { type: 'renderPlan', sections: pCard.toolResult, planText: pCard.content }
                                }));
                            }
                            const wtCard = m.steps.find((s: any) => s.type === 'walkthrough_card');
                            if (wtCard && wtCard.toolResult) {
                                window.dispatchEvent(new MessageEvent('message', {
                                    data: { type: 'renderWalkthrough', sections: wtCard.toolResult }
                                }));
                            }
                        }
                    }
                });
                break;

            case 'messageRetracted': {
                // Find the retracted message element and remove it plus ALL subsequent siblings
                const rd = messageIndexMap.get(msg.messageIndex);
                if (rd) {
                    // Collect all nodes from rd onwards (inclusive) and remove them
                    const toRemove: Element[] = [];
                    let cur: Element | null = rd;
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
                banner.innerHTML = msg.isGenerating
                    ? `${svgIconNoMargin('zap')} AI 正在后台运行（面板重新打开时恢复显示）`
                    : `${svgIconNoMargin('clipboard')} 以下为 AI 上次运行记录`;
                chatArea.appendChild(banner);
                // Replay each step
                for (const step of msg.steps) {
                    applyLiveStep(step);
                }
                if (msg.isGenerating) {
                    // Show generating indicator
                    sendBtn.classList.add('cancel-mode');
                    const sendIcon = sendBtn.querySelector('.send-icon') as HTMLElement | null;
                    const stopIcon = sendBtn.querySelector('.stop-icon') as HTMLElement | null;
                    if (sendIcon) sendIcon.style.display = 'none';
                    if (stopIcon) stopIcon.style.display = 'inline-block';
                }
                scrollBottom();
                break;
            }

            case 'todoUpdate': renderTodos(msg.todos); break;

            case 'autoWriteFile': showAutoWriteCard(msg.file, msg.isNewFile); break;

            case 'skillsList': {
                const list = document.getElementById('installedSkillsList');
                if (list) {
                    list.innerHTML = '';
                    if (!msg.skills || msg.skills.length === 0) {
                        list.innerHTML = '<div style="opacity:0.5; font-size:11px;">暂无本地技能</div>';
                    } else {
                        msg.skills.forEach((skill: string) => {
                            const row = document.createElement('div');
                            row.style.display = 'flex';
                            row.style.justifyContent = 'space-between';
                            row.style.alignItems = 'center';
                            row.innerHTML = `<span style="font-family:monospace;">${escapeHtml(skill)}</span>
                                <button class="detect-btn" data-skill="${escapeHtml(skill)}" style="padding:0 6px; width:auto; border-radius:4px;" title="删除此技能">${svgIconNoMargin('trash')}</button>`;
                            row.querySelector('button')!.addEventListener('click', (e) => {
                                const btn = e.currentTarget as HTMLButtonElement;
                                btn.disabled = true; btn.textContent = '...';
                                vscode.postMessage({ type: 'deleteSkill', skill: btn.dataset.skill });
                            });
                            list.appendChild(row);
                        });
                    }
                }
                break;
            }

            case 'skillInstallComplete': {
                const btn = document.getElementById('installSkillBtn') as HTMLButtonElement;
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = '安装/导入';
                }
                const input = document.getElementById('skillSourceInput') as HTMLInputElement;
                if (input && msg.success) input.value = '';
                break;
            }

            case 'settingsData':
                if (msg.current && msg.current.maxContextTokens > 0) contextLimit = msg.current.maxContextTokens;
                // Cache model context token map for use in updateModelUI
                if (msg.modelContextTokens) settingsModelContextTokens = msg.modelContextTokens;
                if (msg.thinkingModelPrefixes) settingsThinkingPrefixes = msg.thinkingModelPrefixes;
                updateQuickModelSelector(msg.providers, msg.current, msg.ollamaModels);
                if (msg.showPanel) showSettingsPage(msg.providers, msg.current, msg.ollamaModels);
                break;

            case 'ollamaModels': {
                const db = document.getElementById('detectBtn') as HTMLButtonElement | null;
                if (db) { db.disabled = false; db.innerHTML = svgIcon('search') + '检测'; }
                if (msg.error) { document.getElementById('modelHint')!.textContent = msg.error; }
                else { settingsOllamaModels = msg.models; updateModelUI((document.getElementById('settingsProvider') as HTMLSelectElement).value, '', msg.models); }
                break;
            }
            case 'apiModelsFetched': {
                const fb = document.getElementById('fetchApiModelsBtn') as HTMLButtonElement | null;
                if (fb) { fb.disabled = false; fb.innerHTML = svgIcon('cloud') + '拉取支持的模型'; }
                if (msg.error) { document.getElementById('apiKeyStatus')!.textContent = '获取失败: ' + msg.error; document.getElementById('apiKeyStatus')!.style.color = '#ff9800'; }
                else {
                    const p = settingsProviders.find(p => p.id === msg.providerId);
                    if (p && msg.models && msg.models.length > 0) {
                        const newModels = msg.models.map((m: any) => m.id);
                        for (const m of newModels) {
                            if (!p.models.includes(m)) p.models.push(m);
                        }
                        if (msg.dynContexts) {
                            Object.assign(settingsModelContextTokens, msg.dynContexts);
                        }
                        updateModelUI(msg.providerId, getSelectedModel(), null);
                        const ctxInfo = msg.ctxNote ? ` ${msg.ctxNote}` : '';
                        document.getElementById('modelHint')!.textContent = `成功从端点加载了 ${newModels.length} 个模型！${ctxInfo}`;
                        document.getElementById('apiKeyStatus')!.innerHTML = svgIcon('check') + '已成功获取模型';
                        document.getElementById('apiKeyStatus')!.style.color = '#4caf50';
                    }
                }
                break;
            }
            case 'testConnectionResult': {
                const tr = document.getElementById('testResult');
                if (tr) {
                    tr.className = 'test-result ' + (msg.ok ? 'ok' : 'fail');
                    tr.textContent = msg.message;
                }
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
                    预估成本: <span style="color:#4caf50;">¥${typeof stats.totalCostCny === 'number' ? stats.totalCostCny.toFixed(2) : '0.00'}</span><br>
                    <span style="font-size:11px; opacity:0.6;">共 ${stats.totalCalls ?? 0} 次调用</span>
                </div>`;

                // ── Provider breakdown ──
                html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                html += '<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">按 Provider</div>';
                for (const [providerId, pStats] of Object.entries(stats.byProvider || {})) {
                    html += `<div style="display:flex; justify-content:space-between; margin-bottom: 3px;">
                                <span style="opacity:0.8;">${providerId}</span>
                                <span><b>${(pStats as any).tokens.toLocaleString()}</b> <span style="opacity:0.5; font-size:10px;">(¥${typeof (pStats as any).costCny === 'number' ? (pStats as any).costCny.toFixed(2) : '0.00'})</span></span>
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
                    const maxTokens = Math.max(...recent.map((d: any) => d.tokens), 1);
                    html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px;">';
                    html += '<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">近期趋势 (每日)</div>';
                    html += '<div style="display:flex; justify-content:flex-end; align-items:flex-end; gap:4px; height:60px;">';
                    // Show in chronological order (reverse since dailyStats is desc)
                    for (const d of [...recent].reverse()) {
                        const h = Math.max(3, Math.round((d.tokens / maxTokens) * 56));
                        const dayLabel = d.date.slice(5); // MM-DD
                        html += `<div title="${d.date}: ${d.tokens.toLocaleString()} tokens, ${d.callCount} 次调用, ¥${d.costCny.toFixed(2)}" style="flex:1; min-width:12px; max-width:28px;">
                            <div style="background:var(--accent); opacity:0.7; height:${h}px; border-radius:2px 2px 0 0;"></div>
                            <div style="font-size:7px; text-align:center; opacity:0.4; margin-top:1px; overflow:hidden; white-space:nowrap;">${dayLabel}</div>
                        </div>`;
                    }
                    html += '</div></div>';
                }

                // ── Batch 4.2: Tool frequency ──
                if (stats.toolFrequency && stats.toolFrequency.length > 0) {
                    html += '<div style="border-top: 1px dashed var(--border); padding-top: 6px; margin-bottom: 10px;">';
                    html += '<div style="font-size:11px; opacity:0.5; margin-bottom:4px;">工具使用频率</div>';
                    const topTools = stats.toolFrequency.slice(0, 8);
                    for (const t of topTools) {
                        const barW = Math.max(2, t.percentage);
                        html += `<div style="margin-bottom: 4px;">
                            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:2px;">
                                <span style="opacity:0.85; font-family:var(--vscode-editor-font-family,monospace);">${escapeHtml(t.tool)}</span>
                                <span style="opacity:0.6;">${t.count}× (${t.percentage}%)</span>
                            </div>
                            <div style="background:var(--border); border-radius:3px; height:4px; overflow:hidden;">
                                <div style="width:${barW}%; height:100%; background:cornflowerblue; border-radius:3px; transition:width 0.3s;"></div>
                            </div>
                        </div>`;
                    }
                    html += '</div>';
                }

                // ── Batch 4.2: Average response time ──
                if (stats.avgResponseMs && stats.avgResponseMs > 0) {
                    const avgSec = (stats.avgResponseMs / 1000).toFixed(1);
                    html += `<div style="border-top: 1px dashed var(--border); padding-top: 6px; font-size:11px; opacity:0.7;">
                        平均响应时间: <b>${avgSec}s</b> (${stats.avgResponseMs}ms)
                    </div>`;
                }

                c.innerHTML = html;
                break;
            }

            case 'planFileSaved': {
                // Compact card — just "open file" button; annotation is handled by renderPlan below
                const card = document.createElement('div');
                card.className = 'plan-file-card';
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin('clipboard')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">计划已导出</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                    </div>
                    <div class="plan-file-actions">
                        <button class="plan-open-btn" data-path="${escapeHtml(msg.filePath)}">${svgIconNoMargin('folder')} 打开文件</button>
                    </div>`;
                (card.querySelector('.plan-open-btn') as HTMLElement).addEventListener('click', e => {
                    vscode.postMessage({ type: 'openPlanFile', filePath: (e.currentTarget as HTMLElement).dataset.path });
                });
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'renderPlan': {
                // Remove old plan cards when a new one arrives
                document.querySelectorAll('.annotatable-plan.plan-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                
                // ── Interactive inline annotation view ──────────────────────────
                const annotations: {sectionIdx: number; section: string; note: string}[] = [];   // { sectionIdx, section, note }

                const wrap = document.createElement('div');
                wrap.className = 'annotatable-plan plan-card-wrap';

                // Header row
                const header = document.createElement('div');
                header.className = 'ap-header';
                header.innerHTML = `<span class="ap-header-title">${svgIcon('edit')}在线批注</span>
                    <span class="ap-header-hint">点击段落添加批注</span>
                    <div style="display:flex; gap:6px;">
                        <button class="ap-approve-btn" style="background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:4px 10px; border-radius:2px; cursor:pointer; min-width:80px;">${svgIcon('check')}同意执行</button>
                        <button class="ap-submit-btn" disabled>${svgIconNoMargin('upload')} 提交批注 (0)</button>
                    </div>`;
                wrap.appendChild(header);

                const submitBtn = header.querySelector('.ap-submit-btn') as HTMLButtonElement;
                const approveBtn = header.querySelector('.ap-approve-btn') as HTMLButtonElement;

                function updateSubmitBtn() {
                    submitBtn.innerHTML = `${svgIconNoMargin('upload')} 提交批注 (${annotations.length})`;
                    submitBtn.disabled = annotations.length === 0;
                }

                approveBtn.addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'submitPlanAnnotations',
                        annotations: annotations.map((a: any) => ({ section: a.section, note: a.note }))
                    });
                    approveBtn.innerHTML = svgIcon('check') + '已开始执行...';
                    approveBtn.disabled = true;
                    submitBtn.disabled = true;
                    dismissCard(wrap, 400);
                });

                submitBtn.addEventListener('click', () => {
                    if (annotations.length === 0) return;
                    vscode.postMessage({
                        type: 'revisePlanWithAnnotations',
                        annotations: annotations.map((a: any) => ({ section: a.section, note: a.note }))
                    });
                    // Visual feedback
                    submitBtn.innerHTML = svgIcon('check') + '已提交';
                    submitBtn.disabled = true;
                });

                // Sections
                const sectionsWrap = document.createElement('div');
                sectionsWrap.className = 'ap-sections';

                msg.sections.forEach((section: string, idx: number) => {
                    const row = document.createElement('div');
                    row.className = 'ap-row';
                    row.dataset.idx = String(idx);

                    // Section text (rendered using full markdown parser)
                    const textDiv = document.createElement('div');
                    textDiv.className = 'ap-section-text markdown-body msg-bubble';
                    textDiv.innerHTML = renderMarkdown(section);

                    // Add-comment button (shows on hover)
                    const addBtn = document.createElement('button');
                    addBtn.className = 'ap-add-btn';
                    addBtn.title = '添加批注';
                    addBtn.innerHTML = svgIconNoMargin('messageSquare');

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
                        const ta = inputBox.querySelector('.ap-textarea') as HTMLTextAreaElement;
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
                        const val = (inputBox.querySelector('.ap-textarea') as HTMLTextAreaElement).value.trim();
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
                            bubble.innerHTML = `<span class="ap-bubble-icon">${svgIconNoMargin('messageSquare')}</span><span class="ap-bubble-text">${escapeHtml(val)}</span><button class="ap-bubble-edit">编辑</button>`;
                            bubble.querySelector('.ap-bubble-edit')!.addEventListener('click', e => {
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
                    inputBox.querySelector('.ap-confirm-btn')!.addEventListener('click', confirmAnnotation);
                    inputBox.querySelector('.ap-cancel-btn')!.addEventListener('click', closeInput);
                    inputBox.querySelector('.ap-textarea')!.addEventListener('keydown', (e: Event) => {
                        const ke = e as KeyboardEvent;
                        if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) confirmAnnotation();
                        if (ke.key === 'Escape') closeInput();
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

            case 'walkthroughFileSaved': {
                const card = document.createElement('div');
                card.className = 'plan-file-card walkthrough-file-card';
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin('flag')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">Walkthrough 报告已导出</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                    </div>
                    <div class="plan-file-actions">
                        <button class="plan-open-btn" data-path="${escapeHtml(msg.filePath)}">${svgIconNoMargin('folder')} 打开文件</button>
                    </div>`;
                (card.querySelector('.plan-open-btn') as HTMLElement).addEventListener('click', e => {
                    vscode.postMessage({ type: 'openPlanFile', filePath: (e.currentTarget as HTMLElement).dataset.path });
                });
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'renderWalkthrough': {
                // Remove old walkthrough cards when a new one arrives
                document.querySelectorAll('.annotatable-plan.walkthrough-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));

                const annotations: {sectionIdx: number; section: string; note: string}[] = [];

                const wrap = document.createElement('div');
                wrap.className = 'annotatable-plan walkthrough-card-wrap';

                const header = document.createElement('div');
                header.className = 'ap-header';
                header.innerHTML = `<span class="ap-header-title">${svgIcon('flag')}Walkthrough 批注</span>
                    <span class="ap-header-hint">点击段落添加批注要求</span>
                    <div style="display:flex; gap:6px;">
                        <button class="ap-approve-btn" style="background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; padding:4px 10px; border-radius:2px; cursor:pointer; min-width:80px;">${svgIcon('check')}确认完成</button>
                        <button class="ap-submit-btn" disabled>${svgIconNoMargin('upload')} 重新修改 (0)</button>
                    </div>`;
                wrap.appendChild(header);

                const submitBtn = header.querySelector('.ap-submit-btn') as HTMLButtonElement;
                const approveBtn = header.querySelector('.ap-approve-btn') as HTMLButtonElement;

                function updateSubmitBtn() {
                    submitBtn.innerHTML = `${svgIconNoMargin('upload')} 重新修改 (${annotations.length})`;
                    submitBtn.disabled = annotations.length === 0;
                }

                approveBtn.addEventListener('click', () => {
                    approveBtn.innerHTML = svgIcon('check') + '已确认';
                    approveBtn.disabled = true;
                    submitBtn.disabled = true;
                    wrap.querySelectorAll('.ap-section').forEach(el => el.classList.remove('selected'));
                    dismissCard(wrap, 400);
                });

                submitBtn.addEventListener('click', () => {
                    if (annotations.length === 0) return;
                    vscode.postMessage({
                        type: 'reviseWalkthroughWithAnnotations',
                        annotations: annotations.map((a: any) => ({ section: a.section, note: a.note }))
                    });
                    submitBtn.innerHTML = svgIcon('check') + '已提交';
                    submitBtn.disabled = true;
                    approveBtn.disabled = true;
                });

                const sectionsWrap = document.createElement('div');
                sectionsWrap.className = 'ap-sections';

                msg.sections.forEach((section: string, idx: number) => {
                    const row = document.createElement('div');
                    row.className = 'ap-row';
                    row.dataset.idx = String(idx);

                    const textDiv = document.createElement('div');
                    textDiv.className = 'ap-section-text markdown-body msg-bubble';
                    textDiv.innerHTML = renderMarkdown(section);

                    const addBtn = document.createElement('button');
                    addBtn.className = 'ap-add-btn';
                    addBtn.title = '提出修改要求';
                    addBtn.innerHTML = svgIconNoMargin('messageSquare');

                    const bubble = document.createElement('div');
                    bubble.className = 'ap-bubble';
                    bubble.style.display = 'none';

                    const inputBox = document.createElement('div');
                    inputBox.className = 'ap-input-box';
                    inputBox.style.display = 'none';
                    inputBox.innerHTML = `
                        <textarea class="ap-textarea" rows="3" placeholder="告诉 AI 哪里需要如何修改…"></textarea>
                        <div class="ap-input-actions">
                            <button class="ap-confirm-btn">确定</button>
                            <button class="ap-cancel-btn">取消</button>
                        </div>`;

                    function openInput() {
                        const existingEntry = annotations.find(a => a.sectionIdx === idx);
                        const ta = inputBox.querySelector('.ap-textarea') as HTMLTextAreaElement;
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
                        const val = (inputBox.querySelector('.ap-textarea') as HTMLTextAreaElement).value.trim();
                        closeInput();
                        if (!val) {
                            const i = annotations.findIndex(a => a.sectionIdx === idx);
                            if (i >= 0) annotations.splice(i, 1);
                            bubble.style.display = 'none';
                            row.classList.remove('ap-row-annotated');
                        } else {
                            const existing = annotations.find(a => a.sectionIdx === idx);
                            if (existing) existing.note = val;
                            else annotations.push({ sectionIdx: idx, section, note: val });
                            bubble.innerHTML = `<span class="ap-bubble-icon">${svgIconNoMargin('messageSquare')}</span><span class="ap-bubble-text">${escapeHtml(val)}</span><button class="ap-bubble-edit">编辑</button>`;
                            bubble.querySelector('.ap-bubble-edit')!.addEventListener('click', e => {
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
                    inputBox.querySelector('.ap-confirm-btn')!.addEventListener('click', confirmAnnotation);
                    inputBox.querySelector('.ap-cancel-btn')!.addEventListener('click', closeInput);
                    inputBox.querySelector('.ap-textarea')!.addEventListener('keydown', (e: Event) => {
                        const ke = e as KeyboardEvent;
                        if (ke.key === 'Enter' && (ke.ctrlKey || ke.metaKey)) confirmAnnotation();
                        if (ke.key === 'Escape') closeInput();
                    });
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
                    const gaugeUsage = u.contextWindowTokens ?? u.input ?? u.total;
                    totalConversationTokens = u.total;
                    updateTokenUsage(gaugeUsage, contextLimit);
                    // Completely replace the label with token + cost info
                    const label = document.getElementById('tokenUsageLabel');
                    if (label) {
                        const base = `~${formatNum(gaugeUsage)} / ${formatNum(contextLimit)} tokens`;
                        const cost = u.estimatedCostCny > 0
                            ? '  ·  ' + (u.estimatedCostCny < 0.01 ? '<¥0.01' : '¥' + u.estimatedCostCny.toFixed(2))
                            : '';
                        label.textContent = base + cost;
                    }
                }
                break;
            }

            case 'diffSummary': {
                if (!msg.files || msg.files.length === 0) break;
                const card = document.createElement('div');
                card.className = 'diff-summary-card';

                // Header with total stats
                let totalAdd = 0, totalDel = 0;
                for (const f of msg.files) { totalAdd += f.additions || 0; totalDel += f.deletions || 0; }
                const headerHtml = `<div class="ds-header">
                    <span class="ds-title">${svgIconNoMargin('edit')} 文件变更摘要</span>
                    <span class="ds-stats"><span class="ds-add">+${totalAdd}</span> <span class="ds-del">-${totalDel}</span> · ${msg.files.length} 个文件</span>
                </div>`;
                card.innerHTML = headerHtml;

                const filesList = document.createElement('div');
                filesList.className = 'ds-files';

                for (const f of msg.files) {
                    const fileEl = document.createElement('div');
                    fileEl.className = 'ds-file';

                    const baseName = f.file.replace(/\\/g, '/').split('/').pop() || f.file;
                    const relPath = f.file.replace(/\\/g, '/');
                    const statusIcon = f.status === 'created' ? svgIconNoMargin('filePlus') : f.status === 'deleted' ? svgIconNoMargin('trash') : svgIconNoMargin('pencil');
                    const statsText = f.additions != null ? `<span class="ds-add">+${f.additions}</span> <span class="ds-del">-${f.deletions || 0}</span>` : escapeHtml(f.diffPreview);

                    const fileHeader = document.createElement('div');
                    fileHeader.className = 'ds-file-header';
                    fileHeader.innerHTML = `<span class="ds-file-icon">${statusIcon}</span>
                        <span class="ds-file-name" title="${escapeHtml(relPath)}">${escapeHtml(baseName)}</span>
                        <span class="ds-file-stats">${statsText}</span>
                        ${f.diffLines && f.diffLines.length > 0 ? '<span class="ds-expand-btn">▶</span>' : ''}`;

                    fileEl.appendChild(fileHeader);

                    // Line-level diff body (collapsed by default)
                    if (f.diffLines && f.diffLines.length > 0) {
                        const diffBody = document.createElement('div');
                        diffBody.className = 'ds-diff-body';
                        diffBody.style.display = 'none';

                        let diffHtml = '<table class="ds-diff-table"><tbody>';
                        for (const line of f.diffLines) {
                            const cls = line.type === 'add' ? 'ds-line-add' : line.type === 'remove' ? 'ds-line-del' : 'ds-line-ctx';
                            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                            const oldNo = line.oldLineNo != null ? String(line.oldLineNo) : '';
                            const newNo = line.newLineNo != null ? String(line.newLineNo) : '';
                            diffHtml += `<tr class="${cls}">
                                <td class="ds-ln">${oldNo}</td>
                                <td class="ds-ln">${newNo}</td>
                                <td class="ds-prefix">${prefix}</td>
                                <td class="ds-code">${escapeHtml(line.content)}</td>
                            </tr>`;
                        }
                        diffHtml += '</tbody></table>';
                        diffBody.innerHTML = diffHtml;
                        fileEl.appendChild(diffBody);

                        // Toggle expand/collapse
                        fileHeader.style.cursor = 'pointer';
                        fileHeader.addEventListener('click', () => {
                            const isOpen = diffBody.style.display !== 'none';
                            diffBody.style.display = isOpen ? 'none' : 'block';
                            const btn = fileHeader.querySelector('.ds-expand-btn');
                            if (btn) btn.textContent = isOpen ? '▶' : '▼';
                        });
                    }

                    filesList.appendChild(fileEl);
                }

                card.appendChild(filesList);
                chatArea.appendChild(card);
                scrollBottom();
                break;
            }

            case 'topicSearchResults': {
                const list = document.getElementById('topicsList');
                if (!list) break;
                if (!msg.results || msg.results.length === 0) {
                    list.innerHTML = '<div style="padding:12px 8px;opacity:0.5;font-size:11px;text-align:center;">无匹配结果</div>';
                    break;
                }
                list.innerHTML = msg.results.map((t: any) =>
                    `<div class="topic-item" data-topic-id="${escapeHtml(t.id)}" onclick="this.dispatchEvent(new CustomEvent('topic-click',{bubbles:true,detail:'${escapeHtml(t.id)}'}))">
                        <span class="topic-title">${escapeHtml(t.title)}</span>
                        <span class="topic-date" style="font-size:10px;opacity:0.5">${new Date(t.updatedAt).toLocaleDateString('zh-CN')}</span>
                    </div>`
                ).join('');
                // Re-attach click handlers
                list.querySelectorAll('.topic-item').forEach(el => {
                    el.addEventListener('click', () => {
                        vscode.postMessage({ type: 'loadTopic', topicId: (el as HTMLElement).dataset.topicId });
                        topicsPanel.classList.remove('show');
                    });
                });
                break;
            }
        }
    });

    // ── Topic list with date groups ────────────────────────────────────────────
    function groupTopicsByDate(topics: any[]) {
        const now = Date.now(); const DAY = 86400000;
        const groups: {label: string; items: any[]}[] = [{ label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '本周', items: [] }, { label: '更早', items: [] }];
        for (const t of topics) {
            const age = now - (t.updatedAt || 0);
            if (age < DAY) groups[0]!.items.push(t);
            else if (age < DAY * 2) groups[1]!.items.push(t);
            else if (age < DAY * 7) groups[2]!.items.push(t);
            else groups[3]!.items.push(t);
        }
        return groups.filter(g => g.items.length > 0);
    }

    const showArchivedCb = document.getElementById('showArchivedCb') as HTMLInputElement;
    if (showArchivedCb) {
        showArchivedCb.addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setShowArchived', show: (e.target as HTMLInputElement).checked });
        });
    }

    function renderTopics(topics: any[]) {
        const list = document.getElementById('topicsList')!;
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
                if (t.archived) {
                    item.style.opacity = '0.6';
                    item.style.fontStyle = 'italic';
                }
                const title = document.createElement('span'); title.className = 'topic-title'; 
                title.textContent = t.archived ? `[归档] ${t.title}` : t.title;
                // Action buttons: fork, archive, delete
                const actions = document.createElement('div'); actions.className = 'topic-actions';
                const forkBtn = document.createElement('button');
                forkBtn.className = 'topic-action-btn topic-fork-btn'; forkBtn.innerHTML = svgIconNoMargin('link'); forkBtn.title = '分叉话题';
                forkBtn.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'forkTopic', topicId: t.id, messageIndex: 999 }); });
                const archBtn = document.createElement('button');
                archBtn.className = 'topic-action-btn topic-archive-btn'; 
                archBtn.innerHTML = t.archived ? `${svgIconNoMargin('refresh')} 恢复` : svgIconNoMargin('bookmark'); 
                archBtn.title = t.archived ? '取消归档' : '归档';
                archBtn.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'archiveTopic', topicId: t.id }); });
                const del = document.createElement('button');
                del.className = 'topic-action-btn topic-delete'; del.innerHTML = svgIconNoMargin('trash'); del.title = '删除';
                del.addEventListener('click', e => { e.stopPropagation(); vscode.postMessage({ type: 'deleteTopic', topicId: t.id }); });
                actions.appendChild(forkBtn); actions.appendChild(archBtn); actions.appendChild(del);
                item.appendChild(title); item.appendChild(actions);
                item.addEventListener('click', () => { vscode.postMessage({ type: 'loadTopic', topicId: t.id }); topicsPanel.classList.remove('show'); });
                list.appendChild(item);
            }
        }
    }

    function renderTodos(todos: any[]) {
        if (!todos || !todos.length) { todoPanel.classList.remove('has-items'); document.getElementById('todoList')!.innerHTML = ''; return; }
        todoPanel.classList.add('has-items');
        const icons: Record<string,string> = { pending: '○', in_progress: '●', done: '✓' };
        document.getElementById('todoList')!.innerHTML = todos.map((t: any) => {
            const cls = t.status === 'done' ? 'done' : t.status === 'in_progress' ? 'in_progress' : '';
            return '<div class="todo-item ' + cls + '"><span>' + (icons[t.status] || '○') + '</span>' + escapeHtml(t.content) + '</div>';
        }).join('');
    }

    function updateQuickModelSelector(providers: any[], current: any, ollamaModels: any[]) {
        const qms = document.getElementById('quickModelSelect');
        if (!qms) return;
        const provider = providers.find((p: any) => p.id === current.provider);
        const models: string[] = current.provider === 'ollama' ? (ollamaModels || []).map((m: any) => m.name) : (provider ? provider.models : []);
        qms.innerHTML = '';
        if (models.length > 0) {
            for (const m of models) { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; opt.selected = m === current.model; qms.appendChild(opt); }
        } else { const opt = document.createElement('option'); opt.value = current.model || ''; opt.textContent = current.model || '(未设置)'; qms.appendChild(opt); }
    }

    function showSettingsPage(providers: any[], current: any, ollamaModels: any[]) {
        settingsProviders = providers;
        settingsOllamaModels = ollamaModels || [];
        updateQuickModelSelector(providers, current, ollamaModels);
        const sel = document.getElementById('settingsProvider') as HTMLSelectElement;
        sel.innerHTML = providers.map((p: any) => '<option value="' + p.id + '"' + (p.id === current.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        const inlineSel = document.getElementById('inlineProvider') as HTMLSelectElement;
        inlineSel.innerHTML = '<option value="">- 与对话相同 -</option>' + providers.map((p: any) => '<option value="' + p.id + '"' + (p.id === current.inlineCompletion?.provider ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
        (document.getElementById('settingsApiKey') as HTMLInputElement).value = '';
        (document.getElementById('settingsEndpoint') as HTMLInputElement).value = current.endpoint || '';
        // Auto-fill context size: prefer per-model lookup, then user-saved value
        const initCtx = autoFillContextForModel(current.model, current.provider) || current.maxContextTokens || 0;
        (document.getElementById('settingsCtx') as HTMLInputElement).value = initCtx;
        (document.getElementById('settingsReasoningEffort') as HTMLSelectElement).value = current.reasoningEffort || 'high';
        (document.getElementById('inlineEnabled') as HTMLInputElement).checked = current.inlineCompletion?.enabled ?? false;
        const overlapEl = document.getElementById('inlineOverlapStripping') as HTMLInputElement | null;
        if (overlapEl) overlapEl.checked = current.inlineCompletion?.overlapStripping ?? true;
        (document.getElementById('inlineEndpoint') as HTMLInputElement).value = current.inlineCompletion?.endpoint || '';
        (document.getElementById('inlineDebounce') as HTMLInputElement).value = current.inlineCompletion?.debounceMs || 500;
        (document.getElementById('agentWriteMode') as HTMLSelectElement).value = current.agentFileWriteMode || 'confirm';
        const ftmEl = document.getElementById('forcedThinkingMode') as HTMLInputElement | null;
        if (ftmEl) ftmEl.checked = current.forcedThinkingMode ?? false;
        // Brave Search API key — show masked placeholder if already set
        const braveKeyEl = document.getElementById('braveSearchApiKey') as HTMLInputElement | null;
        if (braveKeyEl) braveKeyEl.value = current.braveSearchApiKey || '';

        // Render MCP Servers
        const mcpList = document.getElementById('mcpServersList');
        if (mcpList) mcpList.innerHTML = '';
        if (current.mcp?.servers) {
            current.mcp.servers.forEach((s: any) => addMcpServerBlock(s));
        }

        function updateInlineProviderSelect() {
            const currentPid = inlineSel.value;
            // Only FIM-capable providers can be used for inline completion
            const filteredProviders = providers.filter((p: any) => p.supportsFIM);
            
            // Can we allow "Same as chat"? Only if the chat provider supports FIM.
            const chatProviderDef = providers.find((p: any) => p.id === current.provider);
            const chatSupportsFIM = chatProviderDef ? chatProviderDef.supportsFIM : false;
            
            let html = '';
            if (chatSupportsFIM) {
                html += '<option value="">- 与对话相同 -</option>';
            }
            html += filteredProviders.map((p: any) => '<option value="' + p.id + '"' + (p.id === currentPid ? ' selected' : '') + '>' + escapeHtml(p.name) + '</option>').join('');
            
            inlineSel.innerHTML = html;

            // If the current selection is invalid (e.g., "Same as chat" but chat doesn't support FIM, or the provider was removed), auto-select a valid one.
            if ((currentPid === '' && !chatSupportsFIM) || (currentPid !== '' && !filteredProviders.find((p: any) => p.id === currentPid))) {
                inlineSel.value = filteredProviders.length > 0 ? filteredProviders[0].id : '';
            }
        }

        function updateInlineModelSelect(pid: string, selectedModel: string, ollamaModels: any[]) {
            const p2 = providers.find((p: any) => p.id === (pid || current.provider));
            let ms: string[] = (pid || current.provider) === 'ollama' ? (ollamaModels || []).map((m: any) => m.name) : (p2 ? p2.models : []);
            // Filter out thinking/reasoning models — they can't do inline completion
            ms = ms.filter((m: string) => !settingsThinkingPrefixes.some(prefix => m.toLowerCase().includes(prefix.toLowerCase())));

            // Always filter out non-FIM models since fallback Chat Mode is removed
            if (p2) {
                const fimRules = [
                    { key: 'deepseek-v4-pro', capable: true },
                    { key: 'deepseek-v4-flash', capable: true },
                    { key: 'deepseek-coder', capable: true },
                    { key: 'qwen2.5-coder', capable: true },
                    { key: 'codellama', capable: true },
                    { key: 'starcoder', capable: true },
                    { key: 'qwen', capable: false }, // Catch-all for non-coder qwen
                    { key: 'gpt-', capable: false },
                    { key: 'claude-', capable: false },
                    { key: 'gemini-', capable: false }
                ];
                ms = ms.filter((m: string) => {
                    if (!m) return p2.supportsFIM;
                    const lower = m.toLowerCase();
                    for (const rule of fimRules) {
                        if (lower.includes(rule.key)) return rule.capable;
                    }
                    return p2.supportsFIM;
                });
            }

            const inp = document.getElementById('inlineModelInput') as HTMLInputElement;
            inp.value = selectedModel || '';

            setupApDropdown('inlineModelInput', 'inlineModelDatalist', () => ms);
        }
        const inlineProviderSel = document.getElementById('inlineProvider') as HTMLSelectElement;

        updateInlineProviderSelect();
        updateInlineModelSelect(current.inlineCompletion?.provider, current.inlineCompletion?.model, ollamaModels);
        inlineProviderSel.onchange = () => updateInlineModelSelect(inlineProviderSel.value, '', ollamaModels);
        updateModelUI(current.provider, current.model, ollamaModels);
        updateApiKeyStatus(current.provider, providers);
        chatHeader.style.display = 'none';
        document.getElementById('chatArea')!.style.display = 'none';
        if (inputWrapper) inputWrapper.style.display = 'none';
        const mi = document.getElementById('modeIndicator');
        if (mi) mi.style.display = 'none';
        if (todoPanel) todoPanel.style.display = 'none';
        settingsPage.classList.add('active');
        const _tr = document.getElementById('testResult');
        if (_tr) { _tr.className = 'test-result'; _tr.textContent = ''; }
    }

    /** Look up per-model context size with fallback to provider level */
    function autoFillContextForModel(model: string, providerId: string) {
        if (!model) return 0;
        // 1. Exact match
        if (settingsModelContextTokens[model]) return settingsModelContextTokens[model];
        // 2. Prefix match
        const keys = Object.keys(settingsModelContextTokens).sort((a, b) => b.length - a.length);
        for (const key of keys) {
            if (model.startsWith(key)) return settingsModelContextTokens[key];
        }
        // 3. Substring match
        for (const key of keys) {
            if (model.includes(key)) return settingsModelContextTokens[key];
        }
        // 4. Provider-level fallback
        const provider = settingsProviders.find(p => p.id === providerId);
        return (provider && provider.maxContextTokens) ? provider.maxContextTokens : 0;
    }

    function closeSettings() {
        settingsPage.classList.remove('active');
        chatHeader.style.display = '';
        document.getElementById('chatArea')!.style.display = 'flex';
        if (inputWrapper) inputWrapper.style.display = '';
        const mi = document.getElementById('modeIndicator');
        if (mi) mi.style.display = '';
        if (todoPanel) todoPanel.style.display = '';
    }

    function updateApiKeyStatus(providerId: string, providers?: any[]) {
        const p = (providers || settingsProviders).find((x: any) => x.id === providerId);
        const status = document.getElementById('apiKeyStatus')!;
        const group = document.getElementById('apiKeyGroup')!;
        const providerHint = document.getElementById('providerHint')!;
        if (providerId === 'ollama') { group.style.display = 'none'; providerHint.innerHTML = ''; return; }
        group.style.display = '';
        
        if (p && p.hasKey) { status.innerHTML = svgIcon('check') + '已配置 API Key'; status.style.color = '#4caf50'; }
        else { status.innerHTML = svgIcon('warning') + '尚未配置 API Key'; status.style.color = '#ff9800'; }
        
        if (p && p.registerUrl) {
            providerHint.innerHTML = `<a href="${p.registerUrl}" style="color:var(--vscode-textLink-foreground);">申请 API Key 地址</a>`;
        } else {
            providerHint.innerHTML = '';
        }
    }

    function onProviderChange() {
        const id = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        updateModelUI(id, '', settingsOllamaModels);
        updateEndpointHint(id);
        updateApiKeyStatus(id, settingsProviders);
        // Auto-fill context with provider default when user switches provider
        const provider = settingsProviders.find(p => p.id === id);
        if (provider && provider.maxContextTokens > 0) {
            (document.getElementById('settingsCtx') as HTMLInputElement).value = provider.maxContextTokens;
        }
    }

    function updateModelUI(providerId: string, currentModel: string, ollamaModels: any[] | null) {
        const provider = settingsProviders.find((p: any) => p.id === providerId);
        const modelInput = document.getElementById('settingsModelInput') as HTMLInputElement;
        const detectBtn = document.getElementById('detectBtn') as HTMLButtonElement;
        const modelHint = document.getElementById('modelHint')!;

        /** Auto-fill settingsCtx when a model is chosen */
        function onModelSelected(model: string) {
            const ctx = autoFillContextForModel(model, providerId);
            if (ctx > 0) (document.getElementById('settingsCtx') as HTMLInputElement).value = ctx;
        }

        let currentDropdownOpts: string[] = [];

        if (providerId === 'ollama') {
            document.getElementById('apiKeyGroup')!.style.display = 'none';
            if (ollamaModels && ollamaModels.length > 0) {
                currentDropdownOpts = ollamaModels.map((m: any) => m.name);
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
        let _modelInputTimer: ReturnType<typeof setTimeout> | undefined;
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

    function updateEndpointHint(providerId: string) {
        const provider = settingsProviders.find(p => p.id === providerId);
        const hint = document.getElementById('endpointHint');
        const ep = document.getElementById('settingsEndpoint') as HTMLInputElement | null;
        if (provider && hint && ep) { hint.textContent = '默认: ' + (provider.defaultEndpoint || '由 provider 决定'); if (!ep.value) ep.placeholder = provider.defaultEndpoint || '留空使用默认'; }
    }

    function onEndpointChange() {
        if ((document.getElementById('settingsProvider') as HTMLSelectElement).value === 'ollama') {
            settingsOllamaModels = [];
            document.getElementById('settingsModelSelect')!.style.display = 'none';
            document.getElementById('settingsModelInput')!.style.display = '';
            document.getElementById('modelHint')!.textContent = '端点已更改，点击「检测」重新获取模型';
        }
    }

    function detectOllamaModels() {
        const btn = document.getElementById('detectBtn') as HTMLButtonElement; const ep = (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim();
        btn.disabled = true; btn.textContent = '检测中...';
        document.getElementById('modelHint')!.textContent = '正在连接 Ollama...';
        vscode.postMessage({ type: 'detectOllamaModels', endpoint: ep || 'http://localhost:11434/v1' });
    }

    document.getElementById('delModelBtn')!.addEventListener('click', () => {
        const providerId = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        const modelId = (document.getElementById('settingsModelInput') as HTMLInputElement).value.trim();
        if (providerId && modelId) {
            vscode.postMessage({ type: 'deleteDynamicModel', providerId, modelId });
        }
    });

    /** Convert env Record to KEY=VALUE text for textarea display */
    function envToText(env?: Record<string, string>): string {
        if (!env || typeof env !== 'object') return '';
        return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n');
    }

    /** Parse KEY=VALUE text back to Record */
    function parseEnvText(text: string): Record<string, string> | undefined {
        if (!text.trim()) return undefined;
        const env: Record<string, string> = {};
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
            }
        }
        return Object.keys(env).length > 0 ? env : undefined;
    }

    function addMcpServerBlock(server: any = {}) {
        const list = document.getElementById('mcpServersList');
        if (!list) return;
        const div = document.createElement('div');
        div.className = 'mcp-server-block';

        // Normalize: support both flat MCPServerConfig { type, command, args, env }
        // and legacy nested { transport: { type, command, args } } format
        const t = server.transport || server;
        const serverEnv: Record<string, string> | undefined = server.env || t.env;

        div.innerHTML = `
            <div class="mcp-row">
                <input class="settings-input mcp-name" type="text" placeholder="Server 名称" value="${escapeHtml(server.name || '')}" style="flex:1" />
                <select class="settings-select mcp-type" style="width:90px">
                    <option value="stdio" ${(t.type || 'stdio') === 'stdio' ? 'selected' : ''}>stdio</option>
                    <option value="sse" ${t.type === 'sse' ? 'selected' : ''}>sse</option>
                </select>
                <button class="mcp-delete-btn" title="删除">${svgIconNoMargin('trash')}</button>
            </div>
            <div class="mcp-transport-content"></div>
        `;
        list.appendChild(div);

        const typeSel = div.querySelector('.mcp-type') as HTMLSelectElement;
        const contentDiv = div.querySelector('.mcp-transport-content') as HTMLDivElement;

        function renderTransport() {
            if (typeSel.value === 'stdio') {
                contentDiv.innerHTML = `
                    <input class="settings-input mcp-command" type="text" placeholder="Command (例如: uvx, npx)" value="${(t.type || 'stdio') === 'stdio' ? escapeHtml(t.command || '') : ''}" />
                    <input class="settings-input mcp-args" type="text" placeholder="Args (空格分隔)" value="${(t.type || 'stdio') === 'stdio' && t.args ? escapeHtml(t.args.join(' ')) : ''}" style="margin-top:4px" />
                    <textarea class="settings-input mcp-env" rows="3" placeholder="环境变量 (每行 KEY=VALUE，# 开头为注释)" style="margin-top:4px; font-family:monospace; font-size:11px; resize:vertical">${escapeHtml(envToText(serverEnv))}</textarea>
                `;
            } else {
                contentDiv.innerHTML = `
                    <input class="settings-input mcp-url" type="text" placeholder="SSE URL (例如: http://localhost:3000/sse)" value="${t.type === 'sse' ? escapeHtml(t.url || '') : ''}" />
                `;
            }
        }

        renderTransport();
        typeSel.addEventListener('change', renderTransport);

        div.querySelector('.mcp-delete-btn')!.addEventListener('click', () => {
            div.remove();
        });
    }

    document.getElementById('detectBtn')!.addEventListener('click', detectOllamaModels);
    document.getElementById('fetchApiModelsBtn')!.addEventListener('click', fetchApiModels);

    function fetchApiModels() {
        const btn = document.getElementById('fetchApiModelsBtn') as HTMLButtonElement;
        btn.disabled = true; btn.textContent = '拉取中...';
        document.getElementById('apiKeyStatus')!.textContent = '正在发起网络请求拉取支持模型...';
        document.getElementById('apiKeyStatus')!.style.color = 'inherit';
        vscode.postMessage({
            type: 'fetchApiModels',
            providerId: (document.getElementById('settingsProvider') as HTMLSelectElement).value,
            endpoint: (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim(),
            apiKey: (document.getElementById('settingsApiKey') as HTMLInputElement).value
        });
    }

    function getSelectedModel() {
        return (document.getElementById('settingsModelInput') as HTMLInputElement).value.trim();
    }

    function toggleAccordion(id: string) { document.getElementById(id)!.classList.toggle('open'); }

    function saveSettings() {
        const btn = document.getElementById('saveSettingsBtn') as HTMLButtonElement | null;
        if (btn) {
            const originalText = btn.textContent;
            btn.textContent = '✔ 已保存';
            btn.style.backgroundColor = '#28a745';
            setTimeout(() => {
                btn.textContent = originalText;
                btn.style.backgroundColor = '';
            }, 1500);
        }

        // Build flat MCPServerConfig objects (matching backend types.ts interface)
        const mcpServers = Array.from(document.querySelectorAll('.mcp-server-block')).map(block => {
            const type = (block.querySelector('.mcp-type') as HTMLSelectElement).value;
            const name = (block.querySelector('.mcp-name') as HTMLInputElement).value.trim();
            if (type === 'stdio') {
                const command = (block.querySelector('.mcp-command') as HTMLInputElement | null)?.value.trim() || '';
                const argsStr = (block.querySelector('.mcp-args') as HTMLInputElement | null)?.value.trim() || '';
                const args = argsStr ? argsStr.split(/\s+/) : [];
                const envText = (block.querySelector('.mcp-env') as HTMLTextAreaElement | null)?.value || '';
                const env = parseEnvText(envText);
                return { name, type, command, args, ...(env ? { env } : {}) };
            } else {
                const url = (block.querySelector('.mcp-url') as HTMLInputElement | null)?.value.trim() || '';
                return { name, type, url };
            }
        });

        vscode.postMessage({
            type: 'saveSettings', settings: {
                provider: (document.getElementById('settingsProvider') as HTMLSelectElement).value,
                model: getSelectedModel(),
                apiKey: (document.getElementById('settingsApiKey') as HTMLInputElement).value,
                endpoint: (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim(),
                maxContextTokens: parseInt((document.getElementById('settingsCtx') as HTMLInputElement).value) || 0,
                agentFileWriteMode: (document.getElementById('agentWriteMode') as HTMLSelectElement).value,
                forcedThinkingMode: (document.getElementById('forcedThinkingMode') as HTMLInputElement | null)?.checked ?? false,
                reasoningEffort: (document.getElementById('settingsReasoningEffort') as HTMLSelectElement).value || 'high',
                braveSearchApiKey: ((document.getElementById('braveSearchApiKey') as HTMLInputElement | null)?.value || '').trim(),
                inlineCompletion: {
                    enabled: (document.getElementById('inlineEnabled') as HTMLInputElement).checked,
                    provider: (document.getElementById('inlineProvider') as HTMLSelectElement).value,
                    model: (document.getElementById('inlineModelInput') as HTMLInputElement).value.trim(),
                    endpoint: (document.getElementById('inlineEndpoint') as HTMLInputElement).value.trim(),
                    debounceMs: parseInt((document.getElementById('inlineDebounce') as HTMLInputElement).value) || 500,
                    overlapStripping: (document.getElementById('inlineOverlapStripping') as HTMLInputElement | null)?.checked ?? true,
                },
                mcp: { servers: mcpServers }
            }
        });
    }

    function testConnection() {
        const tr = document.getElementById('testResult');
        if (tr) { tr.className = 'test-result'; tr.textContent = '测试中...'; tr.style.display = 'block'; }
        vscode.postMessage({
            type: 'testConnection', settings: {
                provider: (document.getElementById('settingsProvider') as HTMLSelectElement).value,
                model: getSelectedModel(),
                apiKey: (document.getElementById('settingsApiKey') as HTMLInputElement).value,
                endpoint: (document.getElementById('settingsEndpoint') as HTMLInputElement).value.trim(),
                maxContextTokens: 0, agentFileWriteMode: 'confirm',
                reasoningEffort: (document.getElementById('settingsReasoningEffort') as HTMLSelectElement).value || 'high',
                inlineCompletion: { enabled: false, provider: '', model: '', endpoint: '', debounceMs: 1500 },
                mcp: { servers: [] }
            }
        });
    }
})();
