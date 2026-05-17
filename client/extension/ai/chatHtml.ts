/**
 * Eddy CWTool Code — Chat Panel HTML Template
 *
 * Generates the HTML content for the AI chat WebView panel.
 * CSS is loaded from an external chatPanel.css file for maintainability.
 */

import * as vs from 'vscode';
import { Icons, svgIcon, svgIconNoMargin } from '../../webview/svgIcons';

/**
 * Build the full HTML document for the chat panel WebView.
 * @param webview  The VS Code Webview instance (needed for URI resolution and CSP)
 * @param extensionUri  The root URI of the extension (used to resolve asset paths)
 */
export function getChatPanelHtml(webview: vs.Webview, extensionUri: vs.Uri): string {
    const scriptUri = webview.asWebviewUri(
        vs.Uri.joinPath(extensionUri, 'bin', 'client', 'webview', 'chatPanel.js')
    );
    const cssUri = webview.asWebviewUri(
        vs.Uri.joinPath(extensionUri, 'bin', 'client', 'webview', 'chatPanel.css')
    );
    const csp = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src data: blob:;">
<title>Eddy CWTool Code</title>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>
<div class="header" role="banner">
    <div class="header-title">
        <svg class="header-brand-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
            <path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/>
            <circle fill="#e8c840" cx="13" cy="3" r="1"/>
        </svg>
        <span class="brand-text">Eddy CWTool Code</span>
        <div class="current-topic-chip" id="currentTopicChip" title="当前话题">
            <button class="current-topic-title" id="currentTopicTitle" type="button">新话题</button>
            <button class="current-topic-rename" id="currentTopicRename" type="button" title="重命名当前话题" aria-label="重命名当前话题">${svgIconNoMargin('edit')}</button>
        </div>
    </div>
    <div class="header-actions">
        <button class="artifact-toggle" id="btnArtifacts" title="查看 Artifacts" aria-label="打开产物中心">
            ${svgIconNoMargin('layers')}
            <span class="artifact-toggle-text">Artifacts</span>
            <span class="artifact-badge" id="artifactCount">0</span>
        </button>
        <button class="icon-btn" id="btnNewTopic" title="新话题" aria-label="新建对话话题">${svgIconNoMargin('plus')}</button>
        <button class="icon-btn" id="btnTopics" title="历史话题" aria-label="展开历史话题面板">≡</button>
        <button class="icon-btn" id="btnSettings" title="设置" aria-label="打开 AI 设置">${svgIconNoMargin('gear')}</button>
    </div>
</div>

<div class="topics-panel" id="topicsPanel">
    <div class="topics-panel-header">
        <button class="new-topic-btn" id="btnNewTopicPanel">${svgIcon('plus')}新话题</button>
        <div class="topics-search-row">
            <input type="text" id="topicsSearch" class="topics-search-input" placeholder="搜索对话..." autocomplete="off" />
            <label style="font-size:11px; display:flex; align-items:center; gap:4px; opacity:0.8; cursor:pointer;">
                <input type="checkbox" id="showArchivedCb" /> 已归档
            </label>
            <button class="icon-btn topics-export-btn" id="btnExportTopic" title="导出当前对话 (Markdown)" style="font-size:11px;padding:4px 7px;">${svgIcon('save')}导出</button>
        </div>
    </div>
    <div class="topics-panel-summary" id="topicsPanelSummary"></div>
    <div class="topics-list" id="topicsList"></div>
</div>
<div class="mode-indicator" id="modeIndicator">${svgIcon('clipboard')}Plan Mode — 只读分析，不修改文件</div>
<details class="todo-panel" id="todoPanel">
    <summary class="todo-panel-title">Tasks</summary>
    <div id="todoList"></div>
</details>

<div class="artifact-scrim" id="artifactScrim" aria-hidden="true"></div>
<aside class="artifact-drawer" id="artifactDrawer" aria-label="Artifacts" aria-hidden="true">
    <div class="artifact-drawer-header">
        <div>
            <div class="artifact-drawer-title">${svgIcon('layers')}Artifacts</div>
            <div class="artifact-drawer-subtitle">本轮产物、验证和文件变更</div>
        </div>
        <button class="icon-btn artifact-close-btn" id="btnCloseArtifacts" title="关闭 Artifacts" aria-label="关闭产物中心">${svgIconNoMargin('x')}</button>
    </div>
    <div class="artifact-filter-row" aria-label="Artifact filters">
        <button type="button" class="artifact-filter active" data-artifact-filter="all">全部</button>
        <button type="button" class="artifact-filter" data-artifact-filter="plan">计划</button>
        <button type="button" class="artifact-filter" data-artifact-filter="validation">验证</button>
        <button type="button" class="artifact-filter" data-artifact-filter="diff">变更</button>
    </div>
    <div id="artifactList" class="artifact-list"></div>
</aside>

<div class="chat-area" id="chatArea" role="log" aria-live="polite" aria-label="AI 对话消息区">
    <div class="empty-state" id="emptyState">
        <div class="empty-icon"><svg width="40" height="40" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg></div>
        <div style="font-size:13px;font-family:Georgia,serif;">Eddy CWTool Code Assistant</div>
        <div class="empty-tagline">描述你的需求，AI 将生成并验证 Paradox 脚本</div>
        <div class="suggest-cards">
            <button class="suggest-card" data-suggest="检查当前文件的 LSP 错误并修复"><span class="suggest-card-icon">${Icons.search}</span>检查 LSP 错误</button>
            <button class="suggest-card" data-suggest="解释 from、root、prev 这三个作用域的区别和用法"><span class="suggest-card-icon">${Icons.book}</span>作用域解释</button>
            <button class="suggest-card" data-suggest="为当前触发器添加详细注释说明其逻辑"><span class="suggest-card-icon">${Icons.edit}</span>添加注释</button>
            <button class="suggest-card" data-suggest="分析当前文件并列出潜在的语法和逻辑问题"><span class="suggest-card-icon">${Icons.shield}</span>代码审查</button>
        </div>
    </div>
</div>

<div id="tokenUsageBar" style="display:none">
    <div class="token-usage-bar"><div class="token-usage-fill" id="tokenUsageFill" style="width:0%"></div></div>
    <div class="token-usage-label" id="tokenUsageLabel"></div>
</div>

<div id="floatingCardArea" class="floating-card-area"></div>

<div class="input-wrapper" style="position:relative">
    <div id="slashPopup" class="slash-popup"></div>
    <div class="input-container">
        <div class="file-badge-area" id="fileBadgeArea"></div>
        <div class="image-preview-area" id="imagePreviewArea"></div>
        <div class="input-row">
            <textarea id="input" placeholder="描述你的需求... (/ 输入命令)" rows="1" aria-label="向 AI 发送消息"></textarea>
        </div>
        <div class="input-controls">
            <div class="ctrl-group">
                <select class="mode-select" id="modeSel" title="切换模式">
                    <option value="build">构建模式</option>
                    <option value="plan">计划模式</option>
                    <option value="explore">分析模式</option>
                    <option value="utility">泛用模式</option>
                    <option value="review">审查模式</option>
                    <option value="orchestrator">协作模式</option>
                </select>
                <select class="workflow-selector" id="workflowSel" title="AI Workflow">
                    <option value="">Workflow</option>
                </select>
                <select class="model-selector" id="quickModelSelect" title="当前模型"></select>
                <button class="img-pick-btn" id="imgPickBtn" title="上传图片">${svgIconNoMargin('plus')}</button>
            </div>
            <button class="send-btn" id="sendBtn" title="发送 (Enter)" aria-label="发送消息">↑</button>
        </div>
    </div>
</div>

<!-- Settings Page -->
<div class="settings-page" id="settingsPage">
    <div class="settings-header">
        <button class="settings-back-btn" id="settingsBackBtn">←</button>
        <div class="settings-header-text">
            <span class="settings-title">${svgIcon('gear')} AI 设置</span>
            <span class="settings-header-subtitle" id="settingsHeaderSubtitle">查看主模型、上下文、API 和 MCP 状态</span>
        </div>
    </div>
    <div class="settings-overview" id="settingsOverview">
        <div class="settings-overview-main">
            <div class="settings-overview-title" id="settingsOverviewTitle">—</div>
            <div class="settings-overview-subtitle" id="settingsOverviewSubtitle">—</div>
        </div>
        <div class="settings-overview-chips" id="settingsOverviewChips"></div>
    </div>
    <div class="settings-body">
        <div class="accordion-section open" id="chatModelSection">
            <div class="accordion-header" id="accChat"><span>${svgIcon('bot')} 对话模型</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">Provider</label>
                    <select class="settings-select" id="settingsProvider"></select>
                    <div class="settings-hint" id="providerHint" style="margin-top: 4px;"></div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Model</label>
                    <div class="model-row" style="position:relative">
                        <input class="settings-input" id="settingsModelInput" type="text" placeholder="输入模型名，或点右侧下拉框搜索" autocomplete="off" />
                        <div id="settingsModelDatalist" class="ap-dropdown"></div>
                        <button class="detect-btn" id="delModelBtn" style="margin-left:4px; padding:0 8px; width:auto;" title="删除列表中当前字面的模型">${svgIcon('trash')}删除</button>
                        <button class="detect-btn" id="detectBtn" style="display:none; margin-left:4px;">${svgIcon('search')}检测</button>
                    </div>
                    <div class="settings-hint" id="modelHint"></div>
                </div>
                <div class="settings-group" id="apiKeyGroup">
                    <label class="settings-label">${svgIcon('key')} API Key</label>
                    <div class="settings-hint" id="apiKeyStatus" style="color:#4caf50;margin-bottom:3px;"></div>
                    <div class="settings-key-row">
                        <input class="settings-input" id="settingsApiKey" type="password" placeholder="输入新 Key（留空保留已有）" autocomplete="off" />
                        <button class="key-toggle-btn" id="keyToggleBtn">${svgIconNoMargin('eye')}</button>
                        <button class="detect-btn" id="fetchApiModelsBtn" style="margin-left:4px; padding:0 8px; width:auto; border-radius:4px" title="用此 Key 去对应端点拉取模型">${svgIcon('cloud')}获取模型</button>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">${svgIcon('link')} Endpoint <span style="opacity:0.5;font-weight:400">(可选)</span></label>
                    <input class="settings-input" id="settingsEndpoint" type="text" placeholder="留空使用默认" />
                    <div class="settings-hint" id="endpointHint"></div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">${svgIcon('ruler')} 上下文大小 (tokens)</label>
                    <input class="settings-input" id="settingsCtx" type="number" min="0" placeholder="0 = provider 默认" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${svgIcon('stethoscope')} 思考深度 / Reasoning Effort <span style="opacity:0.5;font-weight:400">(供支持的模型使用)</span></label>
                    <select class="settings-select" id="settingsReasoningEffort">
                        <option value="low">Low (快速)</option>
                        <option value="medium">Medium (中等)</option>
                        <option value="high">High (默认)</option>
                        <option value="max">Max (DeepSeek-V4/o3 高强度思考)</option>
                    </select>
                </div>
            </div>
        </div>
        <div class="accordion-section" id="inlineSection">
            <div class="accordion-header" id="accInline"><span>${svgIcon('edit')} 补全模型</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-toggle-row">
                    <span class="settings-toggle-label">启用 AI 补全</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineEnabled"><span class="toggle-track"></span></label>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Provider</label>
                    <select class="settings-select" id="inlineProvider"><option value="">- 与对话相同 -</option></select>
                </div>
                <div class="settings-group">
                    <div class="model-row" style="position:relative">
                        <input class="settings-input" id="inlineModelInput" type="text" placeholder="例如 gpt-4" autocomplete="off" />
                        <div id="inlineModelDatalist" class="ap-dropdown"></div>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Endpoint</label>
                    <input class="settings-input" id="inlineEndpoint" type="text" placeholder="留空与对话相同" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">防抖延迟 (ms)</label>
                    <input class="settings-input" id="inlineDebounce" type="number" min="100" step="100" placeholder="500" />
                </div>
                <div class="settings-toggle-row" style="margin-top:12px;">
                    <span class="settings-toggle-label">防重叠代码修剪 (Overlap Stripping)</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineOverlapStripping"><span class="toggle-track"></span></label>
                </div>
            </div>
        </div>
        <div style="border-top: 1px solid var(--border); margin: 12px 0 8px; padding-top: 6px;">
            <span style="font-size:11px; opacity:0.5; letter-spacing:0.05em;">行为与工具</span>
        </div>
        <div class="accordion-section" id="mcpSection" style="margin-top: 12px;">
            <div class="accordion-header" id="accMcp"><span>${svgIcon('plugin')} MCP (模型上下文协议)</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-hint" style="margin-bottom: 5px;">配置外部数据源为 AI 代理注入额外的上下文上下文信息。</div>
                <div id="mcpServersList" style="display:flex; flex-direction:column; gap:8px;"></div>
                <button class="settings-test-btn" id="addMcpServerBtn" style="margin-top: 4px;">${svgIcon('plus')}新增 MCP Server</button>
            </div>
        </div>
        <div class="accordion-section" id="agentSection" style="margin-top: 12px;">
            <div class="accordion-header" id="accAgent"><span>${svgIcon('shield')} Agent 设置</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">文件写入模式</label>
                    <select class="settings-select" id="agentWriteMode">
                        <option value="confirm">确认模式 — 写操作前 diff 确认（推荐）</option>
                        <option value="auto">自动模式 — 直接写入（高级）</option>
                    </select>
                </div>
                <div class="settings-toggle-row">
                    <span class="settings-toggle-label">强制思考引擎 (Forced Reflection)</span>
                    <label class="toggle-switch"><input type="checkbox" id="forcedThinkingMode"><span class="toggle-track"></span></label>
                    <div class="settings-hint" style="margin-top:4px;">在出错自动修复时，强制 AI 优先调用分析工具“口述”修正方案以降低幻觉率。会增加一些请求延迟。</div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">${svgIcon('search')} Brave Search API Key <span style="opacity:0.5;font-weight:400">(可选)</span></label>
                    <div class="settings-key-row">
                        <input class="settings-input" id="braveSearchApiKey" type="password" placeholder="留空则使用 DuckDuckGo 降级搜索" autocomplete="off" />
                        <button class="key-toggle-btn" id="braveKeyToggleBtn" onclick="var k=document.getElementById('braveSearchApiKey');k.type=k.type==='password'?'text':'password';">${svgIconNoMargin('eye')}</button>
                    </div>
                    <div class="settings-hint">填写后 web_search 工具将使用 Brave Search API，结果质量更高。Key 请在 <a href="https://api.search.brave.com/" target="_blank" rel="noopener">api.search.brave.com</a> 获取。</div>
                    <label class="settings-label">${svgIcon('search')} Exa API Key <span style="opacity:0.5;font-weight:400">(可选)</span></label>
                    <div class="settings-key-row">
                        <input class="settings-input" id="exaApiKey" type="password" placeholder="留空则使用 Brave/DuckDuckGo 降级搜索" autocomplete="off" />
                        <button class="key-toggle-btn" id="exaKeyToggleBtn" onclick="var k=document.getElementById('exaApiKey');k.type=k.type==='password'?'text':'password';">${svgIconNoMargin('eye')}</button>
                    </div>
                    <div class="settings-hint">填写后 codesearch 工具将使用 Exa 语义代码搜索，结果质量更高。Key 请在 <a href="https://dashboard.exa.ai/" target="_blank" rel="noopener">dashboard.exa.ai</a> 获取。</div>
                </div>
                <div class="settings-group" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; margin-top: 10px;">
                    <label class="settings-label">${svgIcon('plugin')} Agent Skills (实验性)</label>
                    <div class="settings-hint">
                        Agent 可以通过加载 <code>npx skills</code> 社区技能包来扩展能力（例如 MiniMax CLI）。<br>
                        技能将仅安装在当前插件的本地存储中。
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 8px;">
                        <input class="settings-input" id="skillSourceInput" type="text" placeholder="例如: MiniMax-AI/cli" autocomplete="off" />
                        <button class="settings-test-btn" id="installSkillBtn" style="width: auto; padding: 0 12px;">安装/导入</button>
                    </div>
                    <div id="installedSkillsList" style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;"></div>
                </div>
                <div class="settings-group" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; margin-top: 10px;">
                    <label class="settings-label">${svgIcon('bot')} 协调模式 — 子 Agent 模型配置</label>
                    <div class="settings-hint" style="margin-bottom:8px;">为每个子 Agent 角色单独指定供应商/模型。留为"继承主设置"则使用上方配置的主模型。</div>
                    <div id="agentModelRows" style="display:flex;flex-direction:column;gap:8px;">
                        ${['explorer|探索者 (Explorer)', 'architect|架构师 (Architect)', 'builder|构建者 (Builder)', 'locWriter|本地化 (LocWriter)', 'locTranslator|翻译 (LocTranslator)', 'reviewer|审查者 (Reviewer)', 'assetGen|资产 (AssetGen)', 'guiExpert|GUI专家 (GuiExpert)']
                            .map(item => {
                                const [role, label] = item.split('|');
                                return `<div class="agent-model-row" data-role="${role}" style="display:flex;align-items:center;gap:6px;">
                                    <span style="font-size:11px;opacity:0.75;min-width:120px;flex-shrink:0;">${label}</span>
                                    <select class="settings-select agent-model-provider" data-role="${role}" style="flex:1;max-width:120px;font-size:11px;padding:3px 5px;">
                                        <option value="__inherit__">继承主设置</option>
                                    </select>
                                    <select class="settings-select agent-model-model" data-role="${role}" style="flex:1;max-width:160px;font-size:11px;padding:3px 5px;">
                                        <option value="__inherit__">继承主设置</option>
                                    </select>
                                </div>`;
                            }).join('\n')}
                    </div>
                </div>
            </div>
        </div>
        <div class="accordion-section" id="usageSection" style="margin-top: 12px; border-color: rgba(100,149,237,0.3);">
            <div class="accordion-header" id="accUsage"><span>${svgIcon('chart')} Token 消耗统计</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <div id="usageStatsContent" style="font-size:12px; line-height: 1.6; opacity: 0.9;">
                        加载中...
                    </div>
                    <button class="settings-test-btn" id="refreshUsageBtn" style="margin-top: 8px;">${svgIcon('refresh')}刷新统计</button>
                    <button class="settings-test-btn" id="clearUsageBtn" style="margin-top: 5px; color: #e66; border-color: rgba(200,80,80,0.3);">${svgIcon('trash')}清空统计</button>
                </div>
            </div>
        </div>
    </div>
    <div class="settings-footer">
        <div class="test-result" id="testResult"></div>
        <div class="settings-footer-actions">
            <button class="settings-test-btn" id="testConnBtn">${svgIcon('info')}测试连接</button>
            <button class="settings-save-btn" id="saveSettingsBtn">${svgIcon('save')}保存设置</button>
        </div>
    </div>
</div>

<script src="${scriptUri}"></script>
</body>
</html>`;
}
