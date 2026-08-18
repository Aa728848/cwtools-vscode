/**
 * Eddy CWTool Code — Chat Panel HTML Template
 *
 * Generates the HTML content for the AI chat WebView panel.
 * CSS is loaded from an external chatPanel.css file for maintainability.
 */

import * as vs from 'vscode';
import { svgIcon, svgIconNoMargin } from '../../webview/svgIcons';

export interface ChatPanelHtmlOptions {
    title?: string;
    bodyClass?: string;
    extraStylesheets?: string[];
    scriptName?: string;
    surface?: 'chat' | 'manager';
    layout?: 'sidebar' | 'detached';
    enableCodexUi?: boolean;
}

/**
 * Build the full HTML document for the chat panel WebView.
 * @param webview  The VS Code Webview instance (needed for URI resolution and CSP)
 * @param extensionUri  The root URI of the extension (used to resolve asset paths)
 */
export function getChatPanelHtml(webview: vs.Webview, extensionUri: vs.Uri, options?: ChatPanelHtmlOptions): string {
    const scriptName = options?.scriptName ?? 'chatPanel.js';
    const scriptUri = webview.asWebviewUri(
        vs.Uri.joinPath(extensionUri, 'bin', 'client', 'webview', scriptName)
    );
    const cssUri = webview.asWebviewUri(
        vs.Uri.joinPath(extensionUri, 'bin', 'client', 'webview', 'chatPanel.css')
    );
    const mermaidScriptUri = webview.asWebviewUri(
        vs.Uri.joinPath(extensionUri, 'bin', 'client', 'webview', 'mermaid.min.js')
    );
    const stylesheetUris = [cssUri.toString(), ...(options?.extraStylesheets ?? [])];
    const stylesheetLinks = stylesheetUris.map(uri => `<link rel="stylesheet" href="${uri}">`).join('\n');
    const csp = webview.cspSource;
    const title = options?.title ?? 'Cwtool Code';
    const surface = options?.surface ?? 'chat';
    const layout = options?.layout ?? 'sidebar';
    const enableCodexUi = options?.enableCodexUi ?? true;
    const bodyClass = [
        options?.bodyClass ?? 'chat-empty',
        enableCodexUi ? 'codex-chat-shell' : '',
        layout === 'detached' ? 'codex-detached-shell' : 'codex-sidebar-shell',
    ].filter(Boolean).join(' ');
    const locale = vs.env.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
    const htmlLang = locale === 'zh-cn' ? 'zh-CN' : 'en';
    const t = (en: string, zh: string) => locale === 'zh-cn' ? zh : en;
    return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src data: blob:;">
<title>${title}</title>
${stylesheetLinks}
</head>
<body class="${bodyClass}" data-locale="${locale}" data-surface="${surface}" data-layout="${layout}" data-codex-ui="${enableCodexUi ? 'true' : 'false'}">
<div class="header" role="banner">
    <div class="header-title">
        <svg class="header-brand-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
            <path fill="#e8c840" d="M12.5 1H3.5C2.121 1 1 2.121 1 3.5V12.5C1 13.879 2.121 15 3.5 15H12.5C13.879 15 15 13.879 15 12.5V3.5C15 2.121 13.879 1 12.5 1ZM6 6.5C6 6.775 5.775 7 5.5 7C5.225 7 5 6.775 5 6.5C5 6.225 5.225 6 5.5 6C5.775 6 6 6.225 6 6.5ZM12.5 14H6V11.5C6 11.225 6.225 11 6.5 11H9.092C9.299 11.581 9.849 12 10.5 12C11.327 12 12 11.327 12 10.5C12 9.673 11.327 9 10.5 9C9.849 9 9.299 9.419 9.092 10H6.5C5.673 10 5 10.673 5 11.5V14H3.5C2.673 14 2 13.327 2 12.5V3.5C2 2.673 2.673 2 3.5 2H5V5.092C4.419 5.299 4 5.849 4 6.5C4 7.327 4.673 8 5.5 8C6.327 8 7 7.327 7 6.5C7 5.849 6.581 5.299 6 5.092V2H12.5C13.327 2 14 2.673 14 3.5V6H10.908C10.701 5.419 10.151 5 9.5 5C8.673 5 8 5.673 8 6.5C8 7.327 8.673 8 9.5 8C10.151 8 10.701 7.581 10.908 7H14V12.5C14 13.327 13.327 14 12.5 14ZM10 10.5C10 10.225 10.225 10 10.5 10C10.775 10 11 10.225 11 10.5C11 10.775 10.775 11 10.5 11C10.225 11 10 10.775 10 10.5ZM10 6.5C10 6.775 9.775 7 9.5 7C9.225 7 9 6.775 9 6.5C9 6.225 9.225 6 9.5 6C9.775 6 10 6.225 10 6.5Z"/>

        </svg>
        <span class="brand-text">Cwtool Code</span>
        <div class="current-topic-chip" id="currentTopicChip" title="${t('Current topic', '当前话题')}">
            <button class="current-topic-title" id="currentTopicTitle" type="button">${t('New topic', '新话题')}</button>
            <button class="current-topic-rename" id="currentTopicRename" type="button" title="${t('Rename current topic', '重命名当前话题')}" aria-label="${t('Rename current topic', '重命名当前话题')}">${svgIconNoMargin('edit')}</button>
        </div>
    </div>
    <div class="header-actions">
        <button class="artifact-toggle" id="btnArtifacts" title="${t('View artifacts', '查看 Artifacts')}" aria-label="${t('Open artifact center', '打开产物中心')}">
            ${svgIconNoMargin('layers')}
            <span class="artifact-toggle-text">Artifacts</span>
            <span class="artifact-badge" id="artifactCount">0</span>
        </button>
        <button class="workspace-toggle" id="btnWorkspace" title="${t('Open workspace', '打开工作区')}" aria-label="${t('Open side workspace', '打开右侧工作区')}">
            ${svgIconNoMargin('folder')}
            <span class="workspace-toggle-text">${t('Workspace', '工作区')}</span>
        </button>
        <button class="icon-btn" id="btnAgentManager" title="${t('Open Agent Manager', '打开 Agent Manager')}" aria-label="${t('Open detached Agent Manager', '打开独立 Agent Manager')}">${svgIconNoMargin('bot')}</button>
        <button class="icon-btn" id="btnNewTopic" title="${t('New topic', '新话题')}" aria-label="${t('Create new chat topic', '新建对话话题')}">${svgIconNoMargin('plus')}</button>
        <button class="icon-btn" id="btnTopics" title="${t('Topic history', '历史话题')}" aria-label="${t('Expand topic history panel', '展开历史话题面板')}">≡</button>
        <button class="icon-btn" id="btnSettings" title="${t('Settings', '设置')}" aria-label="${t('Open AI settings', '打开 AI 设置')}">${svgIconNoMargin('gear')}</button>
    </div>
</div>

<div class="topics-panel" id="topicsPanel">
    <div class="topics-panel-header">
        <button class="new-topic-btn" id="btnNewTopicPanel">${svgIcon('plus')}${t('New topic', '新话题')}</button>
        <div class="topics-search-row">
            <input type="text" id="topicsSearch" class="topics-search-input" placeholder="${t('Search conversations...', '搜索对话...')}" autocomplete="off" />
            <label style="font-size:11px; display:flex; align-items:center; gap:4px; opacity:0.8; cursor:pointer;">
                <input type="checkbox" id="showArchivedCb" /> ${t('Archived', '已归档')}
            </label>
            <button class="icon-btn topics-export-btn" id="btnExportTopic" title="${t('Export current conversation (Markdown)', '导出当前对话 (Markdown)')}" style="font-size:11px;padding:4px 7px;">${svgIcon('save')}${t('Export', '导出')}</button>
        </div>
    </div>
    <div class="topics-panel-summary" id="topicsPanelSummary"></div>
    <div class="topics-list" id="topicsList"></div>
</div>
<div class="mode-indicator" id="modeIndicator">${svgIcon('clipboard')}${t('Plan Mode - read-only analysis, no file changes', 'Plan Mode — 只读分析，不修改文件')}</div>
<details class="todo-panel" id="todoPanel">
    <summary class="todo-panel-title">Tasks</summary>
    <div id="todoList"></div>
</details>

<div class="artifact-scrim" id="artifactScrim" aria-hidden="true"></div>
<aside class="artifact-drawer" id="artifactDrawer" aria-label="Artifacts" aria-hidden="true">
    <div class="artifact-drawer-header">
        <div>
            <div class="artifact-drawer-title">${svgIcon('layers')}Artifacts</div>
            <div class="artifact-drawer-subtitle">${t('Artifacts, validation, and file changes for this run', '本轮产物、验证和文件变更')}</div>
        </div>
        <button class="icon-btn artifact-close-btn" id="btnCloseArtifacts" title="${t('Close artifacts', '关闭 Artifacts')}" aria-label="${t('Close artifact center', '关闭产物中心')}">${svgIconNoMargin('x')}</button>
    </div>
    <div class="artifact-filter-row" aria-label="Artifact filters">
        <button type="button" class="artifact-filter active" data-artifact-filter="all">${t('All', '全部')}</button>
        <button type="button" class="artifact-filter" data-artifact-filter="plan">${t('Plans', '计划')}</button>
        <button type="button" class="artifact-filter" data-artifact-filter="validation">${t('Validation', '验证')}</button>
        <button type="button" class="artifact-filter" data-artifact-filter="diff">${t('Changes', '变更')}</button>
    </div>
    <div id="artifactList" class="artifact-list"></div>
</aside>

<aside class="side-workspace" id="sideWorkspace" aria-label="${t('Side workspace', '右侧工作区')}" aria-hidden="true">
    <div class="side-workspace-header">
        <div class="side-workspace-heading">
            <div class="side-workspace-title" id="sideWorkspaceTitle">${t('Workspace', '工作区')}</div>
            <div class="side-workspace-subtitle" id="sideWorkspaceSubtitle"></div>
        </div>
        <button class="icon-btn side-workspace-close" id="sideWorkspaceClose" title="${t('Close', '关闭')}" aria-label="${t('Close side workspace', '关闭右侧工作区')}">${svgIconNoMargin('x')}</button>
    </div>
    <div class="sw-tabs" id="swTabs" style="display:none">
        <button class="sw-tab active" data-sw-tab="changes">${svgIconNoMargin('pencil')}<span>${t('Changes', '变更')}</span><span class="sw-tab-badge" id="swBadgeChanges"></span></button>
        <button class="sw-tab" data-sw-tab="files">${svgIconNoMargin('folder')}<span>${t('Files', '文件')}</span><span class="sw-tab-badge" id="swBadgeFiles"></span></button>
        <button class="sw-tab" data-sw-tab="artifacts">${svgIconNoMargin('layers')}<span>Artifacts</span><span class="sw-tab-badge" id="swBadgeArtifacts"></span></button>
    </div>
    <div class="side-workspace-body" id="sideWorkspaceBody"></div>
</aside>

<div class="chat-area codex-conversation" id="chatArea" role="log" aria-live="polite" aria-label="${t('AI conversation messages', 'AI 对话消息区')}">
    <div class="empty-state" id="emptyState" aria-hidden="true"></div>
</div>

<div id="floatingCardArea" class="floating-card-area codex-floating-layer"></div>
<div id="slashPopup" class="slash-popup" role="listbox" aria-label="${t('Slash commands', 'Slash 命令')}" aria-hidden="true"></div>

<div class="input-wrapper">
    <div id="composerMenu" class="composer-menu" aria-hidden="true">
        <button class="composer-menu-item" data-composer-action="media">${svgIconNoMargin('upload')}<span>Media</span></button>
        <button class="composer-menu-item" data-composer-action="mentions">${svgIconNoMargin('tag')}<span>Mentions</span></button>
        <button class="composer-menu-item" data-composer-action="workflows">${svgIconNoMargin('sparkles')}<span>Workflows</span></button>
        <div class="composer-menu-divider"></div>
        <button class="composer-menu-item" data-composer-action="plan">${svgIconNoMargin('clipboard')}<span>${t('Plan mode', '计划模式')}</span></button>
        <button class="composer-menu-item" data-composer-action="goal">${svgIconNoMargin('flag')}<span>${t('Set goal', '设置 Goal')}</span></button>
    </div>
    <div id="modeMenu" class="composer-menu mode-menu" aria-hidden="true">
        <div class="composer-menu-section">
            <div class="model-menu-title">${t('Capability domain', '能力领域')}</div>
            <button class="composer-menu-item" data-profile-domain="paradox">${svgIconNoMargin('code')}<span>${t('Paradox / CWTools', 'Paradox / CWTools')}</span></button>
            <button class="composer-menu-item" data-profile-domain="general">${svgIconNoMargin('zap')}<span>${t('General coding', '通用编码')}</span></button>
            <button class="composer-menu-item" data-profile-domain="hybrid">${svgIconNoMargin('layers')}<span>${t('Hybrid coding + CWTools', '混合编码 + CWTools')}</span></button>
        </div>
    </div>
    <div id="modelMenu" class="model-menu" aria-hidden="true">
        <div class="model-menu-title">Model</div>
        <div id="modelMenuList" class="model-menu-list"></div>
    </div>
    <div id="reasoningMenu" class="model-menu reasoning-menu" aria-hidden="true">
        <div class="model-menu-title">${t('Reasoning effort', '推理强度')}</div>
        <div id="reasoningMenuList" class="model-menu-list" role="listbox" aria-label="${t('Reasoning effort', '推理强度')}"></div>
    </div>
    <div id="writeModeMenu" class="model-menu write-mode-menu" aria-hidden="true">
        <div class="model-menu-title" id="writeModeMenuTitle">${t('Permission profile', '权限配置')}</div>
        <div id="writeModeMenuList" class="model-menu-list"></div>
    </div>
    <div class="input-container">
        <div class="file-badge-area" id="fileBadgeArea"></div>
        <div class="image-preview-area" id="imagePreviewArea"></div>
        <div class="input-row">
            <div id="input" class="composer-input" contenteditable="true" data-placeholder="${t('Describe what you need... (/ for commands)', '描述你的需求... (/ 输入命令)')}" role="textbox" aria-multiline="true" aria-label="${t('Send a message to AI', '向 AI 发送消息')}" aria-controls="slashPopup" aria-expanded="false"></div>
        </div>
        <div id="tokenUsageBar" class="composer-token-usage" style="display:none">
            <div class="token-usage-bar"><div class="token-usage-fill" id="tokenUsageFill" style="width:0%"></div></div>
            <div class="token-usage-label" id="tokenUsageLabel"></div>
        </div>
        <div class="input-controls">
            <div class="composer-toolbar">
                <button class="composer-add-btn" id="composerAddBtn" title="${t('Add context', '添加上下文')}" aria-label="${t('Add context', '添加上下文')}">${svgIconNoMargin('plus')}</button>
                <select class="hidden-composer-select" id="quickWriteModeSelect" title="${t('Permission profile', '权限配置')}" aria-hidden="true" tabindex="-1">
                    <option value="confirm">${t('Confirm writes', '确认写入')}</option>
                    <option value="auto" selected>${t('Auto writes', '自动写入')}</option>
                    <option value="auto_review">${t('Auto review', '自动审核')}</option>
                    <option value="full">${t('Full access', '完全放行')}</option>
                </select>
                <button class="composer-model-trigger composer-write-mode-trigger" id="quickWriteModeTrigger" title="${t('Permission profile', '权限配置')}" aria-haspopup="listbox" aria-expanded="false">
                    <span class="composer-trigger-icon" aria-hidden="true">${svgIconNoMargin('shield')}</span>
                    <span id="quickWriteModeLabel">${t('Auto write', '自动写入')}</span>
                    <span class="composer-chevron" aria-hidden="true">v</span>
                </button>
                <button class="composer-model-trigger composer-mode-trigger" id="quickModeTrigger" title="${t('Select capability domain', '选择能力领域')}" aria-haspopup="listbox" aria-expanded="false">
                    <span id="quickModeLabel">Paradox</span>
                    <span class="composer-chevron" aria-hidden="true">v</span>
                </button>
                <div class="composer-chip-row" id="composerChipRow"></div>
                <select class="hidden-composer-select" id="modeSel" title="${t('Legacy mode compatibility', '旧模式兼容')}" aria-hidden="true" tabindex="-1">
                    <option value="build">${t('Build mode', '构建模式')}</option>
                    <option value="plan">${t('Plan mode', '计划模式')}</option>
                    <option value="explore">${t('Explore mode', '分析模式')}</option>
                    <option value="utility">${t('Utility mode', '泛用模式')}</option>
                    <option value="review">${t('Review mode', '审查模式')}</option>
                    <option value="orchestrator">${t('General Multi-Agent', '通用多 Agent')}</option>
                    <option value="script">${t('Paradox Multi-Agent', 'Paradox 多 Agent')}</option>
                </select>
                <select class="hidden-composer-select" id="quickModelSelect" title="${t('Current model', '当前模型')}" aria-hidden="true" tabindex="-1"></select>
                <button class="hidden-composer-action" id="imgPickBtn" title="${t('Upload image', '上传图片')}" aria-hidden="true" tabindex="-1"></button>
            </div>
            <div class="composer-submit-controls">
                <button class="composer-model-trigger" id="quickModelTrigger" title="${t('Select model', '选择模型')}" aria-haspopup="listbox" aria-expanded="false">
                    <span id="quickModelLabel">Model</span>
                    <span class="composer-chevron" aria-hidden="true">v</span>
                </button>
                <select class="hidden-composer-select" id="quickReasoningEffort" title="${t('Reasoning effort', '推理强度')}" aria-label="${t('Reasoning effort', '推理强度')}" aria-hidden="true" tabindex="-1">
                    <option value="high" selected>${t('High', '高')}</option>
                </select>
                <button class="composer-model-trigger composer-reasoning-trigger" id="quickReasoningTrigger" title="${t('Reasoning effort', '推理强度')}" aria-haspopup="listbox" aria-controls="reasoningMenuList" aria-expanded="false">
                    <span id="quickReasoningLabel">${t('High', '高')}</span>
                    <span class="composer-chevron" aria-hidden="true">v</span>
                </button>
                <button class="send-btn" id="sendBtn" title="${t('Send (Enter)', '发送 (Enter)')}" aria-label="${t('Send message', '发送消息')}" disabled>↑</button>
            </div>
        </div>
    </div>
</div>

<!-- Settings Page -->
<div class="settings-page" id="settingsPage">
    <div class="settings-header">
        <button class="settings-back-btn" id="settingsBackBtn">←</button>
        <div class="settings-header-text">
            <span class="settings-title">${svgIcon('gear')} ${t('AI Settings', 'AI 设置')}</span>
            <span class="settings-header-subtitle" id="settingsHeaderSubtitle">${t('View main model, context, API, and MCP status', '查看主模型、上下文、API 和 MCP 状态')}</span>
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
            <div class="accordion-header" id="accChat"><span>${svgIcon('bot')} ${t('Chat model', '对话模型')}</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">Provider</label>
                    <select class="settings-select" id="settingsProvider"></select>
                    <div class="settings-hint" id="providerHint" style="margin-top: 4px;"></div>
                </div>
                <div class="settings-group" id="customApiFormatGroup" style="display:none">
                    <label class="settings-label">Custom API Format</label>
                    <select class="settings-select" id="customApiFormat">
                        <option value="openai-chat-completions">OpenAI Chat Completions</option>
                        <option value="openai-responses">OpenAI Responses API</option>
                        <option value="anthropic-messages">Anthropic Messages</option>
                        <option value="gemini-generate-content">Gemini Native generateContent</option>
                    </select>
                    <div class="settings-hint" id="customApiFormatHint"></div>
                </div>
                <div class="settings-group" id="reasoningKeyGroup">
                    <label class="settings-label">Reasoning field name</label>
                    <input class="settings-input" id="settingsReasoningKey" type="text" placeholder="${t('Auto-detect (default)', '自动探测（默认）')}" autocomplete="off" />
                    <div class="settings-hint" id="reasoningKeyHint">${t('Empty = auto-detect. Set only when the gateway returns thinking content under a non-standard field name.', '留空自动探测；仅当网关用非标准字段名返回思考内容时填写。')}</div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Model</label>
                    <div class="model-row" style="position:relative">
                        <input class="settings-input" id="settingsModelInput" type="text" placeholder="${t('Enter a model name, or use the dropdown on the right', '输入模型名，或点右侧下拉框搜索')}" autocomplete="off" />
                        <div id="settingsModelDatalist" class="ap-dropdown"></div>
                        <button class="detect-btn" id="delModelBtn" style="margin-left:4px; padding:0 8px; width:auto;" title="${t('Delete the current literal model from the list', '删除列表中当前字面的模型')}">${svgIcon('trash')}${t('Delete', '删除')}</button>
                        <button class="detect-btn" id="detectBtn" style="display:none; margin-left:4px;">${svgIcon('search')}${t('Detect', '检测')}</button>
                    </div>
                    <div class="settings-hint" id="modelHint"></div>
                </div>
                <div class="settings-group" id="apiKeyGroup">
                    <label class="settings-label">${svgIcon('key')} API Key</label>
                    <div class="settings-hint" id="apiKeyStatus" style="color:#4caf50;margin-bottom:3px;"></div>
                    <div class="settings-key-row">
                        <input class="settings-input" id="settingsApiKey" type="password" placeholder="${t('Enter a new key (leave empty to keep existing)', '输入新 Key（留空保留已有）')}" autocomplete="off" />
                        <button class="key-toggle-btn" id="keyToggleBtn">${svgIconNoMargin('eye')}</button>
                        <button class="detect-btn" id="fetchApiModelsBtn" style="margin-left:4px; padding:0 8px; width:auto; border-radius:4px" title="${t('Use this key to fetch models from the endpoint', '用此 Key 去对应端点拉取模型')}">${svgIcon('cloud')}${t('Fetch models', '获取模型')}</button>
                        <button class="detect-btn" id="deleteApiKeyBtn" style="margin-left:4px; padding:0 8px; width:auto; border-radius:4px" title="${t('Remove the saved API key for the current provider', '移除当前 Provider 已保存的 API Key')}">${svgIcon('trash')}${t('Remove key', '移除 Key')}</button>
                    </div>
                </div>
                <div class="settings-group" id="codexAccountGroup" style="display:none">
                    <label class="settings-label">${svgIcon('key')} ${t('ChatGPT OAuth account', 'ChatGPT OAuth 账户')}</label>
                    <div class="settings-hint" id="codexAccountStatus"></div>
                    <div class="settings-key-row" style="margin-top:6px">
                        <button class="detect-btn" id="codexLoginBtn" style="padding:0 8px; width:auto; border-radius:4px">${svgIcon('link')}${t('Sign in with ChatGPT', '使用 ChatGPT 登录')}</button>
                        <button class="detect-btn" id="codexRefreshBtn" style="margin-left:4px; padding:0 8px; width:auto; border-radius:4px">${svgIcon('refresh')}${t('Refresh status', '刷新状态')}</button>
                        <button class="detect-btn" id="codexLogoutBtn" style="margin-left:4px; padding:0 8px; width:auto; border-radius:4px; display:none">${svgIcon('trash')}${t('Sign out', '退出账号')}</button>
                    </div>
                    <div class="settings-hint" id="codexQuotaStatus" style="margin-top:6px"></div>
                </div>
                <div class="settings-group" id="endpointGroup">
                    <label class="settings-label">${svgIcon('link')} Endpoint <span style="opacity:0.5;font-weight:400">${t('(optional)', '(可选)')}</span></label>
                    <input class="settings-input" id="settingsEndpoint" type="text" placeholder="${t('Leave empty to use default', '留空使用默认')}" />
                    <div class="settings-hint" id="endpointHint"></div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">${svgIcon('ruler')} ${t('Context size (tokens)', '上下文大小 (tokens)')}</label>
                    <input class="settings-input" id="settingsCtx" type="number" min="0" placeholder="${t('0 = provider default', '0 = provider 默认')}" />
                </div>
                <div class="settings-group" id="settingsReasoningGroup">
                    <label class="settings-label">${svgIcon('stethoscope')} <span id="settingsReasoningLabel">${t('Reasoning effort', '推理强度')}</span> <span id="settingsReasoningHint" style="opacity:0.5;font-weight:400"></span></label>
                    <select class="settings-select" id="settingsReasoningEffort"></select>
                </div>
            </div>
        </div>
        <div class="accordion-section" id="translationPreviewSection">
            <div class="accordion-header" id="accTranslationPreview"><span>${svgIcon('book')} ${t('Translation preview', '翻译预览')}</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">${t('Provider', '提供商')}</label>
                    <select class="settings-select" id="translationPreviewProvider"><option value="">${t('- Same as chat -', '- 与对话相同 -')}</option></select>
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('Model', '模型')}</label>
                    <div class="model-row" style="position:relative">
                        <input class="settings-input" id="translationPreviewModelInput" type="text" placeholder="${t('Leave empty to match chat', '留空与对话相同')}" autocomplete="off" />
                        <div id="translationPreviewModelDatalist" class="ap-dropdown"></div>
                    </div>
                </div>
            </div>
        </div>
        <div class="accordion-section" id="inlineSection">
            <div class="accordion-header" id="accInline"><span>${svgIcon('edit')} ${t('Completion model', '补全模型')}</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-toggle-row">
                    <span class="settings-toggle-label">${t('Enable AI completion', '启用 AI 补全')}</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineEnabled"><span class="toggle-track"></span></label>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Provider</label>
                    <select class="settings-select" id="inlineProvider"><option value="">${t('- Same as chat -', '- 与对话相同 -')}</option></select>
                </div>
                <div class="settings-group">
                    <div class="model-row" style="position:relative">
                        <input class="settings-input" id="inlineModelInput" type="text" placeholder="${t('For example: gpt-4', '例如 gpt-4')}" autocomplete="off" />
                        <div id="inlineModelDatalist" class="ap-dropdown"></div>
                    </div>
                </div>
                <div class="settings-group">
                    <label class="settings-label">Endpoint</label>
                    <input class="settings-input" id="inlineEndpoint" type="text" placeholder="${t('Leave empty to match chat', '留空与对话相同')}" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('Debounce delay (ms)', '防抖延迟 (ms)')}</label>
                    <input class="settings-input" id="inlineDebounce" type="number" min="100" step="100" placeholder="200" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('Max generated tokens', '最大生成 Tokens')}</label>
                    <input class="settings-input" id="inlineMaxTokens" type="number" min="16" step="16" placeholder="128" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('Context lines before cursor', '光标前上下文行数')}</label>
                    <input class="settings-input" id="inlineContextBefore" type="number" min="0" step="1" placeholder="20" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('Context lines after cursor', '光标后上下文行数')}</label>
                    <input class="settings-input" id="inlineContextAfter" type="number" min="1" step="1" placeholder="10" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('Request timeout (ms)', '请求超时 (ms)')}</label>
                    <input class="settings-input" id="inlineRequestTimeout" type="number" min="500" step="100" placeholder="1500" />
                </div>
                <div class="settings-group">
                    <label class="settings-label">${t('MCP cache TTL (ms)', 'MCP 缓存 TTL (ms)')}</label>
                    <input class="settings-input" id="inlineMcpCacheTtl" type="number" min="0" step="1000" placeholder="30000" />
                </div>
                <div class="settings-toggle-row" style="margin-top:12px;">
                    <span class="settings-toggle-label">${t('Enable LSP fast path', '启用 LSP 快路径')}</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineLspFastPath"><span class="toggle-track"></span></label>
                </div>
                <div class="settings-toggle-row" style="margin-top:12px;">
                    <span class="settings-toggle-label">${t('Inject MCP context', '注入 MCP 上下文')}</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineIncludeMcp"><span class="toggle-track"></span></label>
                </div>
                <div class="settings-toggle-row" style="margin-top:12px;">
                    <span class="settings-toggle-label">${t('Overlap stripping', '防重叠代码修剪 (Overlap Stripping)')}</span>
                    <label class="toggle-switch"><input type="checkbox" id="inlineOverlapStripping"><span class="toggle-track"></span></label>
                </div>
            </div>
        </div>
        <div style="border-top: 1px solid var(--border); margin: 12px 0 8px; padding-top: 6px;">
            <span style="font-size:11px; opacity:0.5; letter-spacing:0.05em;">${t('Behavior and tools', '行为与工具')}</span>
        </div>
        <div class="accordion-section" id="mcpSection" style="margin-top: 12px;">
            <div class="accordion-header" id="accMcp"><span>${svgIcon('plugin')} ${t('MCP (Model Context Protocol)', 'MCP (模型上下文协议)')}</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-hint" style="margin-bottom: 5px;">${t('Configure external data sources that inject additional context into the AI agent.', '配置外部数据源为 AI 代理注入额外的上下文信息。')}</div>
                <div id="mcpServersList" style="display:flex; flex-direction:column; gap:8px;"></div>
                <button class="settings-test-btn" id="addMcpServerBtn" style="margin-top: 4px;">${svgIcon('plus')}${t('Add MCP Server', '新增 MCP Server')}</button>
            </div>
        </div>
        <div class="accordion-section" id="agentSection" style="margin-top: 12px;">
            <div class="accordion-header" id="accAgent"><span>${svgIcon('shield')} ${t('Agent settings', 'Agent 设置')}</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <label class="settings-label">${t('File write mode', '文件写入模式')}</label>
                    <select class="settings-select" id="agentWriteMode">
                        <option value="confirm">${t('Confirm mode - review diff before writes (recommended)', '确认模式 — 写操作前 diff 确认（推荐）')}</option>
                        <option value="auto">${t('Auto mode - write directly (advanced)', '自动模式 — 直接写入（高级）')}</option>
                    </select>
                </div>
                <div class="settings-row" style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                    <span class="settings-toggle-label">${t('Auto-review approval requests', '自动审核审批请求 (Auto-review)')}</span>
                    <label class="toggle-switch"><input type="checkbox" id="approvalsAutoReview"><span class="toggle-track"></span></label>
                </div>
                <div class="settings-hint">${t('When enabled, a read-only reviewer model approves most commands first. Unclear, escalated, or destructive actions still ask you.', '开启后由只读评审模型先行审批大部分命令；拿不准、升级请求或破坏性操作仍会询问用户。')}</div>
                <div class="settings-group">
                    <label class="settings-label">${svgIcon('search')} ${t('Web access mode', '网页访问模式')}</label>
                    <select class="settings-select" id="webAccessMode">
                        <option value="disabled">${t('Disabled', '禁用')}</option>
                        <option value="indexed">${t('Indexed search only (recommended)', '仅搜索索引（推荐）')}</option>
                        <option value="live">${t('Live search and page access', '实时搜索和网页访问')}</option>
                    </select>
                    <div class="settings-hint">${t('Web tools are separate from shell-command networking. Live mode opens only public HTTP(S) pages through SSRF and redirect checks.', '网页工具与 Shell 命令联网权限相互独立。实时模式仅通过 SSRF 与重定向检查访问公开 HTTP(S) 网页。')}</div>
                    <div class="settings-toggle-row" style="margin-top:12px;">
                        <span class="settings-toggle-label">${t('Allow controlled synthetic DNS proxy addresses', '允许受控的合成 DNS 代理地址')}</span>
                        <label class="toggle-switch"><input type="checkbox" id="webAllowSyntheticProxy"><span class="toggle-track"></span></label>
                    </div>
                    <div class="settings-hint">${t('Enable only in a sandbox or enterprise network that maps public hostnames into 198.18.0.0/15. Direct IP access and every other private range remain blocked.', '仅在沙箱或企业网络把公开域名映射到 198.18.0.0/15 时启用。直接 IP 访问和其他所有私有地址段仍会被阻止。')}</div>
                    <label class="settings-label">${t('Search provider', '搜索供应商')}</label>
                    <select class="settings-select" id="webSearchProvider">
                        <option value="auto">${t('Auto (configured providers, then DuckDuckGo)', '自动（已配置供应商，最后 DuckDuckGo）')}</option>
                        <option value="openai">OpenAI Web Search</option>
                        <option value="brave">Brave Search</option>
                        <option value="exa">Exa</option>
                        <option value="tavily">Tavily</option>
                        <option value="serper">Serper</option>
                        <option value="serpapi">SerpAPI</option>
                        <option value="searxng">SearXNG</option>
                        <option value="duckduckgo">DuckDuckGo</option>
                    </select>
                    <label class="settings-label">${t('Search context size', '搜索上下文规模')}</label>
                    <select class="settings-select" id="webContextSize">
                        <option value="low">${t('Low', '低')}</option><option value="medium">${t('Medium', '中')}</option><option value="high">${t('High', '高')}</option>
                    </select>
                    <label class="settings-label">${t('Fallback providers', '备用供应商')}</label>
                    <input class="settings-input" id="webFallbackProviders" type="text" placeholder="brave, exa, tavily" />
                    <div class="settings-hint">${t('Comma-separated provider IDs. OpenAI is never used automatically unless selected or listed here.', '以逗号分隔供应商 ID。除非明确选择或列在这里，否则不会自动使用 OpenAI。')}</div>
                    <label class="settings-label">${t('Allowed domains', '允许的域名')}</label>
                    <input class="settings-input" id="webAllowedDomains" type="text" placeholder="docs.example.com, github.com" />
                    <label class="settings-label">${t('Blocked domains', '阻止的域名')}</label>
                    <input class="settings-input" id="webBlockedDomains" type="text" placeholder="example.invalid" />
                    <label class="settings-label">${t('Country code', '国家代码')} <span style="opacity:0.5;font-weight:400">${t('(optional)', '（可选）')}</span></label>
                    <input class="settings-input" id="webCountry" type="text" maxlength="2" placeholder="US" />
                    <label class="settings-label">SearXNG Endpoint <span style="opacity:0.5;font-weight:400">${t('(optional)', '（可选）')}</span></label>
                    <input class="settings-input" id="webSearxngEndpoint" type="text" placeholder="https://search.example.com" />
                    <label class="settings-label">OpenAI Web Search Model <span style="opacity:0.5;font-weight:400">${t('(optional)', '（可选）')}</span></label>
                    <input class="settings-input" id="webOpenAIModel" type="text" placeholder="${t('Leave empty for the built-in default', '留空使用内置默认值')}" />
                    <label class="settings-label">${t('Search cache TTL (ms)', '搜索缓存 TTL（毫秒）')}</label>
                    <input class="settings-input" id="webCacheTtlMs" type="number" min="0" max="3600000" step="1000" placeholder="300000" />
                    <div class="settings-hint">${t('Provider keys are saved in VS Code SecretStorage. The main OpenAI provider key is reused for OpenAI Web Search.', '供应商密钥保存在 VS Code SecretStorage 中；OpenAI 网页搜索复用主 OpenAI 供应商密钥。')}</div>
                    ${(['brave', 'exa', 'tavily', 'serper', 'serpapi'] as const).map(provider => `
                    <label class="settings-label">${provider === 'serpapi' ? 'SerpAPI' : provider.charAt(0).toUpperCase() + provider.slice(1)} API Key <span style="opacity:0.5;font-weight:400">${t('(optional)', '（可选）')}</span></label>
                    <div class="settings-key-row">
                        <input class="settings-input" id="webKey-${provider}" type="password" autocomplete="off" />
                        <button class="key-toggle-btn" onclick="var k=document.getElementById('webKey-${provider}');k.type=k.type==='password'?'text':'password';">${svgIconNoMargin('eye')}</button>
                    </div>`).join('')}
                    <div class="settings-hint">${t('Provider dashboards:', '供应商控制台：')}
                        <a href="https://api.search.brave.com/" target="_blank" rel="noopener">Brave</a> ·
                        <a href="https://dashboard.exa.ai/" target="_blank" rel="noopener">Exa</a> ·
                        <a href="https://app.tavily.com/" target="_blank" rel="noopener">Tavily</a> ·
                        <a href="https://serper.dev/" target="_blank" rel="noopener">Serper</a> ·
                        <a href="https://serpapi.com/manage-api-key" target="_blank" rel="noopener">SerpAPI</a>
                    </div>
                </div>
                <div class="settings-group" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; margin-top: 10px;">
                    <label class="settings-label">${svgIcon('plugin')} ${t('Agent Skills (experimental)', 'Agent Skills (实验性)')}</label>
                    <div class="settings-hint">
                        ${t('Agents can extend capabilities by loading community packages through', 'Agent 可以通过加载')} <code>npx skills</code> ${t('community skills, such as MiniMax CLI.', '社区技能包来扩展能力（例如 MiniMax CLI）。')}<br>
                        ${t('Skills are installed only into this extension\'s local storage.', '技能将仅安装在当前插件的本地存储中。')}
                    </div>
                    <div style="display: flex; gap: 8px; margin-top: 8px; align-items: center;">
                        <input class="settings-input" id="skillSourceInput" type="text" placeholder="${t('For example: MiniMax-AI/cli', '例如: MiniMax-AI/cli')}" autocomplete="off" style="flex: 1; min-width: 0;" />
                        <button class="settings-test-btn" id="installSkillBtn" style="width: auto; padding: 6px 16px; flex: none; white-space: nowrap; height: 32px; display: flex; align-items: center; justify-content: center;">${t('Install', '安装')}</button>
                    </div>
                    <div id="installedSkillsList" style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;"></div>
                </div>
                <div class="settings-group" style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; margin-top: 10px;">
                    <label class="settings-label">${svgIcon('bot')} ${t('Multi-Agent role model settings', '多 Agent 角色模型配置')}</label>
                    <div class="settings-hint" style="margin-bottom:8px;">${t('Set a provider/model per sub-agent role. Leave as "Inherit main settings" to use the main model configured above.', '为每个子 Agent 角色单独指定供应商/模型。留为"继承主设置"则使用上方配置的主模型。')}</div>
                    <div id="agentModelRows" style="display:flex;flex-direction:column;gap:8px;">
                        ${[
                                `explorer|${t('Explorer', '探索者 (Explorer)')}`,
                                `architect|${t('Architect', '架构师 (Architect)')}`,
                                `builder|${t('Builder', '构建者 (Builder)')}`,
                                `locWriter|${t('Localisation writer', '本地化 (LocWriter)')}`,
                                `locTranslator|${t('Translator', '翻译 (LocTranslator)')}`,
                                `reviewer|${t('Reviewer', '审查者 (Reviewer)')}`,
                                `assetGen|${t('Asset generator', '资产 (AssetGen)')}`,
                                `guiExpert|${t('GUI expert', 'GUI专家 (GuiExpert)')}`,
                            ]
                            .map(item => {
                                const [role, label] = item.split('|');
                                return `<div class="agent-model-row" data-role="${role}" style="display:flex;align-items:center;gap:6px;">
                                    <span style="font-size:11px;opacity:0.75;min-width:120px;flex-shrink:0;">${label}</span>
                                    <select class="settings-select agent-model-provider" data-role="${role}" style="flex:1;max-width:120px;font-size:11px;padding:3px 5px;">
                                        <option value="__inherit__">${t('Inherit main settings', '继承主设置')}</option>
                                    </select>
                                    <select class="settings-select agent-model-model" data-role="${role}" style="flex:1;max-width:160px;font-size:11px;padding:3px 5px;">
                                        <option value="__inherit__">${t('Inherit main settings', '继承主设置')}</option>
                                    </select>
                                </div>`;
                            }).join('\n')}
                    </div>
                </div>
            </div>
        </div>
        <div class="accordion-section" id="usageSection" style="margin-top: 12px; border-color: rgba(100,149,237,0.3);">
            <div class="accordion-header" id="accUsage"><span>${svgIcon('chart')} ${t('Token usage stats', 'Token 消耗统计')}</span><span class="accordion-arrow">▶</span></div>
            <div class="accordion-body">
                <div class="settings-group">
                    <div id="usageStatsContent" style="font-size:12px; line-height: 1.6; opacity: 0.9;">
                        ${t('Loading...', '加载中...')}
                    </div>
                    <button class="settings-test-btn" id="refreshUsageBtn" style="margin-top: 8px;">${svgIcon('refresh')}${t('Refresh stats', '刷新统计')}</button>
                    <button class="settings-test-btn" id="clearUsageBtn" style="margin-top: 5px; color: #e66; border-color: rgba(200,80,80,0.3);">${svgIcon('trash')}${t('Clear stats', '清空统计')}</button>
                </div>
            </div>
        </div>
    </div>
    <div class="settings-footer">
        <div class="test-result" id="testResult"></div>
        <div class="settings-footer-actions">
            <button class="settings-test-btn" id="testConnBtn">${svgIcon('info')}${t('Test connection', '测试连接')}</button>
            <button class="settings-save-btn" id="saveSettingsBtn">${svgIcon('save')}${t('Save settings', '保存设置')}</button>
        </div>
    </div>
</div>

<script src="${mermaidScriptUri}"></script>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
