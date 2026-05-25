import { Icons, svgIcon, svgIconNoMargin } from './svgIcons';
import { routeLiveStep, buildToolPairHtml, escapeHtml as mrEscapeHtml, type RendererStep } from './messageRenderer';
import {
    escapeHtml as _fmtEscapeHtml,
    formatNum as _fmtFormatNum,
    formatTime as _fmtFormatTime,
    formatDuration as _fmtFormatDuration,
    extractStepFile as _fmtExtractStepFile,
    makeRunSummary as _fmtMakeRunSummary,
    WRITE_TOOL_NAMES as _fmtWriteTools,
    READ_TOOL_NAMES as _fmtReadTools,
    VALIDATION_TOOL_NAMES as _fmtValidationTools,
    ORCHESTRATOR_TOOL_NAMES as _fmtOrchestratorTools,
    type RunSummary as _FmtRunSummary,
} from './chat/formatters';
import {
    getDiffArtifactFiles,
    restoreArtifactsFromMessages as restoreArtifactsFromHistory,
    sortArtifactsByNewest,
    type ArtifactFilter,
    type ArtifactRecord,
} from './chat/artifacts';
import { renderArtifactDrawer } from './chat/artifactDrawer';
import { type TopicPanelItem, type TopicPanelStats } from './chat/topics';
import {
    buildLiveProcessMeta,
    buildLiveProcessSummaryHtml,
    buildSubagentCardHtml,
    buildSubagentFullscreenHtml,
    buildSubagentHeaderMetricsHtml,
    buildSubagentMetaHtml,
    buildThinkingSummaryHtml,
    hasVisibleLiveContent,
    latestLiveToolName,
} from './chat/liveSteps';
import { applySettingsOverview, buildSettingsOverviewModel } from './chat/settingsOverview';
import {
    renderTopicSearchResults as renderTopicSearchResultsView,
    renderTopics as renderTopicsView,
} from './chat/topicViews';
import { getChatI18n } from './chat/i18n';
import { applyModeUi } from './chat/modes';
import { buildSlashCommands, filterSlashCommands, renderSlashCommandItems } from './chat/slashCommands';
import { type WorkflowView } from './chat/workflows';
import { createMarkdownRenderer } from './chat/markdown';
import { createAnnotationCard } from './chat/annotations';
import {
    CONTEXT_TYPE_META,
    generateContextId,
    mentionResultToActiveContext,
    type ActiveContext,
    type MentionResult,
} from './chat/contextMentions';

interface SideDiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
    oldLineNo?: number;
    newLineNo?: number;
}

interface SideDiffFile {
    file: string;
    status?: string;
    diffPreview?: string;
    additions?: number;
    deletions?: number;
    diffLines?: SideDiffLine[];
}

interface SideDiffEntry {
    id: string;
    title: string;
    timestamp: number;
    files: SideDiffFile[];
    pending?: { messageId: string; isNewFile: boolean };
    sourceKey?: string;
}

interface SideDiffFocus {
    entryId?: string;
    file?: string;
}

interface UserMessageInputPayload {
    text: string;
    images?: string[];
    contexts?: ActiveContext[];
}

interface ResponsiveWorkspacePanel {
    kind: 'plan' | 'walkthrough' | 'blueprint';
    title: string;
    subtitle?: string;
    content: HTMLElement;
    wide?: boolean;
}

function cloneSideDiffLines(lines?: SideDiffLine[]): SideDiffLine[] | undefined {
    if (!lines || lines.length === 0) return undefined;
    return lines.map(line => ({
        type: line.type,
        content: line.content,
        ...(line.oldLineNo != null ? { oldLineNo: line.oldLineNo } : {}),
        ...(line.newLineNo != null ? { newLineNo: line.newLineNo } : {}),
    }));
}

function cloneSideDiffFile(file: SideDiffFile): SideDiffFile {
    return {
        file: file.file,
        status: file.status,
        diffPreview: file.diffPreview,
        additions: file.additions,
        deletions: file.deletions,
        diffLines: cloneSideDiffLines(file.diffLines),
    };
}

function cloneSideDiffEntry(entry: SideDiffEntry): SideDiffEntry {
    return {
        id: entry.id,
        title: entry.title,
        timestamp: entry.timestamp,
        files: entry.files.map(cloneSideDiffFile),
        ...(entry.pending ? { pending: { ...entry.pending } } : {}),
        ...(entry.sourceKey ? { sourceKey: entry.sourceKey } : {}),
    };
}

(function () {
    const chatI18n = getChatI18n(document.documentElement.lang || navigator.language);
    const renderMarkdown = createMarkdownRenderer(chatI18n.markdown);
    const vscode = acquireVsCodeApi();
    (window as any).__cwtoolsVscode = vscode;
    const chatArea = document.getElementById('chatArea') as HTMLDivElement;
    const input = document.getElementById('input') as HTMLDivElement;
    const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement;
    const emptyState = document.getElementById('emptyState') as HTMLDivElement;
    const topicsPanel = document.getElementById('topicsPanel') as HTMLDivElement;
    const settingsPage = document.getElementById('settingsPage') as HTMLDivElement;
    const chatHeader = document.querySelector('.header') as HTMLElement;
    const inputWrapper = document.querySelector('.input-wrapper') as HTMLElement;
    const todoPanel = document.getElementById('todoPanel') as HTMLDivElement;
    const sideWorkspace = document.getElementById('sideWorkspace') as HTMLElement | null;
    const sideWorkspaceBody = document.getElementById('sideWorkspaceBody') as HTMLElement | null;
    const sideWorkspaceTitle = document.getElementById('sideWorkspaceTitle') as HTMLElement | null;
    const sideWorkspaceSubtitle = document.getElementById('sideWorkspaceSubtitle') as HTMLElement | null;

    let isGenerating = false;
    let currentAssistantDiv: HTMLDivElement | null = null;
    let currentMode = 'build';
    const messageIndexMap = new Map<number, HTMLDivElement>();
    const userMessagePayloadMap = new Map<number, UserMessageInputPayload>();
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
    let currentTopicId: string | null = null;
    let currentTopicTitle = '';
    let totalConversationTokens = 0;
    let contextLimit = 128000;
    /** Pending images (base64 data URLs) to attach to next sent message */
    let pendingImages: string[] = [];
    /** Pending files to attach */
    let pendingFiles: string[] = [];
    /** Pending structured references to attach to the next sent message */
    let activeContexts: ActiveContext[] = [];
    let editingMessageIndex: number | null = null;
    let savedInputRange: Range | null = null;
    let artifacts: ArtifactRecord[] = [];
    let artifactFilter: ArtifactFilter = 'all';
    let workflows: WorkflowView[] = [];
    let activeWorkflowId: string | null = null;
    let quickModelOptions: string[] = [];
    let quickModelCurrent = '';
    let sideWorkspaceContent: HTMLElement | null = null;
    let settingsInSideWorkspace = false;
    let sideDiffEntrySeq = 0;
    const sideDiffEntries: SideDiffEntry[] = [];
    const originalParents = new Map<HTMLElement, { parent: Node; nextSibling: ChildNode | null }>();
    let activeResponsiveWorkspace: ResponsiveWorkspacePanel | null = null;
    let responsiveWorkspacePinnedClosed = false;
    let responsiveWorkspaceLayoutPending = false;
    let wasWideWorkspace = shouldUseSideWorkspace();
    
    function hasConversationContent(): boolean {
        return Array.from(chatArea.children).some(child => child !== emptyState && !(child as HTMLElement).classList.contains('empty-state'));
    }

    function setChatEmptyState(isEmpty = !hasConversationContent()) {
        document.body.classList.toggle('chat-empty', isEmpty);
        chatArea.classList.toggle('is-empty', isEmpty);
    }

    const chatContentObserver = new MutationObserver(() => setChatEmptyState());
    chatContentObserver.observe(chatArea, { childList: true });
    setChatEmptyState();

    let lastComposerStackHeight = 0;
    let composerStackScrollSyncPending = false;

    function scheduleComposerScrollSync() {
        if (composerStackScrollSyncPending) return;
        composerStackScrollSyncPending = true;
        requestAnimationFrame(() => {
            composerStackScrollSyncPending = false;
            if (!document.body.classList.contains('chat-empty')) {
                scrollBottom();
            }
        });
    }

    function updateComposerStackHeight() {
        if (!inputWrapper) return;
        const rect = inputWrapper.getBoundingClientRect();
        const height = Math.ceil(rect.height);
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        const popupGap = 12;
        document.documentElement.style.setProperty('--composer-stack-height', `${height}px`);
        document.documentElement.style.setProperty('--composer-popup-top', `${Math.ceil(rect.bottom + popupGap)}px`);
        document.documentElement.style.setProperty('--composer-popup-bottom', `${Math.max(12, Math.ceil(viewportHeight - rect.top + popupGap))}px`);
        if (Math.abs(height - lastComposerStackHeight) > 1) {
            lastComposerStackHeight = height;
            scheduleComposerScrollSync();
        }
    }

    const composerResizeObserver = new ResizeObserver(updateComposerStackHeight);
    if (inputWrapper) composerResizeObserver.observe(inputWrapper);
    window.addEventListener('resize', updateComposerStackHeight);
    window.addEventListener('resize', positionComposerMenus);
    window.addEventListener('resize', updateManagerTopicsToggleState);
    window.addEventListener('focus', removeReplayBanners);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) removeReplayBanners();
    });
    updateComposerStackHeight();

    function currentViewportWidth(): number {
        return document.documentElement.clientWidth || document.body?.clientWidth || window.innerWidth;
    }

    function shouldUseSideWorkspace(): boolean {
        return currentViewportWidth() >= 1180;
    }

    function isManagerShell(): boolean {
        return document.body.classList.contains('agent-manager-shell');
    }

    function isCurrentSurface(targetSurface?: 'chat' | 'manager'): boolean {
        if (!targetSurface) return true;
        return targetSurface === (isManagerShell() ? 'manager' : 'chat');
    }

    function removeReplayBanners(): void {
        document.querySelectorAll('.replay-steps-banner').forEach(el => el.remove());
    }

    function isManagerTopicsRailMode(): boolean {
        return isManagerShell() && currentViewportWidth() >= 980;
    }

    function updateManagerTopicsToggleState(): void {
        if (!isManagerShell()) return;
        const button = document.getElementById('btnTopics') as HTMLButtonElement | null;
        if (!button) return;
        const collapsed = document.body.classList.contains('manager-topics-collapsed');
        const railVisible = isManagerTopicsRailMode() && !collapsed;
        button.classList.toggle('active', railVisible);
        button.setAttribute('aria-pressed', railVisible ? 'true' : 'false');
        button.title = collapsed ? '展开话题栏' : '关闭话题栏';
        button.setAttribute('aria-label', collapsed ? '展开话题栏' : '关闭话题栏');
        if (isManagerTopicsRailMode()) {
            topicsPanel.classList.remove('show');
            if (sideWorkspaceContent === topicsPanel) closeSideWorkspace();
        }
    }

    function updateWorkspaceToggleState(): void {
        const toggle = document.getElementById('btnWorkspace');
        if (!toggle) return;
        const hasWorkspaceItems = sideDiffEntries.length > 0 || !!activeResponsiveWorkspace;
        const isWorkspacePanelOpen = document.body.classList.contains('side-workspace-open')
            && !!sideWorkspaceContent
            && sideWorkspaceContent !== settingsPage
            && sideWorkspaceContent !== topicsPanel;
        toggle.classList.toggle('active', isWorkspacePanelOpen);
        toggle.classList.toggle('has-workspace-items', hasWorkspaceItems);
        toggle.setAttribute('aria-pressed', isWorkspacePanelOpen ? 'true' : 'false');
        const visible = shouldUseSideWorkspace();
        toggle.style.display = visible ? 'inline-flex' : '';
        toggle.setAttribute('aria-hidden', visible ? 'false' : 'true');
    }

    function createWorkspaceHomeView(): HTMLElement {
        const view = document.createElement('div');
        view.className = 'workspace-empty';
        view.innerHTML = `
            <div class="workspace-empty-title">${svgIconNoMargin('folder')} 暂无工作区内容</div>
            <div class="workspace-empty-text">当前没有文件变更、计划或批注需要展示。等本轮产生可跟踪内容后，这里会自动显示详情。</div>
        `;
        return view;
    }

    function rememberOriginalParent(element: HTMLElement): void {
        if (!originalParents.has(element) && element.parentNode) {
            originalParents.set(element, { parent: element.parentNode, nextSibling: element.nextSibling });
        }
    }

    function restoreOriginalParent(element: HTMLElement): void {
        const original = originalParents.get(element);
        if (!original) return;
        if (element.parentNode === original.parent) return;
        const anchor = original.nextSibling && original.nextSibling.parentNode === original.parent
            ? original.nextSibling
            : null;
        original.parent.insertBefore(element, anchor);
    }

    function detachSideWorkspaceContent(): void {
        if (!sideWorkspaceContent) return;
        hideDetachedWorkspaceContent(sideWorkspaceContent);
        restoreOriginalParent(sideWorkspaceContent);
        sideWorkspaceContent = null;
    }

    function clearSideWorkspaceShell(): void {
        document.body.classList.remove('side-workspace-open');
        document.body.classList.remove('side-workspace-wide');
        sideWorkspace?.setAttribute('aria-hidden', 'true');
        if (sideWorkspaceTitle) sideWorkspaceTitle.textContent = '工作区';
        if (sideWorkspaceSubtitle) sideWorkspaceSubtitle.textContent = '';
        if (sideWorkspaceBody) sideWorkspaceBody.innerHTML = '';
        updateWorkspaceToggleState();
    }

    function hideDetachedWorkspaceContent(content: HTMLElement): void {
        if (content === topicsPanel) {
            topicsPanel.classList.remove('show');
            return;
        }
        if (content === settingsPage) {
            settingsInSideWorkspace = false;
            settingsPage.classList.remove('active');
            chatHeader.style.display = '';
            document.getElementById('chatArea')!.style.display = 'flex';
            if (inputWrapper) inputWrapper.style.display = '';
            const mi = document.getElementById('modeIndicator');
            if (mi) mi.style.display = '';
            if (todoPanel) todoPanel.style.display = '';
        }
    }

    function closeSideWorkspace(options: { preserveResponsivePin?: boolean } = {}): void {
        if (!options.preserveResponsivePin
            && shouldUseSideWorkspace()
            && activeResponsiveWorkspace?.content === sideWorkspaceContent) {
            responsiveWorkspacePinnedClosed = true;
        }
        detachSideWorkspaceContent();
        clearSideWorkspaceShell();
    }

    function clearTopicWorkspaceState(): void {
        const responsiveContent = activeResponsiveWorkspace?.content || null;
        sideDiffEntries.length = 0;
        responsiveWorkspacePinnedClosed = false;

        if (sideWorkspaceContent && sideWorkspaceContent !== settingsPage && sideWorkspaceContent !== topicsPanel) {
            closeSideWorkspace({ preserveResponsivePin: true });
        }

        if (responsiveContent) {
            if (responsiveContent.parentNode) {
                responsiveContent.remove();
            }
            originalParents.delete(responsiveContent);
        }

        activeResponsiveWorkspace = null;
        updateWorkspaceToggleState();
    }

    function openSideWorkspace(options: { title: string; subtitle?: string; content?: HTMLElement; build?: () => HTMLElement; wide?: boolean }): HTMLElement | null {
        if (!sideWorkspace || !sideWorkspaceBody) return null;
        if (document.body.classList.contains('artifact-drawer-open')) setArtifactDrawerOpen(false);
        let content = options.content || null;
        if (!content && options.build) content = options.build();
        if (!content) return null;
        if (sideWorkspaceContent && sideWorkspaceContent !== content) {
            detachSideWorkspaceContent();
        }
        if (sideWorkspaceContent !== content) {
            sideWorkspaceBody.innerHTML = '';
            rememberOriginalParent(content);
            sideWorkspaceBody.appendChild(content);
            sideWorkspaceContent = content;
        }
        if (sideWorkspaceTitle) sideWorkspaceTitle.textContent = options.title;
        if (sideWorkspaceSubtitle) sideWorkspaceSubtitle.textContent = options.subtitle || '';
        document.body.classList.add('side-workspace-open');
        document.body.classList.toggle('side-workspace-wide', !!options.wide);
        sideWorkspace.setAttribute('aria-hidden', 'false');
        updateComposerStackHeight();
        updateWorkspaceToggleState();
        return content;
    }

    function forgetResponsiveWorkspaceContent(content: HTMLElement): void {
        if (activeResponsiveWorkspace?.content === content) {
            activeResponsiveWorkspace = null;
            responsiveWorkspacePinnedClosed = false;
        }
        if (sideWorkspaceContent === content) {
            sideWorkspaceContent = null;
            clearSideWorkspaceShell();
        }
        originalParents.delete(content);
        updateWorkspaceToggleState();
    }

    function showResponsiveWorkspacePanel(panel: ResponsiveWorkspacePanel): void {
        activeResponsiveWorkspace = panel;
        responsiveWorkspacePinnedClosed = false;

        if (shouldUseSideWorkspace()) {
            openSideWorkspace({
                title: panel.title,
                subtitle: panel.subtitle,
                content: panel.content,
                wide: panel.wide,
            });
        } else {
            if (sideWorkspaceContent === panel.content) {
                closeSideWorkspace({ preserveResponsivePin: true });
            }
            if (panel.content.parentNode !== chatArea) {
                chatArea.appendChild(panel.content);
            }
            scrollBottom();
        }
        setChatEmptyState();
        updateWorkspaceToggleState();
    }

    function scheduleResponsiveWorkspaceLayoutSync(): void {
        if (responsiveWorkspaceLayoutPending) return;
        responsiveWorkspaceLayoutPending = true;
        requestAnimationFrame(() => {
            responsiveWorkspaceLayoutPending = false;
            syncResponsiveWorkspaceLayout();
            updateComposerStackHeight();
            positionComposerMenus();
        });
    }

    function syncResponsiveWorkspaceLayout(): void {
        const isWide = shouldUseSideWorkspace();
        if (isWide !== wasWideWorkspace) {
            responsiveWorkspacePinnedClosed = false;
            wasWideWorkspace = isWide;
        }

        if (activeResponsiveWorkspace) {
            const panel = activeResponsiveWorkspace;
            if (isWide && !responsiveWorkspacePinnedClosed) {
                openSideWorkspace({
                    title: panel.title,
                    subtitle: panel.subtitle,
                    content: panel.content,
                    wide: panel.wide,
                });
            } else if (!isWide) {
                if (sideWorkspaceContent === panel.content) {
                    closeSideWorkspace({ preserveResponsivePin: true });
                }
                if (panel.content.parentNode !== chatArea) {
                    chatArea.appendChild(panel.content);
                    scrollBottom();
                }
            }
        }

        if (!isWide && document.body.classList.contains('side-workspace-open')) {
            closeSideWorkspace({ preserveResponsivePin: true });
        }
        updateWorkspaceToggleState();
    }

    function openWorkspaceFromButton(): void {
        if (!shouldUseSideWorkspace()) return;
        if (document.body.classList.contains('side-workspace-open')) {
            const isNonWorkspacePanel = sideWorkspaceContent === settingsPage || sideWorkspaceContent === topicsPanel;
            if (isNonWorkspacePanel) {
                responsiveWorkspacePinnedClosed = false;
                if (activeResponsiveWorkspace) {
                    openSideWorkspace({
                        title: activeResponsiveWorkspace.title,
                        subtitle: activeResponsiveWorkspace.subtitle,
                        content: activeResponsiveWorkspace.content,
                        wide: activeResponsiveWorkspace.wide,
                    });
                    return;
                }
                if (sideDiffEntries.length > 0) {
                    showSideDiffWorkspace();
                    return;
                }
                openSideWorkspace({
                    title: '工作区',
                    subtitle: '计划、批注和文件变更会显示在这里',
                    build: createWorkspaceHomeView,
                });
                return;
            }
            if (activeResponsiveWorkspace && sideWorkspaceContent !== activeResponsiveWorkspace.content) {
                responsiveWorkspacePinnedClosed = false;
                openSideWorkspace({
                    title: activeResponsiveWorkspace.title,
                    subtitle: activeResponsiveWorkspace.subtitle,
                    content: activeResponsiveWorkspace.content,
                    wide: activeResponsiveWorkspace.wide,
                });
                return;
            }
            if (!activeResponsiveWorkspace && sideDiffEntries.length > 0 && !sideWorkspaceContent?.classList.contains('side-diff-view')) {
                showSideDiffWorkspace();
                return;
            }
            closeSideWorkspace();
            return;
        }

        responsiveWorkspacePinnedClosed = false;
        setArtifactDrawerOpen(false);
        if (activeResponsiveWorkspace) {
            openSideWorkspace({
                title: activeResponsiveWorkspace.title,
                subtitle: activeResponsiveWorkspace.subtitle,
                content: activeResponsiveWorkspace.content,
                wide: activeResponsiveWorkspace.wide,
            });
            return;
        }
        if (sideDiffEntries.length > 0) {
            showSideDiffWorkspace();
            return;
        }
        openSideWorkspace({
            title: '工作区',
            subtitle: '计划、批注和文件变更会显示在这里',
            build: createWorkspaceHomeView,
        });
    }

    function fileBaseNameLocal(file: string): string {
        return (file || '').replace(/\\/g, '/').split('/').pop() || file;
    }

    function renderDiffTable(lines: SideDiffLine[] | undefined): string {
        if (!lines || lines.length === 0) {
            return '<div class="side-diff-empty">没有可内联显示的差异。</div>';
        }
        let html = '<table class="ds-diff-table"><tbody>';
        for (const line of lines) {
            const cls = line.type === 'add' ? 'ds-line-add' : line.type === 'remove' ? 'ds-line-del' : 'ds-line-ctx';
            const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
            const oldNo = line.oldLineNo != null ? String(line.oldLineNo) : '';
            const newNo = line.newLineNo != null ? String(line.newLineNo) : '';
            html += `<tr class="${cls}">
                <td class="ds-ln">${oldNo}</td>
                <td class="ds-ln">${newNo}</td>
                <td class="ds-prefix">${prefix}</td>
                <td class="ds-code">${escapeHtml(line.content)}</td>
            </tr>`;
        }
        return html + '</tbody></table>';
    }

    function getSideDiffTotals(files: SideDiffFile[]): { additions: number; deletions: number; lineCount: number } {
        return files.reduce((totals, file) => {
            totals.additions += file.additions || 0;
            totals.deletions += file.deletions || 0;
            totals.lineCount += file.diffLines?.length || 0;
            return totals;
        }, { additions: 0, deletions: 0, lineCount: 0 });
    }

    function createSideDiffEntry(
        files: SideDiffFile[],
        title: string,
        pending?: { messageId: string; isNewFile: boolean },
        sourceKey?: string,
    ): SideDiffEntry {
        return {
            id: `diff-${Date.now()}-${++sideDiffEntrySeq}`,
            title,
            timestamp: Date.now(),
            files: files.map(cloneSideDiffFile),
            pending,
            sourceKey,
        };
    }

    function normalizeSideDiffFilePath(file: string): string {
        return (file || '').replace(/\\/g, '/').trim().toLowerCase();
    }

    function getSideDiffSourceKey(title: string, files: SideDiffFile[], pending?: { messageId: string; isNewFile: boolean }): string {
        if (pending) return `pending:${pending.messageId}`;
        const payload = files.map(file => [
            normalizeSideDiffFilePath(file.file),
            file.status || '',
            file.additions ?? '',
            file.deletions ?? '',
            file.diffPreview || '',
            file.diffLines?.length ?? 0,
        ].join('|')).join('||');
        return `${title}::${payload}`;
    }

    function findSideDiffEntryIndex(entry: SideDiffEntry): number {
        if (entry.sourceKey) {
            const bySourceKey = sideDiffEntries.findIndex(item => item.sourceKey === entry.sourceKey);
            if (bySourceKey >= 0) return bySourceKey;
        }
        if (entry.pending) {
            return sideDiffEntries.findIndex(item => item.pending?.messageId === entry.pending?.messageId);
        }
        return sideDiffEntries.findIndex(item => item.id === entry.id);
    }

    function upsertSideDiffEntry(entry: SideDiffEntry): SideDiffEntry {
        const existingIndex = findSideDiffEntryIndex(entry);
        if (existingIndex >= 0) {
            const existing = sideDiffEntries[existingIndex]!;
            sideDiffEntries[existingIndex] = {
                ...entry,
                id: existing.id,
                timestamp: existing.timestamp,
            };
            updateWorkspaceToggleState();
            return sideDiffEntries[existingIndex];
        }
        sideDiffEntries.unshift(entry);
        if (sideDiffEntries.length > 30) sideDiffEntries.length = 30;
        updateWorkspaceToggleState();
        return entry;
    }

    function removeSideDiffEntry(entryId: string): boolean {
        const index = sideDiffEntries.findIndex(item => item.id === entryId);
        if (index < 0) return false;
        sideDiffEntries.splice(index, 1);
        updateWorkspaceToggleState();
        return true;
    }

    function removePendingSideDiffEntry(messageId: string): boolean {
        const index = sideDiffEntries.findIndex(item => item.pending?.messageId === messageId || item.sourceKey === `pending:${messageId}`);
        if (index < 0) return false;
        sideDiffEntries.splice(index, 1);
        updateWorkspaceToggleState();
        return true;
    }

    function refreshSideDiffWorkspaceAfterRemoval(): void {
        if (!sideWorkspaceContent?.classList.contains('side-diff-view')) return;
        if (sideDiffEntries.length > 0) {
            showSideDiffWorkspace('文件变更');
        } else {
            closeSideWorkspace();
        }
    }

    function formatSideDiffTime(timestamp: number): string {
        const d = new Date(timestamp);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    }

    function createSideDiffView(entries: SideDiffEntry[], options: { title: string; focus?: SideDiffFocus }): HTMLElement {
        const view = document.createElement('div');
        view.className = 'side-diff-view';
        const allFiles = entries.flatMap(entry => entry.files);
        const totals = getSideDiffTotals(allFiles);
        const toolbarTitle = options.title === '文件变更' ? '变更概览' : options.title;
        view.innerHTML = `<div class="side-diff-toolbar">
            <div class="side-diff-title">${svgIconNoMargin('edit')}<span>${escapeHtml(toolbarTitle)}</span></div>
            <div class="side-diff-stats"><span class="ds-add">+${totals.additions}</span><span class="ds-del">-${totals.deletions}</span><span>${entries.length} 次变更</span><span>${allFiles.length} 个文件</span></div>
        </div>`;

        const fileList = document.createElement('div');
        fileList.className = 'side-diff-files';
        const focusPath = options.focus?.file ? normalizeSideDiffFilePath(options.focus.file) : '';
        const focusEntryId = options.focus?.entryId || '';
        let focusTarget: HTMLElement | null = null;
        for (const entry of entries) {
            const entryEl = document.createElement('section');
            entryEl.className = 'side-diff-entry open';
            entryEl.dataset.sideDiffEntryId = entry.id;
            const entryTotals = getSideDiffTotals(entry.files);
            const entryTitle = entry.title === options.title ? (entries.length === 1 ? '本次变更' : '变更记录') : entry.title;
            const entryHeader = document.createElement('button');
            entryHeader.type = 'button';
            entryHeader.className = 'side-diff-entry-header';
            entryHeader.innerHTML = `
                <div class="side-diff-entry-main">
                    <span class="side-diff-chevron">&gt;</span>
                    <span class="side-diff-entry-title">${escapeHtml(entryTitle)}</span>
                    <span class="side-diff-entry-time">${formatSideDiffTime(entry.timestamp)}</span>
                </div>
                <div class="side-diff-entry-stats"><span class="ds-add">+${entryTotals.additions}</span><span class="ds-del">-${entryTotals.deletions}</span><span>${entry.files.length} 个文件</span><span>${entryTotals.lineCount} 行预览</span></div>`;
            entryHeader.addEventListener('click', () => {
                entryEl.classList.toggle('open');
            });
            entryEl.appendChild(entryHeader);

            const entryFiles = document.createElement('div');
            entryFiles.className = 'side-diff-entry-files';
            for (const file of entry.files) {
                const item = document.createElement('section');
                item.className = 'side-diff-file open';
                item.dataset.sideDiffFile = file.file;
                const stats = file.additions != null ? `<span class="ds-add">+${file.additions || 0}</span><span class="ds-del">-${file.deletions || 0}</span>` : escapeHtml(file.diffPreview || '');
                const preview = file.diffPreview ? `<span class="side-diff-file-preview">${escapeHtml(file.diffPreview)}</span>` : '';
                const fileHeader = document.createElement('button');
                fileHeader.type = 'button';
                fileHeader.className = 'side-diff-file-header';
                fileHeader.innerHTML = `
                    <div class="side-diff-file-main">
                        <span class="side-diff-file-title">
                            <span class="side-diff-chevron">&gt;</span>
                            <span class="side-diff-file-name" title="${escapeHtml(file.file)}">${escapeHtml(fileBaseNameLocal(file.file))}</span>
                        </span>
                        <span class="side-diff-file-path">${escapeHtml(file.file)}</span>
                        ${preview}
                    </div>
                    <div class="side-diff-file-stats">${stats}</div>`;
                fileHeader.addEventListener('click', event => {
                    event.stopPropagation();
                    item.classList.toggle('open');
                });
                item.appendChild(fileHeader);
                const code = document.createElement('div');
                code.className = 'side-diff-code';
                code.innerHTML = renderDiffTable(file.diffLines);
                item.appendChild(code);
                if (focusPath && (!focusEntryId || focusEntryId === entry.id) && normalizeSideDiffFilePath(file.file) === focusPath) {
                    item.classList.add('focused');
                    entryEl.classList.add('focused');
                    focusTarget = item;
                }
                entryFiles.appendChild(item);
            }
            entryEl.appendChild(entryFiles);
            if (!focusTarget && focusEntryId === entry.id) {
                entryEl.classList.add('focused');
                focusTarget = entryEl;
            }

            if (entry.pending) {
                const actions = document.createElement('div');
                actions.className = 'side-diff-actions';
                actions.innerHTML = `<button class="diff-reject-btn" type="button">${svgIcon('x')}拒绝</button>
                    <button class="diff-accept-btn" type="button">${svgIcon('check')}接受</button>`;
                actions.querySelector('.diff-accept-btn')?.addEventListener('click', () => {
                    vscode.postMessage({ type: 'confirmWriteFile', messageId: entry.pending!.messageId });
                    removeSideDiffEntry(entry.id);
                    refreshSideDiffWorkspaceAfterRemoval();
                });
                actions.querySelector('.diff-reject-btn')?.addEventListener('click', () => {
                    vscode.postMessage({ type: 'cancelWriteFile', messageId: entry.pending!.messageId });
                    removeSideDiffEntry(entry.id);
                    refreshSideDiffWorkspaceAfterRemoval();
                });
                entryEl.appendChild(actions);
            }
            fileList.appendChild(entryEl);
        }
        view.appendChild(fileList);
        if (focusTarget) {
            requestAnimationFrame(() => focusTarget?.scrollIntoView({ block: 'nearest' }));
        }

        return view;
    }

    function showSideDiffWorkspace(title = '文件变更', entries = sideDiffEntries, focus?: SideDiffFocus): void {
        const fileCount = entries.reduce((sum, entry) => sum + entry.files.length, 0);
        const snapshot = entries.map(cloneSideDiffEntry);
        openSideWorkspace({
            title,
            subtitle: entries.length === 1 && fileCount === 1 ? `${entries[0]?.title || title} · ${entries[0]?.files[0]?.file || ''}` : `${entries.length} 次变更 · ${fileCount} 个文件`,
            wide: true,
            build: () => createSideDiffView(snapshot, { title, focus }),
        });
    }

    function openDiffInSideWorkspace(
        files: SideDiffFile[],
        title = '文件变更',
        options: { pending?: { messageId: string; isNewFile: boolean }; append?: boolean; sourceKey?: string; focusFile?: string } = {},
    ): void {
        const sourceKey = options.sourceKey || getSideDiffSourceKey(title, files, options.pending);
        const entry = createSideDiffEntry(files, title, options.pending, sourceKey);
        const activeEntry = upsertSideDiffEntry(entry);
        showSideDiffWorkspace('文件变更', sideDiffEntries, {
            entryId: activeEntry.id,
            file: options.focusFile,
        });
    }

    const responsiveWorkspaceResizeObserver = new ResizeObserver(scheduleResponsiveWorkspaceLayoutSync);
    responsiveWorkspaceResizeObserver.observe(document.documentElement);
    window.addEventListener('resize', scheduleResponsiveWorkspaceLayoutSync);
    updateWorkspaceToggleState();

    function textFromComposerNode(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
        if (!(node instanceof HTMLElement)) return '';
        if (node.classList.contains('reference-chip')) return ' ';
        if (node.tagName === 'BR') return '\n';
        const childText = Array.from(node.childNodes).map(textFromComposerNode).join('');
        return node !== input && (node.tagName === 'DIV' || node.tagName === 'P') ? childText + '\n' : childText;
    }

    function getInputText(): string {
        return Array.from(input.childNodes).map(textFromComposerNode).join('').replace(/\u00a0/g, ' ').replace(/\u200b/g, '');
    }

    function isInputEmpty(): boolean {
        return getInputText().trim() === '' && !input.querySelector('.reference-chip');
    }

    function autoResizeInput() {
        updateComposerStackHeight();
    }

    function normalizeEmptyInput() {
        if (input.querySelector('.reference-chip')) return;
        if (getInputText().trim() === '' && input.innerHTML === '<br>') input.innerHTML = '';
    }

    function isRangeInsideInput(range: Range): boolean {
        return (range.startContainer === input || input.contains(range.startContainer))
            && (range.endContainer === input || input.contains(range.endContainer));
    }

    function saveInputSelection() {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (isRangeInsideInput(range)) savedInputRange = range.cloneRange();
    }

    function setInputRange(range: Range) {
        input.focus();
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        savedInputRange = range.cloneRange();
    }

    function getInputEndRange(): Range {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        return range;
    }

    function getActiveInputRange(): Range {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            if (isRangeInsideInput(range)) return range.cloneRange();
        }
        if (savedInputRange && isRangeInsideInput(savedInputRange)) return savedInputRange.cloneRange();
        return getInputEndRange();
    }

    function placeCaretAtEnd(el: HTMLElement) {
        el.focus();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        setInputRange(range);
    }

    function insertPlainTextAtRange(text: string, range = getActiveInputRange()) {
        range.deleteContents();
        const textNode = document.createTextNode(text);
        range.insertNode(textNode);
        const caret = document.createRange();
        caret.setStart(textNode, textNode.length);
        caret.collapse(true);
        setInputRange(caret);
        autoResizeInput();
    }

    function normalizePastedText(text: string): string {
        return text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    }

    function setInputText(text: string) {
        input.textContent = text;
        placeCaretAtEnd(input);
        autoResizeInput();
    }

    function appendInputText(text: string, separator = '') {
        const current = getInputText();
        placeCaretAtEnd(input);
        insertPlainTextAtRange(current.trim() ? separator + text : text);
    }

    function clearInput() {
        input.innerHTML = '';
        activeContexts = [];
        savedInputRange = null;
        autoResizeInput();
    }

    function cloneInputPayload(payload: UserMessageInputPayload): UserMessageInputPayload {
        return {
            text: payload.text || '',
            images: payload.images ? [...payload.images] : undefined,
            contexts: payload.contexts ? payload.contexts.map(ctx => ({ ...ctx, id: ctx.id || generateContextId() })) : undefined,
        };
    }

    function clearComposerAttachmentPreviews() {
        pendingImages = [];
        pendingFiles = [];
        const preview = document.getElementById('imagePreviewArea');
        if (preview) preview.innerHTML = '';
        const fileBadges = document.getElementById('fileBadgeArea');
        if (fileBadges) fileBadges.innerHTML = '';
    }

    function renderEditComposerState() {
        let bar = document.getElementById('editComposerBar') as HTMLElement | null;
        if (editingMessageIndex === null) {
            bar?.remove();
            updateComposerStackHeight();
            return;
        }

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'editComposerBar';
            bar.className = 'edit-composer-bar';
            const container = document.querySelector('.input-container');
            const inputRow = container?.querySelector('.input-row');
            if (container && inputRow) container.insertBefore(bar, inputRow);
            else inputWrapper?.prepend(bar);
        }

        bar.innerHTML = `
            <span class="edit-composer-icon">${svgIconNoMargin('pencil')}</span>
            <span class="edit-composer-text">正在编辑第 ${editingMessageIndex + 1} 条消息，发送后会从这里重新运行</span>
            <button class="edit-composer-cancel" type="button">取消</button>
        `;
        bar.querySelector('.edit-composer-cancel')?.addEventListener('click', () => {
            editingMessageIndex = null;
            renderEditComposerState();
            input.focus();
        });
        updateComposerStackHeight();
    }

    function restoreComposerPayload(payload: UserMessageInputPayload) {
        const next = cloneInputPayload(payload);
        clearInput();
        clearComposerAttachmentPreviews();

        for (const ctx of next.contexts || []) {
            activeContexts.push(ctx);
            input.appendChild(buildReferenceChip(ctx));
            input.appendChild(document.createTextNode(' '));
        }
        if (next.text) input.appendChild(document.createTextNode(next.text));

        pendingImages = next.images ? [...next.images] : [];
        for (const dataUrl of pendingImages) addImagePreview(dataUrl);

        placeCaretAtEnd(input);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        stopPlaceholderRotation();
        updateComposerStackHeight();
    }

    function beginEditMessage(messageIdx: number) {
        if (isGenerating) return;
        const payload = userMessagePayloadMap.get(messageIdx);
        if (!payload) return;
        editingMessageIndex = messageIdx;
        restoreComposerPayload(payload);
        renderEditComposerState();
        input.focus();
    }

    function syncContextsFromComposer() {
        const byId = new Map(activeContexts.map(ctx => [ctx.id, ctx]));
        activeContexts = Array.from(input.querySelectorAll<HTMLElement>('.reference-chip'))
            .map(chip => byId.get(chip.dataset.id || ''))
            .filter((ctx): ctx is ActiveContext => !!ctx);
    }

    function findLastTextNode(node: Node | undefined): Text | null {
        if (!node) return null;
        if (node.nodeType === Node.TEXT_NODE) return node as Text;
        for (let child = node.lastChild; child; child = child.previousSibling) {
            const found = findLastTextNode(child);
            if (found) return found;
        }
        return null;
    }

    function getLastTextNodeBeforeCaret(range = getActiveInputRange()): { node: Text; offset: number } | null {
        if (!isRangeInsideInput(range)) return null;
        const node = range.startContainer;
        const offset = range.startOffset;
        if (node.nodeType === Node.TEXT_NODE) return { node: node as Text, offset };
        for (let i = Math.min(offset, node.childNodes.length) - 1; i >= 0; i--) {
            const textNode = findLastTextNode(node.childNodes[i]);
            if (textNode) return { node: textNode, offset: textNode.length };
        }
        return null;
    }

    function getAtTriggerBeforeCaret(): { range: Range; filter: string } | null {
        const caretRange = getActiveInputRange();
        const match = getLastTextNodeBeforeCaret(caretRange);
        if (!match || match.offset <= 0) return null;
        const value = match.node.textContent || '';
        const atIdx = value.lastIndexOf('@', Math.max(0, match.offset - 1));
        if (atIdx < 0) return null;
        const filter = value.slice(atIdx + 1, match.offset);
        if (/[\s\n]/.test(filter)) return null;
        const triggerRange = document.createRange();
        triggerRange.setStart(match.node, atIdx);
        triggerRange.setEnd(match.node, match.offset);
        return { range: triggerRange, filter };
    }

    function replaceAtTriggerWithText(text: string) {
        const trigger = getAtTriggerBeforeCaret();
        insertPlainTextAtRange(text, trigger?.range || getActiveInputRange());
    }

    function getMentionFilterBeforeCaret(): string | null {
        return getAtTriggerBeforeCaret()?.filter ?? null;
    }

    function insertReferenceAtCaret(ctx: ActiveContext, targetRange = getActiveInputRange()) {
        activeContexts.push(ctx);
        const chip = buildReferenceChip(ctx);
        const range = isRangeInsideInput(targetRange) ? targetRange : getInputEndRange();
        range.deleteContents();
        const fragment = document.createDocumentFragment();
        const leadingSpace = document.createTextNode(' ');
        const trailingSpace = document.createTextNode(' ');
        fragment.appendChild(leadingSpace);
        fragment.appendChild(chip);
        fragment.appendChild(trailingSpace);
        range.insertNode(fragment);

        const caret = document.createRange();
        caret.setStart(trailingSpace, trailingSpace.textContent?.length || 0);
        caret.collapse(true);
        setInputRange(caret);
        autoResizeInput();
    }

    function replaceAtTriggerWithReference(ctx: ActiveContext) {
        const trigger = getAtTriggerBeforeCaret();
        insertReferenceAtCaret(ctx, trigger?.range || getActiveInputRange());
    }

    function getReferenceInitial(ctx: ActiveContext, fallback: string): string {
        if (ctx.type === 'file') {
            const ext = ctx.label.split('.').pop();
            if (ext && ext !== ctx.label && ext.length <= 4) return ext.toUpperCase();
        }
        if (ctx.type === 'folder') return 'DIR';
        if (ctx.type === 'code_selection') return 'SEL';
        if (ctx.type === 'diagnostics') return 'ERR';
        return fallback.slice(0, 2).toUpperCase();
    }

    function buildReferenceChip(ctx: ActiveContext): HTMLElement {
        const meta = CONTEXT_TYPE_META[ctx.type] || CONTEXT_TYPE_META.file;
        const range = typeof ctx.startLine === 'number' && typeof ctx.endLine === 'number'
            ? ` #L${ctx.startLine}-${ctx.endLine}`
            : typeof ctx.line === 'number'
                ? ` #L${ctx.line + 1}`
                : '';
        const title = ctx.description || ctx.uri || ctx.label;
        const metaBits = [
            typeof ctx.tokenEstimate === 'number' && ctx.tokenEstimate > 0 ? `~${formatNum(ctx.tokenEstimate)} tok` : '',
            ctx.cacheStatus ? ctx.cacheStatus : '',
        ].filter(Boolean).join(' · ');
        const chip = document.createElement('span');
        chip.className = `reference-chip ref-${ctx.type}`;
        chip.contentEditable = 'false';
        chip.dataset.id = ctx.id;
        chip.dataset.label = ctx.label;
        chip.title = title;
        chip.innerHTML = `
            ${svgIconNoMargin(meta.icon)}
            <span class="ref-kind">${mrEscapeHtml(getReferenceInitial(ctx, meta.label))}</span>
            <span class="ref-text">${mrEscapeHtml(ctx.label)}${range}</span>
            ${metaBits ? `<span class="ref-meta">${mrEscapeHtml(metaBits)}</span>` : ''}
            <button class="remove-ctx-btn" data-id="${ctx.id}" aria-label="Remove reference">&times;</button>
        `;
        chip.querySelector('.remove-ctx-btn')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const id = (e.currentTarget as HTMLElement).dataset.id;
            activeContexts = activeContexts.filter(c => c.id !== id);
            chip.remove();
            autoResizeInput();
            input.focus();
        });
        return chip;
    }

    function renderContextTray() {
        syncContextsFromComposer();
        updateComposerStackHeight();
        /*
        return;
        let area = document.getElementById('referenceChipArea');
        if (!area) {
            area = document.createElement('div');
            area.id = 'referenceChipArea';
            const container = document.querySelector('.input-container');
            const inputRow = container?.querySelector('.input-row');
            if (inputRow) inputRow.prepend(area);
            else if (container) container.prepend(area);
            else inputWrapper?.prepend(area);
        }
        
        area.innerHTML = '';
        if (activeContexts.length === 0) {
            area.style.display = 'none';
            updateComposerStackHeight();
            return;
        }
        area.style.display = 'flex';
        area.className = 'reference-chip-area';
        const tokenTotal = activeContexts.reduce((sum, ctx) => sum + (ctx.tokenEstimate || 0), 0);
        const summary = document.createElement('div');
        summary.className = 'reference-tray-summary';
        summary.innerHTML = `
            <span>${svgIconNoMargin('layers')} ${activeContexts.length} 个引用</span>
            ${tokenTotal > 0 ? `<span class="reference-token-total">~${formatNum(tokenTotal)} tok</span>` : ''}
            <button class="reference-clear-btn" type="button">清空</button>
        `;
        area.appendChild(summary);
        const clearBtn = summary.querySelector('.reference-clear-btn') as HTMLButtonElement | null;
        clearBtn?.addEventListener('click', () => {
            activeContexts = [];
            renderContextTray();
            input.focus();
        });
        
        activeContexts.forEach(ctx => {
            const meta = CONTEXT_TYPE_META[ctx.type] || CONTEXT_TYPE_META.file;
            const range = typeof ctx.startLine === 'number' && typeof ctx.endLine === 'number'
                ? ` #L${ctx.startLine}-${ctx.endLine}`
                : typeof ctx.line === 'number'
                    ? ` #L${ctx.line + 1}`
                    : '';
            const title = ctx.description || ctx.uri || ctx.label;
            const metaBits = [
                typeof ctx.tokenEstimate === 'number' && ctx.tokenEstimate > 0 ? `~${formatNum(ctx.tokenEstimate)} tok` : '',
                ctx.cacheStatus ? ctx.cacheStatus : '',
            ].filter(Boolean).join(' · ');
            const chip = document.createElement('span');
            chip.className = `reference-chip ref-${ctx.type}`;
            chip.innerHTML = `
                ${svgIconNoMargin(meta.icon)}
                <span class="ref-kind">${mrEscapeHtml(getReferenceInitial(ctx, meta.label))}</span>
                <span class="ref-text" title="${mrEscapeHtml(title)}">${mrEscapeHtml(ctx.label)}${range}</span>
                ${metaBits ? `<span class="ref-meta">${mrEscapeHtml(metaBits)}</span>` : ''}
                <button class="remove-ctx-btn" data-id="${ctx.id}" aria-label="Remove reference">&times;</button>
            `;
            area!.appendChild(chip);
        });
        
        area.querySelectorAll('.remove-ctx-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = (e.currentTarget as HTMLElement).dataset.id;
                activeContexts = activeContexts.filter(c => c.id !== id);
                renderContextTray();
            });
        });
        updateComposerStackHeight();
        */
    }

    // ── Placeholder rotation ───────────────────────────────────────────────────
    const PROMPT_EXAMPLES = chatI18n.promptExamples;
    let placeholderIdx = Math.floor(Math.random() * PROMPT_EXAMPLES.length);
    let placeholderTimer: ReturnType<typeof setInterval> | null = null;

    function startPlaceholderRotation() {
        stopPlaceholderRotation();
        placeholderTimer = setInterval(() => {
            if (isInputEmpty() && !isGenerating) {
                placeholderIdx = (placeholderIdx + 1) % PROMPT_EXAMPLES.length;
                input.dataset.placeholder = PROMPT_EXAMPLES[placeholderIdx]!;
            }
        }, 6500);
    }
    function stopPlaceholderRotation() {
        if (placeholderTimer) { clearInterval(placeholderTimer); placeholderTimer = null; }
    }
    input.dataset.placeholder = PROMPT_EXAMPLES[placeholderIdx]!;
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
                setInputText(text);
                setTimeout(() => sendMessage(), 120);
            }
        });
    });

    // ── Dynamic Event Delegation for AI Options ─────────────────────────────────
    document.body.addEventListener('click', e => {
        const target = e.target as HTMLElement;
        const btn = target.closest('.ai-option-btn') as HTMLElement;
        if (btn) {
            const text = btn.getAttribute('data-suggest');
            if (text && !isGenerating) {
                // Check if this is part of a question-card wizard
                const card = btn.closest('.question-card') as HTMLElement;
                if (card) {
                    const container = card.closest('.question-wizard-container') as HTMLElement 
                                   || card.closest('.message.assistant') as HTMLElement;
                    if (container) {
                        const allCards = Array.from(container.querySelectorAll('.question-card')) as HTMLElement[];
                        const cardIndex = allCards.indexOf(card);
                        
                        const titleSpan = card.querySelector('.permission-card-title');
                        const cardTitle = titleSpan && titleSpan.textContent ? titleSpan.textContent.replace('❓ ', '').trim() : `问题 ${cardIndex + 1}`;

                        // Prevent double click by disabling buttons in current card
                        const allBtns = Array.from(card.querySelectorAll('button')) as HTMLButtonElement[];
                        allBtns.forEach(b => { b.style.pointerEvents = 'none'; });
                        btn.classList.add('selected');

                        if (allCards.length > 1) {
                            // Wizard Mode
                            const answers = (container as any)._collectedAnswers || [];
                            answers[cardIndex] = text;
                            (container as any)._collectedAnswers = answers;
                            
                            // User wants compact view: point click -> card disappears -> next appears
                            dismissCard(card, 100, () => {
                                // Show next card if available
                                if (cardIndex + 1 < allCards.length) {
                                    allCards[cardIndex + 1]!.style.display = 'block';
                                } else {
                                    // Final card! Prepare the batched message
                                    let combinedMessage = "";
                                    allCards.forEach((c, idx) => {
                                        const tSpan = c.querySelector('.permission-card-title');
                                        const title = tSpan && tSpan.textContent ? tSpan.textContent.replace('❓ ', '').trim() : `问题 ${idx + 1}`;
                                        combinedMessage += `【${title}】: ${answers[idx]}\n`;
                                    });
                                    
                                    // Cleanup the floating container
                                    if (container.classList.contains('question-wizard-container')) {
                                        container.remove();
                                        isShowingFloatingCard = false;
                                        processFloatingCardQueue();
                                    }
                                    
                                    // Append to existing input
                                    appendInputText(combinedMessage.trim() + '\n', '\n\n');
                                }
                            }, false); // <--- DO NOT remove from DOM, so index is preserved!
                            return;
                        } else {
                            // Single Card Mode
                            dismissCard(card, 100, () => {
                                if (container.classList.contains('question-wizard-container')) {
                                    container.remove();
                                    isShowingFloatingCard = false;
                                    processFloatingCardQueue();
                                }
                                const formattedText = `【${cardTitle}】: ${text}`;
                                appendInputText(formattedText + '\n', '\n\n');
                            }, false);
                            return;
                        }
                    }
                }
                
                // Normal behavior (not a question card)
                appendInputText(text, '\n');
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
        if (_atPopupVisible && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape')) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionSelectedIndex(_mentionSelectedIndex + 1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionSelectedIndex(_mentionSelectedIndex - 1);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                if (acceptSelectedMention()) return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAtPopup();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isGenerating) sendMessage();
        } else if (e.key === 'Tab') {
            e.preventDefault();
            const modes = ['build', 'plan', 'explore', 'utility', 'review', 'orchestrator'];
            const idx = modes.indexOf(currentMode);
            const cycleDir = e.shiftKey ? -1 : 1;
            const nextMode = modes[(idx + cycleDir + modes.length) % modes.length]!;
            switchMode(nextMode, true);
        }
    });
    input.addEventListener('input', () => {
        normalizeEmptyInput();
        syncContextsFromComposer();
        saveInputSelection();
        autoResizeInput();
    });
    input.addEventListener('keyup', saveInputSelection);
    input.addEventListener('mouseup', saveInputSelection);
    input.addEventListener('focus', saveInputSelection);
    input.addEventListener('select', saveInputSelection);
    input.addEventListener('focus', stopPlaceholderRotation);
    input.addEventListener('blur', () => { if (isInputEmpty()) startPlaceholderRotation(); });

    function bindBtn(id: string, handler: () => void) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    function setArtifactDrawerOpen(open: boolean) {
        const drawer = document.getElementById('artifactDrawer');
        const toggle = document.getElementById('btnArtifacts');
        if (open) closeSideWorkspace({ preserveResponsivePin: true });
        document.body.classList.toggle('artifact-drawer-open', open);
        drawer?.setAttribute('aria-hidden', open ? 'false' : 'true');
        toggle?.classList.toggle('active', open);
        updateWorkspaceToggleState();
    }

    function toggleArtifactDrawer() {
        const nextOpen = !document.body.classList.contains('artifact-drawer-open');
        if (nextOpen) topicsPanel.classList.remove('show');
        setArtifactDrawerOpen(nextOpen);
    }

    function getModeChipLabel(mode: string): string {
        const labels: Record<string, string> = {
            build: 'Build',
            plan: 'Plan',
            explore: 'Explore',
            utility: 'Utility',
            review: 'Review',
            orchestrator: 'Orchestrator',
        };
        return labels[mode === 'general' ? 'utility' : mode] || mode;
    }

    function closeComposerMenus() {
        const composerMenu = document.getElementById('composerMenu');
        const modelMenu = document.getElementById('modelMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        composerMenu?.classList.remove('show');
        composerMenu?.setAttribute('aria-hidden', 'true');
        modelMenu?.classList.remove('show');
        modelMenu?.setAttribute('aria-hidden', 'true');
        composerAddBtn?.classList.remove('active');
        quickModelTrigger?.classList.remove('active');
        quickModelTrigger?.setAttribute('aria-expanded', 'false');
    }

    function setComposerMenuOpen(open: boolean) {
        const composerMenu = document.getElementById('composerMenu');
        const modelMenu = document.getElementById('modelMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        composerMenu?.classList.toggle('show', open);
        composerMenu?.setAttribute('aria-hidden', open ? 'false' : 'true');
        composerAddBtn?.classList.toggle('active', open);
        if (open) positionComposerMenus();
        if (open) {
            modelMenu?.classList.remove('show');
            modelMenu?.setAttribute('aria-hidden', 'true');
            quickModelTrigger?.classList.remove('active');
            quickModelTrigger?.setAttribute('aria-expanded', 'false');
        }
    }

    function setModelMenuOpen(open: boolean) {
        const composerMenu = document.getElementById('composerMenu');
        const modelMenu = document.getElementById('modelMenu');
        const composerAddBtn = document.getElementById('composerAddBtn');
        const quickModelTrigger = document.getElementById('quickModelTrigger');
        modelMenu?.classList.toggle('show', open);
        modelMenu?.setAttribute('aria-hidden', open ? 'false' : 'true');
        quickModelTrigger?.classList.toggle('active', open);
        quickModelTrigger?.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) positionComposerMenus();
        if (open) {
            composerMenu?.classList.remove('show');
            composerMenu?.setAttribute('aria-hidden', 'true');
            composerAddBtn?.classList.remove('active');
        }
    }

    function positionComposerMenus(): void {
        if (!inputWrapper) return;
        const wrapperRect = inputWrapper.getBoundingClientRect();
        const composerMenu = document.getElementById('composerMenu') as HTMLElement | null;
        const modelMenu = document.getElementById('modelMenu') as HTMLElement | null;
        const composerAddBtn = document.getElementById('composerAddBtn') as HTMLElement | null;
        const quickModelTrigger = document.getElementById('quickModelTrigger') as HTMLElement | null;

        const positionMenu = (menu: HTMLElement | null, anchor: HTMLElement | null) => {
            if (!menu || !anchor) return;
            const anchorRect = anchor.getBoundingClientRect();
            const preferredLeft = anchorRect.left - wrapperRect.left;
            const menuWidth = menu.offsetWidth || 260;
            const maxLeft = Math.max(12, wrapperRect.width - menuWidth - 12);
            menu.style.left = `${Math.max(12, Math.min(preferredLeft, maxLeft))}px`;
        };

        positionMenu(composerMenu, composerAddBtn);
        positionMenu(modelMenu, quickModelTrigger);
    }

    function renderComposerChips() {
        const chipRow = document.getElementById('composerChipRow');
        if (!chipRow) return;
        chipRow.innerHTML = '';

        if (currentMode !== 'build') {
            const modeChip = document.createElement('button');
            modeChip.className = 'composer-chip';
            modeChip.type = 'button';
            modeChip.title = 'Clear mode';
            const modeIcon = document.createElement('span');
            modeIcon.className = 'composer-chip-icon';
            modeIcon.innerHTML = Icons.x;
            const modeText = document.createElement('span');
            modeText.textContent = getModeChipLabel(currentMode);
            modeChip.append(modeIcon, modeText);
            modeChip.addEventListener('click', e => {
                e.stopPropagation();
                switchMode('build', true);
            });
            chipRow.appendChild(modeChip);
        }

        if (activeWorkflowId) {
            const activeWorkflow = workflows.find(workflow => workflow.id === activeWorkflowId);
            const workflowChip = document.createElement('button');
            workflowChip.className = 'composer-chip workflow-chip';
            workflowChip.type = 'button';
            workflowChip.title = 'Turn off workflow';
            const label = activeWorkflow?.title || activeWorkflowId;
            const workflowIcon = document.createElement('span');
            workflowIcon.className = 'composer-chip-icon';
            workflowIcon.innerHTML = Icons.x;
            const workflowText = document.createElement('span');
            workflowText.textContent = label;
            workflowChip.append(workflowIcon, workflowText);
            workflowChip.addEventListener('click', e => {
                e.stopPropagation();
                vscode.postMessage({ type: 'switchWorkflow', workflowId: null });
            });
            chipRow.appendChild(workflowChip);
        }

        document.querySelectorAll<HTMLElement>('.composer-menu-item[data-mode]').forEach(item => {
            item.classList.toggle('active', item.dataset.mode === currentMode);
        });
    }

    function renderQuickModelMenu() {
        const label = document.getElementById('quickModelLabel');
        const list = document.getElementById('modelMenuList');
        const trigger = document.getElementById('quickModelTrigger');
        if (label) label.textContent = quickModelCurrent || 'Model';
        if (trigger) trigger.title = quickModelCurrent ? `Model: ${quickModelCurrent}` : 'Select model';
        if (!list) return;
        list.innerHTML = '';

        if (!quickModelOptions.length) {
            const empty = document.createElement('div');
            empty.className = 'model-menu-empty';
            empty.textContent = 'No models available';
            list.appendChild(empty);
            return;
        }

        for (const model of quickModelOptions) {
            const btn = document.createElement('button');
            btn.className = 'model-menu-item';
            btn.type = 'button';
            btn.textContent = model;
            btn.classList.toggle('active', model === quickModelCurrent);
            btn.addEventListener('click', () => {
                const qms = document.getElementById('quickModelSelect') as HTMLSelectElement | null;
                if (qms) qms.value = model;
                quickModelCurrent = model;
                renderQuickModelMenu();
                setModelMenuOpen(false);
                vscode.postMessage({ type: 'quickChangeModel', model });
            });
            list.appendChild(btn);
        }
    }

    const quickModelSel = document.getElementById('quickModelSelect');
    if (quickModelSel) {
        quickModelSel.addEventListener('change', () => {
            quickModelCurrent = (quickModelSel as HTMLSelectElement).value;
            renderQuickModelMenu();
            vscode.postMessage({ type: 'quickChangeModel', model: quickModelCurrent });
        });
    }

    const composerAddBtn = document.getElementById('composerAddBtn');
    const quickModelTrigger = document.getElementById('quickModelTrigger');
    composerAddBtn?.addEventListener('click', e => {
        e.stopPropagation();
        const composerMenu = document.getElementById('composerMenu');
        setComposerMenuOpen(!composerMenu?.classList.contains('show'));
    });
    quickModelTrigger?.addEventListener('click', e => {
        e.stopPropagation();
        const modelMenu = document.getElementById('modelMenu');
        setModelMenuOpen(!modelMenu?.classList.contains('show'));
    });
    document.querySelectorAll<HTMLElement>('.composer-menu-item[data-mode]').forEach(item => {
        item.addEventListener('click', () => {
            const mode = item.dataset.mode;
            if (mode) switchMode(mode, true);
            setComposerMenuOpen(false);
        });
    });
    document.querySelectorAll<HTMLElement>('.composer-menu-item[data-composer-action]').forEach(item => {
        item.addEventListener('click', () => {
            const action = item.dataset.composerAction;
            setComposerMenuOpen(false);
            if (action === 'media') {
                document.getElementById('imgPickBtn')?.click();
            } else if (action === 'mentions') {
                insertPlainTextAtRange('@');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (action === 'workflows') {
                setInputText('/workflow:');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
    });
    document.addEventListener('click', e => {
        const target = e.target as Element | null;
        if (!target?.closest('#composerMenu') && !target?.closest('#composerAddBtn') && !target?.closest('#modelMenu') && !target?.closest('#quickModelTrigger')) {
            closeComposerMenus();
        }
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeComposerMenus();
    });

    bindBtn('btnNewTopic', () => vscode.postMessage({ type: 'newTopic' }));
    bindBtn('currentTopicTitle', () => {
        if (currentTopicId) startTopicRename(currentTopicId, currentTopicTitle, 'header');
    });
    bindBtn('currentTopicRename', () => {
        if (currentTopicId) startTopicRename(currentTopicId, currentTopicTitle, 'header');
    });
    bindBtn('btnWorkspace', openWorkspaceFromButton);
    bindBtn('btnArtifacts', toggleArtifactDrawer);
    bindBtn('btnAgentManager', () => vscode.postMessage({ type: 'openAgentManager' }));
    bindBtn('btnCloseArtifacts', () => setArtifactDrawerOpen(false));
    bindBtn('artifactScrim', () => setArtifactDrawerOpen(false));
    document.querySelectorAll<HTMLElement>('[data-artifact-filter]').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.artifactFilter;
            artifactFilter = (next === 'plan' || next === 'validation' || next === 'diff') ? next : 'all';
            renderArtifactPanel();
        });
    });
    bindBtn('btnTopics', () => {
        if (isManagerTopicsRailMode()) {
            const collapsed = !document.body.classList.contains('manager-topics-collapsed');
            document.body.classList.toggle('manager-topics-collapsed', collapsed);
            updateManagerTopicsToggleState();
            updateComposerStackHeight();
            positionComposerMenus();
            return;
        }
        setArtifactDrawerOpen(false);
        if (shouldUseSideWorkspace()) {
            if (document.body.classList.contains('side-workspace-open') && sideWorkspaceContent === topicsPanel) {
                closeSideWorkspace();
                return;
            }
            topicsPanel.classList.add('show');
            openSideWorkspace({ title: '历史话题', subtitle: '搜索、切换和管理对话', content: topicsPanel });
            return;
        }
        closeSideWorkspace();
        topicsPanel.classList.toggle('show');
        updateWorkspaceToggleState();
        updateManagerTopicsToggleState();
    });
    bindBtn('btnNewTopicPanel', () => { vscode.postMessage({ type: 'newTopic' }); topicsPanel.classList.remove('show'); if (sideWorkspaceContent === topicsPanel) closeSideWorkspace(); });
    updateManagerTopicsToggleState();
    bindBtn('btnSettings', () => {
        setArtifactDrawerOpen(false);
        vscode.postMessage({ type: 'openSettings' });
        topicsPanel.classList.remove('show');
    });
    bindBtn('settingsBackBtn', closeSettings);
    bindBtn('sideWorkspaceClose', closeSideWorkspace);
    bindBtn('testConnBtn', testConnection);
    bindBtn('saveSettingsBtn', saveSettings);
    bindBtn('keyToggleBtn', () => { const k = document.getElementById('settingsApiKey') as HTMLInputElement | null; if (k) k.type = k.type === 'password' ? 'text' : 'password'; });
    bindBtn('fetchApiModelsBtn', () => { fetchApiModels(); });
    bindBtn('deleteApiKeyBtn', () => { deleteApiKey(); });
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

    if (settingsPage) {
        settingsPage.addEventListener('input', () => { if (settingsPage.classList.contains('active')) refreshSettingsOverview(); });
        settingsPage.addEventListener('change', () => { if (settingsPage.classList.contains('active')) refreshSettingsOverview(); });
    }

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
        if (sideWorkspaceContent === topicsPanel) closeSideWorkspace();
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && document.body.classList.contains('artifact-drawer-open')) {
            setArtifactDrawerOpen(false);
        } else if (e.key === 'Escape' && document.body.classList.contains('side-workspace-open')) {
            closeSideWorkspace();
        }
    });
    renderArtifactPanel();


    // ── Mode dropdown ──────────────────────────────────────────────────────────
    const modeSel = document.getElementById('modeSel') as HTMLSelectElement | null;
    if (modeSel) {
        modeSel.addEventListener('change', () => {
            switchMode(modeSel.value, /* fromUI */ true);
        });
    }

    // ── Slash command popup ────────────────────────────────────────────────────
    const slashPopup = document.getElementById('slashPopup');

    function showSlashPopup(filter: string) {
        if (!slashPopup) return;
        const matches = filterSlashCommands(
            buildSlashCommands(chatI18n.slashDescriptions, workflows),
            filter
        );
        if (!matches.length) { slashPopup.classList.remove('show'); return; }
        slashPopup.innerHTML = renderSlashCommandItems(matches);
        slashPopup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('click', () => {
                const cmd = (el as HTMLElement).dataset.cmd;
                slashPopup.classList.remove('show');
                vscode.postMessage({ type: 'slashCommand', command: cmd });
                clearInput();
            });
        });
        slashPopup.classList.add('show');
    }

    input.addEventListener('input', () => {
        autoResizeInput();
        const v = getInputText();
        if (v.startsWith('/') && v.length > 0) showSlashPopup(v);
        else slashPopup?.classList.remove('show');
        const mentionFilter = getMentionFilterBeforeCaret();
        if (mentionFilter !== null) {
            showAtPopup(mentionFilter);
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
        document.body.appendChild(el);
        return el;
    })();
    let _atPopupVisible = false;

    let _mentionDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let _mentionResults: MentionResult[] = [];
    let _mentionSelectedIndex = 0;

    function showAtPopup(filter: string) {
        if (!atPopup) return;
        const q = filter.trim();

        if (_mentionDebounceTimer) clearTimeout(_mentionDebounceTimer);
        _mentionDebounceTimer = setTimeout(() => {
            vscode.postMessage({ type: 'requestMentionSearch', query: q });
        }, q ? 200 : 0);
    }

    function renderMentionMenu(results: MentionResult[]) {
        if (!atPopup) return;
        _mentionResults = results;
        _mentionSelectedIndex = 0;
        if (results.length === 0) {
            atPopup.style.display = 'none';
            atPopup.classList.remove('show');
            _atPopupVisible = false;
            return;
        }

        const groups = new Map<string, Array<{ res: MentionResult; index: number }>>();
        results.forEach((res, index) => {
            const type = res.type || 'file';
            const label = CONTEXT_TYPE_META[type]?.label || 'file';
            const items = groups.get(label) || [];
            items.push({ res, index });
            groups.set(label, items);
        });

        atPopup.innerHTML = Array.from(groups.entries()).map(([groupLabel, items]) => {
            const itemsHtml = items.map(({ res, index }) => {
                const type = res.type || 'file';
                const meta = CONTEXT_TYPE_META[type] || CONTEXT_TYPE_META.file;
                const detailBits = [
                    res.tokenEstimate ? `~${formatNum(res.tokenEstimate)} tok` : '',
                    res.cacheStatus || '',
                ].filter(Boolean).join(' · ');
                return `<div class="slash-popup-item ${index === _mentionSelectedIndex ? 'selected' : ''}" data-index="${index}" tabindex="${index}">` +
                    `<span class="slash-popup-cmd">${svgIconNoMargin(meta.icon)} @${escapeHtml(res.label)}</span>` +
                    `<span class="slash-popup-desc">${escapeHtml(res.desc)}</span>` +
                    (detailBits ? `<span class="slash-popup-meta">${escapeHtml(detailBits)}</span>` : '') +
                `</div>`;
            }).join('');
            return `<div class="mention-group"><div class="mention-group-title">${escapeHtml(groupLabel)}</div>${itemsHtml}</div>`;
        }).join('');

        saveInputSelection();
        atPopup.querySelectorAll('.slash-popup-item').forEach(el => {
            el.addEventListener('mousedown', e => {
                e.preventDefault();
                saveInputSelection();
            });
            el.addEventListener('click', e => {
                e.preventDefault();
                const index = Number((el as HTMLElement).dataset.index);
                const result = results[index];
                if (!result) return;
                const type = result.type || 'file';
                if ((type === 'file' || type === 'folder' || type === 'code_selection') && !result.uri) return;
                const isTemplate = (type === 'symbol' || type === 'vanilla' || type === 'blackboard')
                    && !result.uri && !result.name && !result.key && !result.vanillaType;
                if (isTemplate) {
                    replaceAtTriggerWithText('@' + result.label);
                    showAtPopup(result.label);
                    return;
                }
                closeAtPopup();
                replaceAtTriggerWithReference(mentionResultToActiveContext(result));
            });
        });
        atPopup.style.display = '';
        atPopup.classList.add('show');
        _atPopupVisible = true;
    }

    function setMentionSelectedIndex(index: number) {
        if (!atPopup || _mentionResults.length === 0) return;
        _mentionSelectedIndex = (index + _mentionResults.length) % _mentionResults.length;
        atPopup.querySelectorAll('.slash-popup-item').forEach((el, idx) => {
            el.classList.toggle('selected', idx === _mentionSelectedIndex);
            if (idx === _mentionSelectedIndex) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
        });
    }

    function renderArtifactPanel() {
        const openArtifact = (artifactId: string, file?: string) => {
            if (openArtifactDiffInSideWorkspace(artifactId, file)) return;
            vscode.postMessage({ type: 'openArtifact', artifactId, file });
        };

        renderArtifactDrawer(
            {
                list: document.getElementById('artifactList'),
                count: document.getElementById('artifactCount'),
                toggle: document.getElementById('btnArtifacts'),
                filterButtons: document.querySelectorAll<HTMLElement>('[data-artifact-filter]'),
            },
            artifacts,
            artifactFilter,
            chatI18n,
            {
                openPlanFile: filePath => vscode.postMessage({ type: 'openPlanFile', filePath }),
                openArtifact,
            },
        );
    }

    function openArtifactDiffInSideWorkspace(artifactId: string, file?: string): boolean {
        const artifact = artifacts.find(item => item.id === artifactId);
        if (!artifact || (artifact.kind !== 'diff' && artifact.action !== 'openDiff')) return false;

        const files = getDiffArtifactFiles(artifact).map(change => ({
            file: change.file,
            status: change.status,
            diffPreview: change.diffPreview,
            additions: change.additions,
            deletions: change.deletions,
            diffLines: change.diffLines,
        }));
        if (files.length === 0) return true;

        openDiffInSideWorkspace(files, '文件变更', { sourceKey: artifactId, focusFile: file });
        return true;
    }

    function restoreArtifactsFromMessages(messages: any[]) {
        const restored: ArtifactRecord[] = [];
        const pushUnique = (artifact: ArtifactRecord) => {
            if (!restored.some(a => a.id === artifact.id)) restored.push(artifact);
        };
        for (const message of messages) {
            if (!message?.steps) continue;
            for (const step of message.steps) {
                const stamp = step.timestamp || message.timestamp || Date.now();
                if (step.type === 'plan_card') {
                    pushUnique({
                        id: `restored:plan:${step.content}`,
                        kind: 'plan',
                        title: step.mode === 'orchestrator' ? 'Orchestrator Plan' : 'Implementation Plan',
                        summary: 'Restored from chat history.',
                        filePath: step.content,
                        relPath: step.content,
                        status: step.uiState === 'approved' ? 'done' : 'pending',
                        createdAt: stamp,
                    });
                } else if (step.type === 'blueprint_card') {
                    pushUnique({
                        id: `restored:blueprint:${step.content}`,
                        kind: 'blueprint',
                        title: 'Design Blueprint',
                        summary: 'Restored from chat history.',
                        filePath: step.content,
                        relPath: step.content,
                        status: step.uiState === 'approved' ? 'done' : 'pending',
                        createdAt: stamp,
                    });
                } else if (step.type === 'walkthrough_card') {
                    pushUnique({
                        id: `restored:walkthrough:${step.content}`,
                        kind: 'walkthrough',
                        title: 'Walkthrough Report',
                        summary: 'Full task walkthrough restored from chat history.',
                        filePath: step.content,
                        relPath: step.content,
                        status: 'done',
                        createdAt: stamp,
                    });
                } else if (step.type === 'validation') {
                    pushUnique({
                        id: `restored:validation:${stamp}`,
                        kind: 'validation',
                        title: 'Validation Result',
                        summary: step.content || 'Validation step restored from history.',
                        status: /error|failed|失败|错误/i.test(step.content || '') ? 'failed' : 'done',
                        createdAt: stamp,
                        data: step.toolResult,
                    });
                } else if (step.toolName === 'get_diagnostics') {
                    pushUnique({
                        id: `restored:diagnostics:${stamp}`,
                        kind: 'diagnostics',
                        title: 'Diagnostics Report',
                        summary: 'Restored get_diagnostics result.',
                        status: 'done',
                        createdAt: stamp,
                        data: step.toolResult,
                    });
                }
            }
        }
        artifacts = restoreArtifactsFromHistory(messages);
        renderArtifactPanel();
    }

    function acceptSelectedMention() {
        if (!atPopup || !_atPopupVisible) return false;
        const item = atPopup.querySelector(`.slash-popup-item[data-index="${_mentionSelectedIndex}"]`) as HTMLElement | null;
        if (!item) return false;
        item.click();
        return true;
    }

    function closeAtPopup() {
        if (atPopup) {
            atPopup.style.display = 'none';
            atPopup.classList.remove('show');
            _atPopupVisible = false;
            _mentionResults = [];
            _mentionSelectedIndex = 0;
        }
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
    input.addEventListener('paste', e => {
        const items = e.clipboardData && e.clipboardData.items;
        const text = e.clipboardData?.getData('text/plain') || '';
        let handled = false;
        if (items) {
            for (const item of Array.from(items)) {
                if (!item.type.startsWith('image/')) continue;
                handled = true;
                const blob = item.getAsFile();
                if (!blob) continue;
                compressImage(blob, dataUrl => {
                    pendingImages.push(dataUrl);
                    addImagePreview(dataUrl);
                });
            }
        }
        if (text) {
            handled = true;
            insertPlainTextAtRange(normalizePastedText(text));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (handled) e.preventDefault();
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
            area.style.cssText = '';
            //Before inserting into input-container inside input-row, make sure the image preview is within the rounded corner of the input box
            const container = document.querySelector('.input-container');
            const inputRow = container?.querySelector('.input-row');
            if (container && inputRow) container.insertBefore(area, inputRow);
            else inputWrapper?.prepend(area);
        }
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative;display:inline-block;width:48px;height:48px;flex-shrink:0;';
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px;border:1px solid rgba(255,255,255,0.1);cursor:zoom-in;transition:transform 0.15s;display:block;';
        img.title = '点击放大';
        img.addEventListener('click', () => showImageLightbox(dataUrl));
        img.addEventListener('mouseenter', () => { img.style.transform = 'scale(1.07)'; });
        img.addEventListener('mouseleave', () => { img.style.transform = ''; });
        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:rgba(38,38,40,0.96);color:#fff;border:1px solid rgba(255,255,255,0.18);cursor:pointer;font-size:11px;line-height:1;padding:0;display:flex;align-items:center;justify-content:center;';
        del.addEventListener('click', () => {
            pendingImages = pendingImages.filter(u => u !== dataUrl);
            wrap.remove();
            updateComposerStackHeight();
        });
        wrap.appendChild(img); wrap.appendChild(del);
        area.appendChild(wrap);
        updateComposerStackHeight();
    }


    const providerSel = document.getElementById('settingsProvider');
    if (providerSel) providerSel.addEventListener('change', onProviderChange);
    const endpointInp = document.getElementById('settingsEndpoint');
    if (endpointInp) endpointInp.addEventListener('input', onEndpointChange);

    function sendMessage() {
        syncContextsFromComposer();
        const text = getInputText().trim();
        if (!text && pendingImages.length === 0 && activeContexts.length === 0) return;
        setChatEmptyState(false);

        const imagesToSend = pendingImages.length > 0 ? [...pendingImages] : undefined;
        const contextsToSend = activeContexts.length > 0 ? activeContexts.map(ctx => ({ ...ctx })) : undefined;

        if (editingMessageIndex !== null) {
            vscode.postMessage({
                type: 'editAndResendMessage',
                messageIndex: editingMessageIndex,
                text,
                contexts: contextsToSend,
                images: imagesToSend,
            });
            editingMessageIndex = null;
            renderEditComposerState();
        } else if (activeContexts.length > 0) {
            vscode.postMessage({
                type: 'sendMessageWithReference',
                text,
                contexts: contextsToSend || [],
                images: imagesToSend,
            });
            activeContexts = [];
        } else {
            vscode.postMessage({
                type: 'sendMessage',
                text,
                images: imagesToSend,
                attachedFiles: pendingFiles.length > 0 ? [...pendingFiles] : undefined,
            });
        }
        
        clearInput();
        stopPlaceholderRotation();
        clearComposerAttachmentPreviews();
        updateComposerStackHeight();
    }

    /**
     * switchMode(mode, fromUI)
     * fromUI=true  → user clicked dropdown → send message to backend + update UI
     * fromUI=false → backend sent modeChanged message → only update UI (no echo back)
     */
    function switchMode(mode: string, fromUI?: boolean) {
        if (mode === 'general') mode = 'utility';
        if (currentMode === mode && !fromUI) return; // avoid redundant update
        // Only post to backend when user initiated (avoids ping-pong)
        if (fromUI) vscode.postMessage({ type: 'switchMode', mode });
        currentMode = applyModeUi(
            mode,
            chatI18n.modeLabels,
            document.body,
            document.getElementById('modeSel') as HTMLSelectElement | null,
            document.getElementById('modeIndicator')
        );
        renderComposerChips();
    }
    
    // Give initial mode its body class
    document.body.classList.add('build-mode');
    renderComposerChips();

    function setGenerating(val: boolean) {
        isGenerating = val;
        if (val) {
            sendBtn.innerHTML = '<span class="stop-icon"></span>';
            sendBtn.title = chatI18n.buttons.cancelGeneration;
            sendBtn.className = 'send-btn cancel-mode';
        } else {
            sendBtn.innerHTML = '<span class="send-icon">↑</span>';
            sendBtn.title = `${chatI18n.buttons.send} (Enter)`;
            sendBtn.className = 'send-btn';
            if (isInputEmpty()) startPlaceholderRotation();
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
        bar.style.display = 'flex';
    }

    // Delegated to chat/formatters.ts for single-source-of-truth
    const formatNum = _fmtFormatNum;
    const formatTime = _fmtFormatTime;
    const escapeHtml = _fmtEscapeHtml;

    let isUserScrolledUp = false;
    let scrollBottomPending = false;
    let subagentScrollPending = false;
    const subagentUserScrolledUp = new WeakMap<HTMLElement, boolean>();
    const jumpLatestBtn = document.createElement('button');
    jumpLatestBtn.className = 'jump-latest-btn';
    jumpLatestBtn.type = 'button';
    jumpLatestBtn.innerHTML = `${svgIconNoMargin('pointer')} 最新消息`;
    jumpLatestBtn.addEventListener('click', () => {
        scrollBottom(true);
        jumpLatestBtn.classList.remove('show');
    });
    document.body.appendChild(jumpLatestBtn);
    chatArea.addEventListener('scroll', () => {
        isUserScrolledUp = chatArea.scrollHeight - chatArea.scrollTop - chatArea.clientHeight > 65;
        jumpLatestBtn.classList.toggle('show', isUserScrolledUp);
    });

    function bindSubagentScroll(fullscreen: HTMLElement): void {
        if (fullscreen.dataset.scrollBound === 'true') return;
        fullscreen.dataset.scrollBound = 'true';
        fullscreen.addEventListener('scroll', () => {
            const scrolledUp = fullscreen.scrollHeight - fullscreen.scrollTop - fullscreen.clientHeight > 65;
            subagentUserScrolledUp.set(fullscreen, scrolledUp);
        });
    }

    function scrollSubagentBottom(fullscreen: HTMLElement): void {
        if (subagentScrollPending) return;
        subagentScrollPending = true;
        requestAnimationFrame(() => {
            subagentScrollPending = false;
            fullscreen.scrollTop = fullscreen.scrollHeight;
            subagentUserScrolledUp.set(fullscreen, false);
        });
    }

    function scrollBottom(force = false) {
        const activeSubagent = document.querySelector('.subagent-fullscreen-view.active') as HTMLElement | null;
        if (activeSubagent) {
            bindSubagentScroll(activeSubagent);
            if (force || !subagentUserScrolledUp.get(activeSubagent)) {
                scrollSubagentBottom(activeSubagent);
            }
            return;
        }
        if (force || !isUserScrolledUp) {
            if (scrollBottomPending) return;
            scrollBottomPending = true;
            requestAnimationFrame(() => {
                scrollBottomPending = false;
                chatArea.scrollTop = chatArea.scrollHeight;
                isUserScrolledUp = false;
                jumpLatestBtn.classList.remove('show');
            });
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

    // Delegated to chat/formatters.ts
    const WRITE_TOOL_NAMES = _fmtWriteTools;
    const READ_TOOL_NAMES = _fmtReadTools;
    const VALIDATION_TOOL_NAMES = _fmtValidationTools;
    const ORCHESTRATOR_TOOL_NAMES = _fmtOrchestratorTools;
    type RunSummary = _FmtRunSummary;
    const extractStepFile = _fmtExtractStepFile;

    function makeRunSummary(steps: any[] | undefined, fallbackContent?: string): RunSummary {
        const all = steps || [];
        const timestamps = all.map(s => Number(s.timestamp || 0)).filter(Boolean);
        const startedAt = timestamps.length ? Math.min(...timestamps) : null;
        const endedAt = timestamps.length ? Math.max(...timestamps) : null;
        const toolCounts = new Map<string, number>();
        const files = new Set<string>();
        let thinkingCount = 0;
        let toolCallCount = 0;
        let toolResultCount = 0;
        let writeCount = 0;
        let readCount = 0;
        let validationCount = 0;
        let orchestratorCount = 0;
        let errorCount = 0;
        let failedToolCount = 0;
        let latestStatus = fallbackContent?.trim() ? fallbackContent.trim() : '已完成';
        const alerts: string[] = [];
        const validations: string[] = [];

        for (const step of all) {
            const type = step?.type || '';
            if (type === 'thinking' || type === 'thinking_content') thinkingCount++;
            if (type === 'tool_call') {
                const toolName = String(step.toolName || 'tool');
                const file = extractStepFile(step);
                toolCallCount++;
                toolCounts.set(toolName, (toolCounts.get(toolName) || 0) + 1);
                if (WRITE_TOOL_NAMES.has(toolName)) {
                    writeCount++;
                    if (file) files.add(file);
                } else if (READ_TOOL_NAMES.has(toolName)) {
                    readCount++;
                } else if (VALIDATION_TOOL_NAMES.has(toolName)) {
                    validationCount++;
                } else if (ORCHESTRATOR_TOOL_NAMES.has(toolName)) {
                    orchestratorCount++;
                }
                latestStatus = file ? `正在调用 ${toolName}: ${file}` : `正在调用 ${toolName}`;
            } else if (type === 'tool_result') {
                toolResultCount++;
                const result = step.toolResult as any;
                if (result?.success === false || result?.error) {
                    failedToolCount++;
                    const msg = String(result?.message || result?.error || `${step.toolName || '工具'} 执行失败`);
                    alerts.push(msg);
                }
                latestStatus = result?.success === false || result?.error
                    ? `${step.toolName || '工具'} 返回问题`
                    : `${step.toolName || '工具'} 已返回`;
            } else if (type === 'validation') {
                validationCount++;
                if (step.content) validations.push(String(step.content));
            } else if (type === 'error') {
                errorCount++;
                if (step.content) alerts.push(String(step.content));
            } else if (type === 'orchestrator_progress' || type === 'subtask_start' || type === 'subtask_complete') {
                orchestratorCount++;
            }
            if (step?.content && ['error', 'validation', 'orchestrator_progress', 'subtask_complete'].includes(type)) {
                latestStatus = String(step.content).replace(/\$\(([\w-]+)\)/g, '').trim() || latestStatus;
            }
        }

        return {
            startedAt,
            endedAt,
            durationMs: startedAt && endedAt ? Math.max(0, endedAt - startedAt) : 0,
            totalSteps: all.length,
            thinkingCount,
            toolCallCount,
            toolResultCount,
            writeCount,
            readCount,
            validationCount,
            orchestratorCount,
            errorCount,
            failedToolCount,
            changedFiles: Array.from(files).slice(0, 8),
            topTools: Array.from(toolCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 4)
                .map(([name, count]) => ({ name, count })),
            latestStatus,
            hasOrchestrator: orchestratorCount > 0 || all.some(s => !!s.agentId),
            alerts: alerts.slice(0, 3),
            validations: validations.slice(0, 3),
        };
    }

    function renderRunSummaryHtml(summary: RunSummary, live = false): string {
        const severity = summary.errorCount > 0 || summary.failedToolCount > 0 ? 'error'
            : summary.validationCount > 0 ? 'ok'
            : summary.hasOrchestrator ? 'orch'
            : 'normal';
        const title = live ? '正在执行' : severity === 'error' ? '执行完成，有问题需要查看' : '执行完成';
        const duration = summary.durationMs > 0 ? formatDuration(summary.durationMs) : (live ? '进行中' : '短任务');
        const fileText = summary.changedFiles.length > 0 ? summary.changedFiles.join(', ') : '无文件改动';
        const toolText = summary.topTools.length > 0
            ? summary.topTools.map(t => `${t.name} ${t.count}×`).join(' · ')
            : '未调用工具';
        const status = summary.latestStatus.length > 110 ? summary.latestStatus.slice(0, 110) + '...' : summary.latestStatus;
        const alertHtml = summary.alerts.length > 0
            ? `<div class="run-summary-alerts">${summary.alerts.map(a => `<div>${svgIconNoMargin('warning')} ${escapeHtml(a.length > 160 ? a.slice(0, 160) + '...' : a)}</div>`).join('')}</div>`
            : summary.validations.length > 0
                ? `<div class="run-summary-alerts run-summary-validations">${summary.validations.slice(0, 2).map(v => `<div>${svgIconNoMargin('check')} ${escapeHtml(v.length > 160 ? v.slice(0, 160) + '...' : v)}</div>`).join('')}</div>`
                : '';
        return `
            <section class="run-summary run-summary-${severity} ${live ? 'run-summary-live' : ''}">
                <div class="run-summary-head">
                    <span class="run-summary-icon">${live ? svgIconNoMargin('refresh') : svgIconNoMargin(severity === 'error' ? 'warning' : severity === 'orch' ? 'bot' : 'check')}</span>
                    <div class="run-summary-title-wrap">
                        <div class="run-summary-title">${escapeHtml(title)}</div>
                        <div class="run-summary-status">${escapeHtml(status)}</div>
                    </div>
                    <span class="run-summary-duration">${escapeHtml(duration)}</span>
                </div>
                <div class="run-summary-metrics">
                    <span>${svgIconNoMargin('gear')} ${summary.toolCallCount} 工具</span>
                    <span>${svgIconNoMargin('edit')} ${summary.writeCount} 写入</span>
                    <span>${svgIconNoMargin('search')} ${summary.readCount} 读取</span>
                    <span>${svgIconNoMargin('stethoscope')} ${summary.validationCount} 验证</span>
                    ${summary.errorCount + summary.failedToolCount > 0 ? `<span class="run-summary-danger">${svgIconNoMargin('x')} ${summary.errorCount + summary.failedToolCount} 问题</span>` : ''}
                </div>
                <div class="run-summary-foot">
                    <span class="run-summary-files" title="${escapeHtml(fileText)}">${escapeHtml(fileText)}</span>
                    <span class="run-summary-tools" title="${escapeHtml(toolText)}">${escapeHtml(toolText)}</span>
                </div>
                ${alertHtml}
            </section>
        `;
    }

    // Delegated to chat/formatters.ts
    const formatDuration = _fmtFormatDuration;

    function buildProcessPanel(sortedSteps: any[]) {
        const thinkingSteps = sortedSteps.filter((s: any) => s.type === 'thinking' || s.type === 'thinking_content');
        const textDeltas = sortedSteps.filter((s: any) => s.type === 'text_delta');
        const specialSteps = sortedSteps.filter((s: any) => !['thinking', 'thinking_content', 'tool_call', 'tool_result', 'text_delta'].includes(s.type));
        const toolCalls = sortedSteps.filter((s: any) => s.type === 'tool_call');
        const toolResults = sortedSteps.filter((s: any) => s.type === 'tool_result');
        const hasFailedTool = toolResults.some((s: any) => {
            const r = s.toolResult as any;
            return r?.success === false || !!r?.error;
        });
        const hasUsefulContent = thinkingSteps.length > 0 || toolCalls.length > 0 || specialSteps.length > 0 || textDeltas.length > 0;
        if (!hasUsefulContent) return null;

        const panel = document.createElement('details');
        panel.className = 'agent-process-panel';
        panel.open = hasFailedTool;
        const summary = document.createElement('summary');
        summary.innerHTML = `
            ${svgIconNoMargin('layers')}
            <span class="process-title">探索过程</span>
            <span class="process-meta">${thinkingSteps.length} 思考 · ${toolCalls.length} 工具 · ${textDeltas.length} 文本</span>
        `;
        panel.appendChild(summary);

        const stack = document.createElement('div');
        stack.className = 'process-stack';

        if (thinkingSteps.length > 0) {
            let thinkText = '';
            for (const s of thinkingSteps) {
                if (s.type === 'thinking' && thinkText) thinkText += '\n\n---\n\n' + (s.content || '');
                else thinkText += (s.content || '');
            }
            thinkText = thinkText.trim();
            if (thinkText) {
                const estTokens = Math.ceil(thinkText.length / 4);
                const thinking = document.createElement('details');
                thinking.className = 'process-section process-thinking';
                thinking.innerHTML = `<summary>${svgIconNoMargin('messageSquare')} 思考详情 <span>~${formatNum(estTokens)} tokens</span></summary>`;
                const thinkingBody = document.createElement('div');
                thinkingBody.className = 'thinking-body markdown-body';
                thinkingBody.innerHTML = renderMarkdown(thinkText);
                thinking.appendChild(thinkingBody);
                stack.appendChild(thinking);
            }
        }

        if (textDeltas.length > 0) {
            const text = textDeltas.map((s: any) => s.content || '').join('').trim();
            if (text) {
                const textBlock = document.createElement('details');
                textBlock.className = 'process-section process-text';
                textBlock.innerHTML = `<summary>${svgIconNoMargin('file')} 过程文本 <span>${textDeltas.length} chunks</span></summary>`;
                const textBody = document.createElement('div');
                textBody.className = 'thinking-body process-text-body markdown-body';
                textBody.innerHTML = renderMarkdown(text);
                textBlock.appendChild(textBody);
                stack.appendChild(textBlock);
            }
        }

        if (toolCalls.length > 0) {
            const tools = document.createElement('details');
            tools.className = 'process-section process-tools';
            tools.open = hasFailedTool;
            tools.innerHTML = `<summary>${svgIconNoMargin('gear')} 工具详情 <span>${toolCalls.length} 次调用${hasFailedTool ? ' · 有失败' : ''}</span></summary>`;
            const timelineDiv = document.createElement('div');
            timelineDiv.className = 'tool-timeline process-tool-timeline';
            const resultsCopy = [...toolResults];
            toolCalls.forEach((call: any, idx: number) => {
                const resultIdx = resultsCopy.findIndex((r: any) => r.toolName === call.toolName);
                let result: RendererStep | undefined;
                if (resultIdx >= 0) result = resultsCopy.splice(resultIdx, 1)[0];
                const wrapper = document.createElement('div');
                wrapper.innerHTML = buildToolPairHtml(call, result, {
                    stepIndex: call.stepIndex || idx + 1,
                    showDuration: true,
                    showParams: true,
                    showDiff: true,
                });
                if (wrapper.firstElementChild) timelineDiv.appendChild(wrapper.firstElementChild);
            });
            tools.appendChild(timelineDiv);
            stack.appendChild(tools);
        }

        if (specialSteps.length > 0) {
            const special = document.createElement('div');
            special.className = 'process-specials';
            specialSteps.forEach((s: any) => {
                const el = document.createElement('div');
                const icon = s.type === 'error' ? svgIconNoMargin('x') : s.type === 'validation' ? svgIconNoMargin('check') : s.type === 'compaction' ? svgIconNoMargin('gear') : '·';
                el.className = `special-step ${s.type}`;
                el.innerHTML = icon + ' ' + escapeHtml(s.content || '');
                special.appendChild(el);
            });
            stack.appendChild(special);
        }

        panel.appendChild(stack);
        return panel;
    }

    // ── OpenCode-style: build complete assistant message DOM ────────────────────
    //   Structure (matches OpenCode's message anatomy):
    //   1. [Thinking block]  — extended reasoning, collapsible, at the top
    //   2. [Tool calls block] — list of tool-pair rows (call + result)
    //   3. [Text response]   — the final markdown answer

    function buildAssistantMessage(content: string, steps: any[], msgTime: number | null, isSubagentView = false) {
        const div = document.createElement('div');
        div.className = 'message assistant';

        // ── Header row ──
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" class="ai-star"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg>' +
            '<span class="msg-role">CWTools AI</span>' +
            '<span class="msg-time">' + (msgTime || '') + '</span>';
        div.appendChild(hdr);
        if (steps && steps.length > 0 && !isSubagentView) {
            const summaryWrap = document.createElement('div');
            summaryWrap.innerHTML = renderRunSummaryHtml(makeRunSummary(steps, content), false);
            div.appendChild(summaryWrap.firstElementChild || summaryWrap);
        }

        let hadTextDelta = false;
        let streamedText = '';
        const subAgentGroups = new Map<string, any[]>();
        const mainSteps: any[] = [];

        if (steps && steps.length > 0) {
            // Detach the steps belonging to the subagent
            for (const step of steps) {
                if (step.agentId) {
                    let group = subAgentGroups.get(step.agentId);
                    if (!group) {
                        group = [];
                        subAgentGroups.set(step.agentId, group);
                    }
                    const stepCopy = { ...step };
                    delete stepCopy.agentId;
                    if (stepCopy.content && stepCopy.content.startsWith(`[${step.agentId}] `)) {
                        stepCopy.content = stepCopy.content.substring(step.agentId.length + 3);
                    }
                    group.push(stepCopy);
                } else {
                    mainSteps.push(step);
                }
            }

            const sorted = [...mainSteps].sort((a: any, b: any) => (a.timestamp || 0) - (b.timestamp || 0));
            const processPanel = buildProcessPanel(sorted);
            if (processPanel) div.appendChild(processPanel);
            hadTextDelta = sorted.some((s: any) => s.type === 'text_delta');
            streamedText = sorted.filter((s: any) => s.type === 'text_delta').map((s: any) => s.content || '').join('').trim();
        }

        // Final text response — only render if no text_delta steps were rendered inline
        // (otherwise content is a duplicate of what text_delta already streamed)
        let finalText = (content || '').trim();
        if (hadTextDelta && streamedText) {
            if (finalText === streamedText) {
                finalText = '';
            } else if (finalText.startsWith(streamedText)) {
                finalText = finalText.slice(streamedText.length).trim();
            }
        }

        // Final text response: hide exact streamed duplicates, but keep host-added
        // plan/clarification text that is appended after streaming completes.
        if (finalText) {
            const b = document.createElement('div');
            b.className = 'msg-bubble';
            b.innerHTML = renderMarkdown(finalText);
            div.appendChild(b);
        }

        // Recursively render all sub-Agent independent boxes to prevent merging with the main dialogue flow
        for (const [agentId, groupSteps] of subAgentGroups.entries()) {
            // Use a fixed uniqueId to prevent the active state from being lost during re-rendering
            const uniqueId = `subview-${agentId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${msgTime || 'sub'}`;
            const agentSummary = makeRunSummary(groupSteps);
            const agentStatusClass = agentSummary.errorCount + agentSummary.failedToolCount > 0 ? 'lane-failed' : 'lane-done';
            const agentFiles = agentSummary.changedFiles.length > 0 ? ` · ${agentSummary.changedFiles.length} 文件` : '';
            const agentDuration = agentSummary.durationMs > 0 ? formatDuration(agentSummary.durationMs) : '短任务';
            const agentTopTool = agentSummary.topTools[0]?.name || '无工具';
            
            const card = document.createElement('div');
            card.className = `orch-lane ${agentStatusClass} subagent-card`;
            card.dataset.targetId = uniqueId;
            card.innerHTML = `
                <div class="lane-header">
                    <span class="lane-icon">${svgIconNoMargin('bot')}</span>
                    <span class="lane-role">子任务: ${escapeHtml(agentId)}</span>
                    <span class="lane-status" style="margin-left:auto;">›</span>
                </div>
                <div class="lane-status-text">${agentSummary.toolCallCount} 工具${agentFiles}${agentSummary.failedToolCount ? ` · ${agentSummary.failedToolCount} 失败` : ''}</div>
                <div class="lane-meta">
                    <span>${escapeHtml(agentDuration)}</span>
                    <span>${escapeHtml(agentTopTool)}</span>
                    ${agentSummary.readCount ? `<span>${agentSummary.readCount} 读取</span>` : ''}
                    ${agentSummary.writeCount ? `<span>${agentSummary.writeCount} 写入</span>` : ''}
                </div>
            `;
            div.appendChild(card);
            
            const fullscreen = document.createElement('div');
            fullscreen.id = uniqueId;
            fullscreen.className = 'subagent-fullscreen-view';
            fullscreen.innerHTML = `
                <div class="subagent-header">
                    <button class="subagent-back-btn" data-target-id="${uniqueId}">‹ 返回</button>
                    <div class="subagent-title-wrap">
                        <span class="subagent-title">子代理: ${escapeHtml(agentId)}</span>
                        <span class="subagent-subtitle">${escapeHtml(agentSummary.latestStatus)}</span>
                    </div>
                    <div class="subagent-header-metrics">
                        <span>${escapeHtml(agentDuration)}</span>
                        <span>${agentSummary.toolCallCount} 工具</span>
                    </div>
                </div>
                <div class="subagent-body"></div>
            `;
            bindSubagentScroll(fullscreen);
            
            // Recursively render the content of the sub-Agent without msgTime to avoid multiple timestamps
            const innerMsg = buildAssistantMessage('', groupSteps, null, true);
            fullscreen.querySelector('.subagent-body')!.appendChild(innerMsg);
            
            div.appendChild(fullscreen);
        }

        // Batch 3: Enhance rendered content
        setMessageAria(div, 'assistant');
        enhanceCodeBlocks(div);
        enhanceTaskLists(div);
        observeMessage(div);

        return div;
    }

    // ── Global Drill-Down Functions ───────────────────────────────────────────
    function clearActiveSubagentViews(): void {
        document.querySelectorAll('.subagent-fullscreen-view.active').forEach(el => {
            el.classList.remove('active');
        });
        document.body.classList.remove('has-active-subagent');
    }

    function removeLiveAssistantViews(): void {
        document.querySelectorAll('.message.assistant.live-msg').forEach(el => el.remove());
        currentAssistantDiv = null;
        streamStates.clear();
    }

    (window as any).openSubagentView = (id: string) => {
        const el = document.getElementById(id);
        if (el) {
            document.querySelectorAll('.subagent-fullscreen-view.active').forEach(active => {
                if (active !== el) active.classList.remove('active');
            });
            el.classList.add('active');
            bindSubagentScroll(el);
            scrollSubagentBottom(el);
            document.body.classList.add('has-active-subagent');
        }
    };
    (window as any).closeSubagentView = (id: string) => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('active');
            if (!document.querySelector('.subagent-fullscreen-view.active')) {
                document.body.classList.remove('has-active-subagent');
            }
        }
    };

    // ── Live thinking/tool state builders ─────────────────────────────────────
    // We maintain a structured state for the live (streaming) assistant message.
    interface AgentStreamState {
        livePhase: string | null;
        liveSummary: HTMLElement | null;
        liveProcessPanel: HTMLDetailsElement | null;
        liveProcessBody: HTMLElement | null;
        liveTextProcessBody: HTMLElement | null;
        liveThinkBlock: HTMLElement | null;
        liveThinkBody: HTMLElement | null;
        liveThinkSum: HTMLElement | null;
        liveToolTimeline: HTMLElement | null;
        liveTextBubble: HTMLDivElement | null;
        liveTextContent: string;
        liveThinkContent: string;
        liveSteps: any[];
        container: HTMLElement | null;
        /** Store the uniqueId of the fullscreen container, used to find the corresponding card when subtask_complete */
        fullscreenId: string | null;
        startedAt: number;
        lastStepAt: number;
        completedAt: number | null;
        isComplete: boolean;
        lastSummaryRenderAt: number;
        pendingThinkingRender: boolean;
        pendingTextRender: boolean;
        lastSpecialKey: string | null;
        lastSpecialElement: HTMLElement | null;
    }
    const streamStates = new Map<string, AgentStreamState>();
    let subagentTicker: ReturnType<typeof setInterval> | null = null;
    const LIVE_RENDER_MAX_CHARS = 16000;
    const LIVE_SPECIAL_MAX_ITEMS = 18;

    function clipLiveMarkdownContent(content: string): string {
        if (content.length <= LIVE_RENDER_MAX_CHARS) return content;
        const head = content.substring(0, 5000);
        const tail = content.substring(content.length - 10000);
        const hidden = Math.max(0, content.length - head.length - tail.length);
        return `${head}\n\n...\n\n[${hidden} chars hidden while streaming]\n\n...\n\n${tail}`;
    }

    function liveStepCoalesceKey(step: any): string | null {
        if (!step || step.type !== 'orchestrator_progress') return null;
        const content = String(step.content || '').replace(/\(\d+s\)/g, '(...)').trim();
        if (!content) return null;
        if (/waiting|等待模型返回/i.test(content)) return `${step.agentId || '__main__'}:wait-model`;
        return `${step.agentId || '__main__'}:progress:${content}`;
    }

    function coalesceLiveStep(state: AgentStreamState, step: any): boolean {
        const key = liveStepCoalesceKey(step);
        if (!key || state.liveSteps.length === 0) return false;
        const last = state.liveSteps[state.liveSteps.length - 1];
        if (liveStepCoalesceKey(last) !== key) return false;
        state.liveSteps[state.liveSteps.length - 1] = step;
        return true;
    }

    function getStreamState(agentId: string | undefined): AgentStreamState {
        const key = agentId || '__main__';
        let state = streamStates.get(key);
        if (!state) {
            state = {
                livePhase: null,
                liveSummary: !agentId && currentAssistantDiv ? currentAssistantDiv.querySelector(':scope > .live-run-summary-anchor') as HTMLElement | null : null,
                liveProcessPanel: null,
                liveProcessBody: null,
                liveTextProcessBody: null,
                liveThinkBlock: null,
                liveThinkBody: null,
                liveThinkSum: null,
                liveToolTimeline: null,
                liveTextBubble: null,
                liveTextContent: '',
                liveThinkContent: '',
                liveSteps: [],
                container: currentAssistantDiv,
                fullscreenId: null,
                startedAt: Date.now(),
                lastStepAt: Date.now(),
                completedAt: null,
                isComplete: false,
                lastSummaryRenderAt: 0,
                pendingThinkingRender: false,
                pendingTextRender: false,
                lastSpecialKey: null,
                lastSpecialElement: null,
            };
            if (agentId && currentAssistantDiv) {
                const uniqueId = `live-subview-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                state.fullscreenId = uniqueId;

                // Card representation in the main timeline
                const card = document.createElement('div');
                card.className = 'orch-lane lane-running subagent-card';
                card.innerHTML = buildSubagentCardHtml(agentId, uniqueId, chatI18n);
                card.dataset.targetId = uniqueId;
                currentAssistantDiv.appendChild(card);

                // Hidden fullscreen container
                const fullscreen = document.createElement('div');
                fullscreen.id = uniqueId;
                fullscreen.className = 'subagent-fullscreen-view';
                fullscreen.innerHTML = buildSubagentFullscreenHtml(agentId, uniqueId, chatI18n);
                bindSubagentScroll(fullscreen);
                currentAssistantDiv.appendChild(fullscreen);
                
                state.container = fullscreen.querySelector('.subagent-body') as HTMLElement;
                ensureSubagentTicker();
            }
            streamStates.set(key, state);
        }
        return state;
    }

    function updateSubagentCard(state: AgentStreamState, finalText?: string) {
        if (!state.fullscreenId) return;
        const card = document.querySelector(`.subagent-card[data-target-id="${state.fullscreenId}"]`) as HTMLElement | null;
        if (!card) return;

        const now = Date.now();
        const summary = makeRunSummary(state.liveSteps, finalText);
        const idleMs = state.isComplete ? 0 : now - state.lastStepAt;
        const toolName = latestLiveToolName(state.liveSteps, chatI18n.live.waitingForOutput);
        const isBlocked = /澄清|clarification|blocked/i.test(finalText || summary.latestStatus || '');
        const hasProblem = isBlocked || summary.errorCount > 0 || summary.failedToolCount > 0 || /失败|错误|超时|中止|fail|error|timeout/i.test(finalText || '');

        card.classList.remove('lane-running', 'lane-done', 'lane-failed', 'lane-stalled', 'lane-blocked');
        if (!state.isComplete) {
            card.classList.add('lane-running');
            if (idleMs >= 2 * 60 * 1000) card.classList.add('lane-stalled');
        } else if (isBlocked) {
            card.classList.add('lane-blocked');
        } else {
            card.classList.add(hasProblem ? 'lane-failed' : 'lane-done');
        }

        const statusText = card.querySelector('.lane-status-text') as HTMLElement | null;
        if (statusText) {
            const livePrefix = state.isComplete
                ? (finalText || summary.latestStatus || '完成')
                : idleMs >= 2 * 60 * 1000
                    ? `等待 ${formatDuration(idleMs)} · ${summary.latestStatus}`
                    : summary.latestStatus;
            statusText.textContent = livePrefix.length > 100 ? livePrefix.slice(0, 100) + '...' : livePrefix;
        }

        const meta = card.querySelector('.lane-live-meta') as HTMLElement | null;
        if (meta) {
            meta.innerHTML = buildSubagentMetaHtml(state, summary, toolName, now, chatI18n);
        }

        const fullscreen = document.getElementById(state.fullscreenId);
        if (fullscreen) {
            const subtitle = fullscreen.querySelector('.subagent-subtitle') as HTMLElement | null;
            if (subtitle) subtitle.textContent = summary.latestStatus;
            const metrics = fullscreen.querySelector('.subagent-header-metrics') as HTMLElement | null;
            if (metrics) {
                metrics.innerHTML = buildSubagentHeaderMetricsHtml(state, summary, now, chatI18n);
            }
        }
    }

    function ensureSubagentTicker() {
        if (subagentTicker) return;
        subagentTicker = setInterval(() => {
            let activeCount = 0;
            for (const [key, state] of streamStates.entries()) {
                if (key !== '__main__') {
                    if (!state.isComplete) {
                        activeCount++;
                        updateSubagentCard(state);
                    }
                }
            }
            // 💡 Performance Optimization: If no active subagents are currently running,
            // tear down the interval ticker to release main thread CPU cycles.
            if (activeCount === 0 && subagentTicker) {
                clearInterval(subagentTicker);
                subagentTicker = null;
            }
        }, 5000);
    }

    function ensureLiveProcessPanel(state: AgentStreamState) {
        if (!state.container) return null;
        if (!state.liveProcessPanel) {
            state.liveProcessPanel = document.createElement('details');
            state.liveProcessPanel.className = 'agent-process-panel live-process-panel';
            state.liveProcessPanel.open = true;
            const summary = document.createElement('summary');
            summary.innerHTML = buildLiveProcessSummaryHtml('layers', chatI18n.live.realtimeProcess, '');
            state.liveProcessPanel.appendChild(summary);
            state.liveProcessBody = document.createElement('div');
            state.liveProcessBody.className = 'process-stack live-process-stack';
            state.liveProcessPanel.appendChild(state.liveProcessBody);
            if (state.liveSummary && state.liveSummary.nextSibling) {
                state.container.insertBefore(state.liveProcessPanel, state.liveSummary.nextSibling);
            } else {
                state.container.appendChild(state.liveProcessPanel);
            }
        }
        const meta = state.liveProcessPanel.querySelector(':scope > summary .process-meta');
        if (meta) meta.textContent = buildLiveProcessMeta(state.liveSteps, chatI18n);
        return state.liveProcessBody;
    }

    function ensureLiveSummary(state: AgentStreamState, step?: any, coalesced = false) {
        if (!state.container) return;
        if (step && !coalesced) state.liveSteps.push(step);
        if (!state.liveSummary) {
            state.liveSummary = document.createElement('div');
            state.liveSummary.className = 'live-run-summary-anchor';
            state.container.prepend(state.liveSummary);
        }
        const now = Date.now();
        const noisy = step && (step.type === 'text_delta' || step.type === 'thinking_content' || step.type === 'orchestrator_progress');
        if (noisy && now - state.lastSummaryRenderAt < 800) return;
        state.lastSummaryRenderAt = now;
        state.liveSummary.innerHTML = renderRunSummaryHtml(makeRunSummary(state.liveSteps), true);
    }

    function initLiveAssistantDiv() {
        const div = document.createElement('div');
        div.className = 'message assistant live-msg';
        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" class="ai-star"><path fill="#e8c840" d="M8 1L9.2 6.8 15 8l-5.8 1.2L8 15l-1.2-5.8L1 8l5.8-1.2z"/><circle fill="#e8c840" cx="13" cy="3" r="1"/></svg>' +
            '<span class="msg-role">CWTools AI</span>';
        div.appendChild(hdr);
        const summary = document.createElement('div');
        summary.className = 'live-run-summary-anchor';
        summary.innerHTML = renderRunSummaryHtml(makeRunSummary([], '准备中'), true);
        div.appendChild(summary);

        return div;
    }

    function flushLiveText(state: AgentStreamState) {
        if (state.liveTextBubble) {
            state.liveTextBubble.classList.remove('stream-cursor');
            state.liveTextBubble.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveTextContent));
        }
        if (state.liveTextProcessBody) {
            state.liveTextProcessBody.classList.remove('stream-cursor');
            state.liveTextProcessBody.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveTextContent));
        }
        state.liveTextBubble = null;
        state.liveTextProcessBody = null;
        state.liveTextContent = '';
    }

    function scheduleThinkingRender(state: AgentStreamState) {
        if (state.pendingThinkingRender) return;
        state.pendingThinkingRender = true;
        requestAnimationFrame(() => {
            state.pendingThinkingRender = false;
            if (state.liveThinkBody) {
                state.liveThinkBody.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveThinkContent));
            }
            if (state.liveThinkSum) {
                state.liveThinkSum.innerHTML = buildThinkingSummaryHtml(state.liveThinkContent, chatI18n);
            }
            scrollBottom();
        });
    }

    function finishLiveThinking(state: AgentStreamState) {
        if (!state.liveThinkBlock) return;

        const content = state.liveThinkContent.trim();
        if (!content) {
            state.liveThinkBlock.remove();
        } else {
            if (state.liveThinkBody) {
                state.liveThinkBody.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveThinkContent));
            }
            if (state.liveThinkSum) {
                state.liveThinkSum.innerHTML = buildThinkingSummaryHtml(state.liveThinkContent, chatI18n);
            }
            const pulse = state.liveThinkBlock.querySelector('.think-pulse');
            if (pulse) pulse.classList.remove('spinning');
        }

        state.liveThinkBlock = null;
        state.liveThinkBody = null;
        state.liveThinkSum = null;
        state.liveThinkContent = '';
    }

    function scheduleTextRender(state: AgentStreamState) {
        if (state.pendingTextRender) return;
        state.pendingTextRender = true;
        requestAnimationFrame(() => {
            state.pendingTextRender = false;
            if (state.liveTextProcessBody) {
                state.liveTextProcessBody.innerHTML = renderMarkdown(clipLiveMarkdownContent(state.liveTextContent));
            }
            scrollBottom();
        });
    }

    function createToolPairElement(html: string): HTMLElement | null {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = html;
        return wrapper.firstElementChild as HTMLElement | null;
    }

    function applyLiveStep(s: any) {
        if (!currentAssistantDiv) return;

        const state = getStreamState(s.agentId);
        if ((s.type === 'thinking' || s.type === 'thinking_content') && !state.liveThinkBlock && !hasVisibleLiveContent(s)) {
            if (s.transactionCard && s.transactionCard.status === 'pending') {
                showTransactionCard(s.transactionCard);
            }
            return;
        }
        const coalesced = coalesceLiveStep(state, s);
        ensureLiveSummary(state, s, coalesced);
        state.lastStepAt = Date.now();
        updateSubagentCard(state);

        if (s.type === 'subtask_complete') {
            state.isComplete = true;
            state.completedAt = Date.now();
            if (state.liveSummary) {
                state.liveSummary.innerHTML = renderRunSummaryHtml(makeRunSummary(state.liveSteps, s.content), false);
            }
            // Find card using explicitly stored fullscreenId (fix: state.container points to .subagent-body, no id)
            if (state.fullscreenId) {
                const card = document.querySelector(`.subagent-card[data-target-id="${state.fullscreenId}"]`);
                if (card) {
                    card.classList.remove('lane-running');
                    const blocked = /澄清|clarification|blocked/i.test(s.content || '');
                    const failed = blocked || /fail|error|失败|错误|超时|中止/i.test(s.content || '');
                    card.classList.add(blocked ? 'lane-blocked' : failed ? 'lane-failed' : 'lane-done');
                    const statusText = card.querySelector('.lane-status-text');
                    if (statusText) statusText.textContent = s.content || '完成';
                }
            }
            updateSubagentCard(state, s.content || '完成');
            // Terminate all active streaming states - the child agent has completed and there will be no new steps
            // 1. Terminate the Thinking block: stop the spinning indicator
            if (state.liveThinkBlock) {
                finishLiveThinking(state);
            }
            // 2. End text bubble
            if (state.liveTextBubble) flushLiveText(state);
            // 3. Clean tool timeline references
            state.liveToolTimeline = null;
            state.livePhase = null;
            return;
        }

        const target = routeLiveStep(s);

        // Determine the new phase
        const newPhase = target === 'thinking' ? 'thinking' : target === 'text_bubble' ? 'text' : target === 'tool_call' ? 'tool' : target === 'tool_result' ? 'tool' : 'special';

        // ── Phase transition: finalize current container and start new one ──
        if (newPhase !== 'special' && newPhase !== state.livePhase && target !== 'tool_result') {
            // Finalize previous text bubble if transitioning away from text
            if (state.livePhase === 'text' && state.liveTextBubble) {
                flushLiveText(state);
            }
            // Finalize previous thinking block if transitioning away from thinking
            if (state.livePhase === 'thinking' && state.liveThinkBlock) {
                finishLiveThinking(state);
            }
            // Clear tool timeline ref if transitioning away from tool
            if (state.livePhase === 'tool' && newPhase !== 'tool') {
                state.liveToolTimeline = null;
            }
            state.livePhase = newPhase;
        }

        // ── Thinking: create or reuse a thinking block at current position ──
        if (target === 'thinking') {
            const processBody = ensureLiveProcessPanel(state);
            if (!state.liveThinkBlock) {
                state.liveThinkBlock = document.createElement('details');
                state.liveThinkBlock.className = 'process-section process-thinking live-thinking-block'; (state.liveThinkBlock as HTMLDetailsElement).open = false;
                state.liveThinkSum = document.createElement('summary');
                state.liveThinkSum.innerHTML = '<span class="think-pulse spinning"></span>思考详情...';
                state.liveThinkBlock.appendChild(state.liveThinkSum);
                state.liveThinkBody = document.createElement('div');
                state.liveThinkBody.className = 'thinking-body markdown-body';
                state.liveThinkBlock.appendChild(state.liveThinkBody);
                processBody?.appendChild(state.liveThinkBlock);
            }
            if (state.liveThinkBody) {
                if (s.type === 'thinking' && state.liveThinkContent) {
                    state.liveThinkContent += '\n\n---\n\n' + (s.content || '');
                } else {
                    state.liveThinkContent += (s.content || '');
                }
                scheduleThinkingRender(state);
            }
            if (s.transactionCard && s.transactionCard.status === 'pending') {
                showTransactionCard(s.transactionCard);
            }
            return;
        }

        // ── text_delta: create or reuse a text bubble at current position ──
        if (target === 'text_bubble') {
            const processBody = ensureLiveProcessPanel(state);
            if (!state.liveTextProcessBody && processBody) {
                const section = document.createElement('details');
                section.className = 'process-section process-text live-process-text';
                section.open = false;
                const summary = document.createElement('summary');
                summary.innerHTML = buildLiveProcessSummaryHtml('file', '过程文本', 'streaming');
                section.appendChild(summary);
                state.liveTextProcessBody = document.createElement('div');
                state.liveTextProcessBody.className = 'thinking-body process-text-body markdown-body stream-cursor';
                section.appendChild(state.liveTextProcessBody);
                processBody.appendChild(section);
            }
            if (state.liveTextProcessBody) {
                state.liveTextContent += (s.content || '');
                scheduleTextRender(state);
            }
            if (s.transactionCard && s.transactionCard.status === 'pending') {
                showTransactionCard(s.transactionCard);
            }
            return;
        }

        // ── tool_call: create or reuse a tool timeline at current position ──
        if (target === 'tool_call') {
            const processBody = ensureLiveProcessPanel(state);
            if (!state.liveToolTimeline) {
                const toolSection = document.createElement('details');
                toolSection.className = 'process-section process-tools live-process-tools';
                toolSection.open = false;
                const summary = document.createElement('summary');
                summary.innerHTML = buildLiveProcessSummaryHtml('gear', '工具详情', '实时调用');
                toolSection.appendChild(summary);
                state.liveToolTimeline = document.createElement('div');
                state.liveToolTimeline.className = 'tool-timeline process-tool-timeline live-tool-timeline';
                toolSection.appendChild(state.liveToolTimeline);
                processBody?.appendChild(toolSection);
            }
            const stepIdx = s.stepIndex || (state.liveToolTimeline.querySelectorAll('.tool-pair').length + 1);
            const toolMeta = state.liveToolTimeline.closest('.process-tools')?.querySelector('.process-meta');
            if (toolMeta) toolMeta.textContent = `${stepIdx} 次调用`;
            const pairDiv = createToolPairElement(buildToolPairHtml(s as RendererStep, undefined, { stepIndex: stepIdx, showDuration: false }));
            if (!pairDiv) return;
            pairDiv.dataset.tool = s.toolName || '';
            pairDiv.dataset.callIdx = String(stepIdx);
            pairDiv.dataset.callTs = String(s.timestamp || Date.now());
            // Store toolArgs so we can recover them when tool_result arrives
            try { pairDiv.dataset.callArgs = JSON.stringify(s.toolArgs || {}); } catch { pairDiv.dataset.callArgs = '{}'; }

            // Auto-collapse: when tool count exceeds threshold, wrap overflow in <details>
            const LIVE_COLLAPSE_THRESHOLD = 1;
            const directPairs = state.liveToolTimeline.querySelectorAll(':scope > .tool-pair');
            if (directPairs.length >= LIVE_COLLAPSE_THRESHOLD) {
                let collapseEl = state.liveToolTimeline.querySelector(':scope > .tool-collapse') as HTMLDetailsElement | null;
                if (!collapseEl) {
                    collapseEl = document.createElement('details');
                    collapseEl.className = 'tool-collapse';
                    const sum = document.createElement('summary');
                    collapseEl.appendChild(sum);
                    state.liveToolTimeline.appendChild(collapseEl);
                    // Track user manual open — respect their intent
                    collapseEl.addEventListener('toggle', () => {
                        if ((collapseEl as HTMLDetailsElement).open) {
                            (collapseEl as HTMLElement).dataset.userOpened = '1';
                        }
                    });
                }
                // Move the 2nd+ direct pairs into the collapse
                const toMove = Array.from(state.liveToolTimeline.querySelectorAll(':scope > .tool-pair')).slice(1);
                for (const m of toMove) collapseEl.appendChild(m);
                // Append new pair into collapse too
                collapseEl.appendChild(pairDiv);
                const insideCount = collapseEl.querySelectorAll('.tool-pair').length;
                (collapseEl.querySelector('summary') as HTMLElement).textContent = `+${insideCount} more tool calls`;
                // Default collapsed — only auto-open if the user has manually opened it
                if ((collapseEl as HTMLElement).dataset.userOpened) {
                    collapseEl.open = true;
                }
            } else {
                state.liveToolTimeline.appendChild(pairDiv);
            }
        } else if (target === 'tool_result') {
            // Find the most recent unresolved tool pair within the current agent view.
            const searchRoot = state.container || currentAssistantDiv;
            const allTimelines = searchRoot.querySelectorAll('.tool-timeline');
            for (let i = allTimelines.length - 1; i >= 0; i--) {
                const tl = allTimelines[i]!;
                const pairs = Array.from(tl.querySelectorAll('.tool-pair[data-tool="' + s.toolName + '"]:not([data-resolved])'));
                if (pairs.length > 0) {
                    const pair = pairs[0] as HTMLElement;
                    pair.dataset.resolved = '1';
                    const callTs = parseInt(pair.dataset.callTs || '0', 10);
                    const stepIdx = parseInt(pair.dataset.callIdx || '0', 10);
                    // Recover original toolArgs from stored data
                    let recoveredArgs: Record<string, unknown> = {};
                    try { recoveredArgs = JSON.parse(pair.dataset.callArgs || '{}'); } catch { /* ignore */ }
                    const fakeCall: RendererStep = { type: 'tool_call', toolName: s.toolName, toolArgs: recoveredArgs, content: '', timestamp: callTs };
                    const updatedPair = createToolPairElement(buildToolPairHtml(fakeCall, s as RendererStep, {
                        stepIndex: stepIdx,
                        showDuration: true,
                        showDiff: true,
                    }));
                    if (updatedPair) {
                        pair.className = updatedPair.className;
                        pair.innerHTML = updatedPair.innerHTML;
                    }
                    break;
                }
            }
        } else if (target === 'special') {
            const processBody = ensureLiveProcessPanel(state);
            const specialKey = liveStepCoalesceKey(s);
            const el = document.createElement('div');
            // Add step type as additional CSS class name (consistent with finalized renderer)
            el.className = `special-step ${s.type}`;
            const icon = s.type === 'error' ? svgIconNoMargin('x')
                : s.type === 'validation' ? svgIconNoMargin('check')
                : s.type === 'orchestrator_progress' ? svgIconNoMargin('chart')
                : svgIconNoMargin('gear');
            // Replace $(iconName) codicon placeholder with SVG icon
            let safeContent = escapeHtml(s.content || '');
            safeContent = safeContent.replace(/\$\(([\w-]+)\)/g, (_match: string, iconName: string) => {
                if (iconName in Icons) {
                    return svgIconNoMargin(iconName as keyof typeof Icons);
                }
                return _match;
            });
            const nextHtml = icon + ' ' + safeContent;
            if (specialKey && state.lastSpecialKey === specialKey && state.lastSpecialElement?.isConnected) {
                state.lastSpecialElement.innerHTML = nextHtml;
            } else {
                el.innerHTML = nextHtml;
                processBody?.appendChild(el);
                state.lastSpecialKey = specialKey;
                state.lastSpecialElement = el;
                const specialItems = processBody ? Array.from(processBody.querySelectorAll(':scope > .special-step')) as HTMLElement[] : [];
                const overflow = specialItems.length - LIVE_SPECIAL_MAX_ITEMS;
                if (overflow > 0) {
                    for (const item of specialItems.slice(0, overflow)) item.remove();
                }
            }
        }
        scrollBottom();
    }

    // ── Phase 5: Event delegation for inline permission buttons in tool timeline ──
    chatArea.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('.tp-perm-btn') as HTMLElement | null;
        if (!btn) return;
        const permId = btn.dataset.perm;
        const action = btn.dataset.action;
        if (!permId || !action) return;
        floatingPermissionIds.delete(permId);
        document.querySelectorAll('.permission-card[data-perm-id]').forEach(el => {
            if ((el as HTMLElement).dataset.permId === permId) dismissCard(el as HTMLElement, 0);
        });

        // Disable all sibling buttons
        const parent = btn.closest('.tp-perm-actions');
        if (parent) {
            parent.querySelectorAll('.tp-perm-btn').forEach(b => {
                (b as HTMLButtonElement).disabled = true;
                (b as HTMLElement).style.opacity = '0.4';
            });
        }

        if (action === 'allow') {
            btn.textContent = '✓ 已允许';
            vscode.postMessage({ type: 'permissionResponse', permissionId: permId, allowed: true });
        } else if (action === 'deny') {
            btn.textContent = '✗ 已拒绝';
            vscode.postMessage({ type: 'permissionResponse', permissionId: permId, allowed: false });
        } else if (action === 'always') {
            btn.textContent = '✓ 已一直允许';
            vscode.postMessage({ type: 'permissionResponse', permissionId: permId, allowed: true, alwaysAllow: true });
        }
    });

    // Subagent drill-down view navigation via event delegation
    chatArea.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const subagentCard = target.closest('.subagent-card') as HTMLElement | null;
        if (subagentCard) {
            const uniqueId = subagentCard.dataset.targetId;
            if (uniqueId) {
                (window as any).openSubagentView(uniqueId);
                return;
            }
        }
        
        const backBtn = target.closest('.subagent-back-btn') as HTMLElement | null;
        if (backBtn) {
            const uniqueId = backBtn.dataset.targetId;
            if (uniqueId) {
                (window as any).closeSubagentView(uniqueId);
                return;
            }
        }
    });

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

    function buildContextChipRow(contexts?: ActiveContext[]) {
        if (!contexts || contexts.length === 0) return null;
        const chipsContainer = document.createElement('div');
        chipsContainer.className = 'message-reference-row';
        for (const ctx of contexts) {
            const meta = CONTEXT_TYPE_META[ctx.type] || CONTEXT_TYPE_META.file;
            const range = typeof ctx.startLine === 'number' && typeof ctx.endLine === 'number'
                ? ` #L${ctx.startLine}-${ctx.endLine}`
                : typeof ctx.line === 'number'
                    ? ` #L${ctx.line + 1}`
                    : '';
            const title = ctx.description || ctx.uri || ctx.label;
            const metaBits = [
                typeof ctx.tokenEstimate === 'number' && ctx.tokenEstimate > 0 ? `~${formatNum(ctx.tokenEstimate)} tok` : '',
                ctx.cacheStatus ? ctx.cacheStatus : '',
            ].filter(Boolean).join(' · ');
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = `reference-chip ref-${ctx.type} ref-clickable`;
            chip.title = title;
            chip.innerHTML = `
                ${svgIconNoMargin(meta.icon)}
                <span class="ref-kind">${escapeHtml(meta.label)}</span>
                <span class="ref-text">${escapeHtml(ctx.label)}${range}</span>
                ${metaBits ? `<span class="ref-meta">${escapeHtml(metaBits)}</span>` : ''}
            `;
            chip.addEventListener('click', () => {
                vscode.postMessage({ type: 'openContextReference', context: ctx });
            });
            chipsContainer.appendChild(chip);
        }
        return chipsContainer;
    }

    function addUserMessage(text: string, msgIdx: number, images?: string[], contexts?: ActiveContext[]) {
        emptyState.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'message user';
        if (msgIdx !== undefined && msgIdx >= 0) div.dataset.msgIndex = String(msgIdx);

        const hdr = document.createElement('div');
        hdr.className = 'msg-header';
        hdr.innerHTML = '<span class="msg-role user-role">You</span><span class="msg-time">' + formatTime(Date.now()) + '</span>';

        const bubble = document.createElement('div');
        bubble.className = 'msg-bubble user-bubble';

        const structuredChips = buildContextChipRow(contexts);
        if (structuredChips) bubble.appendChild(structuredChips);
        
        // Parse Prompt template with code reference and convert it into UI chip (supports multiple references)
        const refRegex = /文件 `([^`]+)` 第 (\d+-\d+) 行[^\n]*：\n```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```/g;
        
        let remainingText = text;
        let match;
        const chipsContainer = document.createElement('div');
        chipsContainer.style.display = 'flex';
        chipsContainer.style.flexWrap = 'wrap';
        chipsContainer.style.gap = '4px';
        chipsContainer.style.marginBottom = '6px';
        let foundAny = false;

        while ((match = refRegex.exec(text)) !== null) {
            foundAny = true;
            const file = match[1] || '';
            const lines = match[2] || '';
            const fileName = file.split(/[\\/]/).pop() || file;
            
            const chip = document.createElement('div');
            chip.className = 'reference-chip';
            chip.style.background = 'rgba(100, 120, 255, 0.08)';
            chip.innerHTML = `<span class="ref-text" title="${escapeHtml(file)}">${escapeHtml(fileName)} #L${lines}</span>`;
            chipsContainer.appendChild(chip);
            
            remainingText = remainingText.replace(match[0], '');
        }

        if (foundAny) bubble.appendChild(chipsContainer);

        const textToShow = remainingText.trim();
        if (textToShow) {
            const textNode = document.createElement('div');
            textNode.style.whiteSpace = 'pre-wrap';
            textNode.textContent = textToShow;
            bubble.appendChild(textNode);
        } else if (!structuredChips && !foundAny) {
            bubble.textContent = text;
        }

        // M6 fix: display image thumbnails from the actual images array
        const imgRow = buildImageRow(images || []);
        if (imgRow) bubble.appendChild(imgRow);

        div.appendChild(hdr);
        div.appendChild(bubble);

        if (msgIdx !== undefined && msgIdx >= 0) {
            userMessagePayloadMap.set(msgIdx, cloneInputPayload({ text, images, contexts }));

            const actions = document.createElement('div');
            actions.className = 'message-actions user-message-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'message-action-btn edit-resend-btn';
            editBtn.type = 'button';
            editBtn.title = '编辑并重新发送';
            editBtn.setAttribute('aria-label', '编辑并重新发送此消息');
            editBtn.innerHTML = `${svgIconNoMargin('pencil')}<span>编辑重发</span>`;
            editBtn.addEventListener('click', () => beginEditMessage(msgIdx));

            const rb = document.createElement('button');
            rb.className = 'message-action-btn retract-btn';
            rb.type = 'button';
            rb.title = '回滚到此处';
            rb.setAttribute('aria-label', '回滚到此消息之前并恢复输入');
            rb.innerHTML = `${svgIconNoMargin('refresh')}<span>回滚</span>`;
            rb.addEventListener('click', () => showRetractConfirm(msgIdx));

            actions.appendChild(editBtn);
            actions.appendChild(rb);
            div.appendChild(actions);
            messageIndexMap.set(msgIdx, div);
        }
        // Batch 3: ARIA and virtual scroll
        setMessageAria(div, 'user');
        observeMessage(div);
        chatArea.appendChild(div);
        scrollBottom(true);
        return div;
    }

    function showRetractConfirm(messageIdx: number) {
        if (isGenerating) return;
        const payload = userMessagePayloadMap.get(messageIdx);
        const imageCount = payload?.images?.length || 0;
        const contextCount = payload?.contexts?.length || 0;
        const overlay = document.createElement('div');
        overlay.className = 'retract-confirm';
        overlay.innerHTML = `
            <div class="retract-confirm-box">
                <div class="retract-confirm-title">回滚到这条消息之前？</div>
                <div class="retract-confirm-hint">
                    <div>将删除这条用户消息以及之后的 AI 回复，并尝试恢复这些回复产生的文件改动。</div>
                    <div>完成后会把原消息放回输入框，包含 ${contextCount} 个引用和 ${imageCount} 张图片。</div>
                    <div class="retract-confirm-note">文件恢复依赖当前会话快照；无法恢复的项目会在完成后提示。</div>
                </div>
                <div class="retract-confirm-btns">
                    <button class="retract-ok" type="button">回滚并恢复输入</button>
                    <button class="retract-cancel" type="button">取消</button>
                </div>
            </div>`;
        overlay.querySelector('.retract-ok')!.addEventListener('click', () => {
            overlay.remove();
            editingMessageIndex = null;
            renderEditComposerState();
            vscode.postMessage({ type: 'retractMessage', messageIndex: messageIdx });
        });
        overlay.querySelector('.retract-cancel')!.addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }
    // ── Card dismiss helper ────────────────────────────────────────────────────
    function dismissCard(el: HTMLElement, delay: number, onComplete?: () => void, removeDom: boolean = true) {
        setTimeout(() => {
            el.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
            el.style.opacity = '0';
            el.style.transform = 'translateY(-4px)';
            setTimeout(() => {
                if (removeDom) {
                    el.remove();
                    forgetResponsiveWorkspaceContent(el);
                } else {
                    el.style.display = 'none';
                    el.style.opacity = '1';
                    el.style.transform = '';
                }
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
            
        const actions = card.querySelector('.diff-card-actions') as HTMLElement | null;
        if (actions) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'diff-preview-btn';
            previewBtn.type = 'button';
            previewBtn.innerHTML = svgIcon('search') + '查看详情';
            previewBtn.style.display = 'none';
            actions.insertBefore(previewBtn, actions.firstChild);
        }
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
        const pendingActions = card.querySelector('.diff-card-actions') as HTMLElement | null;
        if (pendingActions) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'diff-preview-btn';
            previewBtn.type = 'button';
            previewBtn.innerHTML = svgIcon('search') + '查看详情';
            previewBtn.style.display = 'none';
            pendingActions.insertBefore(previewBtn, pendingActions.firstChild);
        }
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
        // Batch transaction cards keep their compact confirmation UI.
    }

    // ── Diff card ──────────────────────────────────────────────────────────────
    function showAutoWriteCard(file: string, isNewFile: boolean) {
        const fileName = (file || '').split(/[\\/]/).pop() || file;
        const wrap = document.createElement('div');
        wrap.className = 'auto-write-row';
        const tag = isNewFile ? '<span class="aw-tag aw-new">NEW</span>' : '<span class="aw-tag aw-mod">MOD</span>';
        wrap.innerHTML = `${svgIconNoMargin('sparkles')} ${tag} <span class="aw-file">${escapeHtml(fileName)}</span>`;
        wrap.title = file;
        chatArea.appendChild(wrap);
        scrollBottom();
    }
    function showPendingWriteCard(file: string, messageId: string, isNewFile: boolean, diff?: Partial<SideDiffFile>) {
        const fileName = (file || '').split(/[\\/]/).pop() || file;
        const div = document.createElement('div');
        const card = document.createElement('div');
        card.className = 'diff-card';
        const safeId = escapeHtml(messageId);
        const diffFile: SideDiffFile = {
            file,
            status: isNewFile ? 'created' : 'modified',
            diffPreview: diff?.diffPreview,
            additions: diff?.additions,
            deletions: diff?.deletions,
            diffLines: diff?.diffLines,
        };
        const openPendingDiff = () => openDiffInSideWorkspace(
            [diffFile],
            isNewFile ? '新建文件' : '文件修改',
            { pending: { messageId, isNewFile } },
        );
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
            removePendingSideDiffEntry(messageId);
            refreshSideDiffWorkspaceAfterRemoval();
            dismissCard(div, 400);
        });
        (card.querySelector('.diff-reject-btn') as HTMLButtonElement).addEventListener('click', function () {
            this.disabled = true; (card.querySelector('.diff-accept-btn') as HTMLButtonElement).disabled = true;
            this.textContent = '已拒绝';
            vscode.postMessage({ type: 'cancelWriteFile', messageId });
            removePendingSideDiffEntry(messageId);
            refreshSideDiffWorkspaceAfterRemoval();
            dismissCard(div, 400);
        });
        const pendingActions = card.querySelector('.diff-card-actions') as HTMLElement | null;
        if (pendingActions) {
            const previewBtn = document.createElement('button');
            previewBtn.className = 'diff-preview-btn';
            previewBtn.type = 'button';
            previewBtn.innerHTML = svgIcon('search') + '查看详情';
            previewBtn.addEventListener('click', openPendingDiff);
            pendingActions.insertBefore(previewBtn, pendingActions.firstChild);
        }
        div.appendChild(card);
        chatArea.appendChild(div);
        scrollBottom();
        if (shouldUseSideWorkspace()) openPendingDiff();
    }

    // ── Floating Card Queue ──────────────────────────────────────────────────
    let floatingCardQueue: HTMLElement[] = [];
    let isShowingFloatingCard = false;
    const floatingPermissionIds = new Set<string>();

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

    function removeQueuedFloatingCards(predicate: (card: HTMLElement) => boolean): void {
        const nextQueue: HTMLElement[] = [];
        for (const card of floatingCardQueue) {
            if (predicate(card)) {
                card.remove();
            } else {
                nextQueue.push(card);
            }
        }
        floatingCardQueue = nextQueue;
    }

    function dismissResolvedCard(card: HTMLElement): void {
        if (card.dataset.resolved === 'true') return;
        card.dataset.resolved = 'true';
        const floatingCardArea = document.getElementById('floatingCardArea');
        const wasVisibleFloatingCard = (!!floatingCardArea && card.parentElement === floatingCardArea)
            || (!floatingCardArea && card.parentElement === chatArea && isShowingFloatingCard);
        dismissCard(card, 0, () => {
            if (wasVisibleFloatingCard) {
                isShowingFloatingCard = false;
                processFloatingCardQueue();
            }
        });
    }

    function cardShell(element: HTMLElement): HTMLElement {
        const parent = element.parentElement as HTMLElement | null;
        if (parent && parent.parentElement === chatArea && parent.childElementCount === 1) return parent;
        return element;
    }

    function disableInlinePermissionActions(permissionId?: string): void {
        document.querySelectorAll('.tp-perm-btn[data-perm]').forEach(btn => {
            const el = btn as HTMLButtonElement;
            if (permissionId && el.dataset.perm !== permissionId) return;
            el.disabled = true;
            el.style.opacity = '0.4';
        });
    }

    function resolveFloatingCard(card: 'permission' | 'write' | 'transaction' | 'plan' | 'walkthrough' | 'blueprint', id?: string): void {
        if (card === 'permission') {
            if (id) floatingPermissionIds.delete(id);
            else floatingPermissionIds.clear();
            removeQueuedFloatingCards(el => el.classList.contains('permission-card') && (!id || el.dataset.permId === id));
            document.querySelectorAll('.permission-card[data-perm-id]').forEach(el => {
                const cardEl = el as HTMLElement;
                if (!id || cardEl.dataset.permId === id) dismissResolvedCard(cardEl);
            });
            disableInlinePermissionActions(id);
            return;
        }

        if (card === 'write') {
            if (id) {
                removePendingSideDiffEntry(id);
                refreshSideDiffWorkspaceAfterRemoval();
            }
            document.querySelectorAll('.diff-card').forEach(el => {
                const cardEl = el as HTMLElement;
                const button = cardEl.querySelector('[data-msgid]') as HTMLElement | null;
                if (!button) return;
                if (!id || button.dataset.msgid === id) dismissResolvedCard(cardShell(cardEl));
            });
            return;
        }

        if (card === 'transaction') {
            document.querySelectorAll('.diff-card').forEach(el => {
                const cardEl = el as HTMLElement;
                const button = cardEl.querySelector('[data-txid]') as HTMLElement | null;
                if (!button) return;
                if (!id || button.dataset.txid === id) dismissResolvedCard(cardShell(cardEl));
            });
            return;
        }

        const className = card === 'plan'
            ? 'plan-card-wrap'
            : card === 'walkthrough'
                ? 'walkthrough-card-wrap'
                : 'blueprint-card-wrap';
        document.querySelectorAll(`.annotatable-plan.${className}`).forEach(el => {
            dismissResolvedCard(el as HTMLElement);
        });
    }

    // ── Permission request card ─────────────────────────────────────────────────
    function showPermissionCard(permissionId: string, tool: string, description: string, command: string, allowAlways?: boolean, preflight?: any) {
        if (!permissionId || floatingPermissionIds.has(permissionId)) return;
        floatingPermissionIds.add(permissionId);
        const div = document.createElement('div');
        div.className = 'permission-card';
        div.dataset.permId = permissionId;
        const safeId = escapeHtml(permissionId);
        
        let actionsHtml = `<div class="permission-card-actions">` +
            `<button class="permission-allow-btn" data-permid="${safeId}">${svgIcon('check')}允许</button>` +
            `<button class="permission-deny-btn" data-permid="${safeId}">${svgIcon('x')}拒绝</button>`;
            
        if (tool === 'run_command' && allowAlways) {
            const isHighRisk = preflight && preflight.riskLevel > 1;
            const labelText = isHighRisk ? '本次对话一直允许' : (preflight && preflight.riskLevel <= 1 ? '一直允许 (只读前缀)' : '一直允许');
            const titleText = isHighRisk ? '当前会话期间一直允许相同类型的高风险指令' : '当前会话期间一直允许相同类型的只读指令';
            actionsHtml += `<button class="permission-always-btn" data-permid="${safeId}" style="margin-left:auto; font-size:0.8em; opacity:0.9" title="${escapeHtml(titleText)}">${svgIcon('check')}${labelText}</button>`;
        }
        actionsHtml += `</div>`;
        
        // Modern Safety Assessment Telemetry panel
        let preflightHtml = '';
        if (preflight) {
            const riskMap: Record<number, { text: string, color: string, bg: string }> = {
                0: { text: '低风险 (Low Risk)', color: '#4caf50', bg: 'rgba(76,175,80,0.1)' },
                1: { text: '中风险 (Medium Risk)', color: '#ff9800', bg: 'rgba(255,152,0,0.1)' },
                2: { text: '高风险 (High Risk / Escalation)', color: '#f44336', bg: 'rgba(244,67,54,0.1)' }
            };
            const risk = riskMap[preflight.riskLevel] || riskMap[1] || { text: '中风险 (Medium Risk)', color: '#ff9800', bg: 'rgba(255,152,0,0.1)' };
            
            const classLabels: Record<string, string> = {
                read: '只读查询',
                write: '写入修改',
                network: '网络访问',
                script: '内联执行',
                destructive: '高危破坏'
            };
            const badges = (preflight.classification || []).map((c: string) => 
                `<span class="preflight-badge" style="background:var(--vscode-badge-background,rgba(128,128,128,0.1)); color:var(--vscode-badge-foreground); padding:2px 6px; border-radius:3px; font-size:10px; font-weight:600; margin-right:4px;">[${classLabels[c] || c}]</span>`
            ).join('');

            const details = (preflight.reasons || []).map((r: string) => 
                `<li style="margin-bottom:2px; font-size:11px; opacity:0.85; text-align:left;">${escapeHtml(r)}</li>`
            ).join('');

            preflightHtml = 
                `<div class="preflight-assessment-panel" style="margin-top:8px; border:1px solid var(--border, rgba(128,128,128,0.2)); border-radius:4px; padding:8px; background:var(--vscode-editor-background, #1e1e1e); text-align:left;">` +
                `<div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border, rgba(128,128,128,0.1)); padding-bottom:4px; margin-bottom:6px;">` +
                `<span style="font-weight:600; font-size:11px; color:var(--vscode-descriptionForeground, #a0a0a0);">🛡️ AI 安全预检评估</span>` +
                `<span style="color:${risk.color}; background:${risk.bg}; padding:1px 6px; border-radius:3px; font-size:10px; font-weight:bold;">${risk.text}</span>` +
                `</div>` +
                `<div style="margin-bottom:6px;">${badges}</div>` +
                (preflight.cwd ? `<div style="font-size:10px; opacity:0.7; font-family:monospace; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">工作区: ${escapeHtml(preflight.cwd)}</div>` : '') +
                (details ? `<ul style="margin:4px 0 0 0; padding-left:14px; color:var(--vscode-editor-foreground);">${details}</ul>` : '') +
                `</div>`;
        }

        div.innerHTML =
            `<div class="permission-card-header">` +
            `<span class="permission-card-icon">${svgIconNoMargin('key')}</span>` +
            `<div class="permission-card-body">` +
            `<div class="permission-card-title">${escapeHtml(description)}</div>` +
            (command ? `<div class="permission-card-cmd" style="font-family:var(--vscode-editor-font-family,monospace); background:var(--vscode-textCodeBlock-background,rgba(0,0,0,0.2)); padding:6px; border-radius:4px; font-size:11px; margin-top:4px; overflow-x:auto; white-space:pre-wrap; word-break:break-all; text-align:left;">${escapeHtml(command)}</div>` : '') +
            preflightHtml +
            `</div></div>` +
            actionsHtml;
        if (false) div.innerHTML =
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
                floatingPermissionIds.delete(permissionId);
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
                floatingPermissionIds.delete(permissionId);
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
                    floatingPermissionIds.delete(permissionId);
                    isShowingFloatingCard = false;
                    processFloatingCardQueue();
                });
            });
        }
        
        floatingCardQueue.push(div);
        processFloatingCardQueue();
    }

    function prepareSingleFileArtifactCard(card: HTMLElement, kind: string, filePath?: string, relPath?: string): void {
        const key = filePath || relPath || kind;
        document.querySelectorAll<HTMLElement>(`.plan-file-card[data-card-kind="${kind}"]`).forEach(existing => {
            if (existing.dataset.cardPath === key) existing.remove();
        });
        card.dataset.cardKind = kind;
        card.dataset.cardPath = key;
    }

    function restorePendingInteractiveCardsFromSteps(steps: any[] | undefined): void {
        if (!Array.isArray(steps) || steps.length === 0) return;
        const pCard = steps.find((s: any) => s.type === 'plan_card' && s.uiState === 'pending');
        if (pCard && pCard.toolResult) {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'renderPlan', sections: pCard.toolResult, planText: pCard.content, mode: pCard.mode }
            }));
        }
        const wtCard = steps.find((s: any) => s.type === 'walkthrough_card' && s.uiState === 'pending');
        if (wtCard && wtCard.toolResult) {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'renderWalkthrough', sections: wtCard.toolResult }
            }));
        }
        const bpCard = steps.find((s: any) => s.type === 'blueprint_card' && s.uiState === 'pending');
        if (bpCard && bpCard.toolResult) {
            window.dispatchEvent(new MessageEvent('message', {
                data: { type: 'renderBlueprint', sections: bpCard.toolResult, planText: bpCard.content }
            }));
        }
    }

    // ── Message handler ────────────────────────────────────────────────────────
    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.type) {

            case 'addUserMessage':
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(true);
                if (subagentTicker) {
                    clearInterval(subagentTicker);
                    subagentTicker = null;
                }
                removeLiveAssistantViews();
                addUserMessage(msg.text, msg.messageIndex, msg.images, msg.contexts);
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom(true);
                break;

            case 'startBackgroundGeneration':
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(true);
                if (subagentTicker) {
                    clearInterval(subagentTicker);
                    subagentTicker = null;
                }
                removeLiveAssistantViews();
                // Do not add user message bubble, but still render the assistant div
                currentAssistantDiv = initLiveAssistantDiv();
                chatArea.appendChild(currentAssistantDiv);
                scrollBottom(true);
                break;

            case 'agentStep':
                applyLiveStep(msg.step);
                break;
            case 'generationComplete': {
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(false);
                if (subagentTicker) {
                    clearInterval(subagentTicker);
                    subagentTicker = null;
                }
                // Clear all streaming status to prevent residual liveThinkBlock and other references from interfering with final message reconstruction
                removeLiveAssistantViews();
                
                // Clear any unresolved interactive cards (permission, diff)
                floatingCardQueue = [];
                floatingPermissionIds.clear();
                isShowingFloatingCard = false;
                document.querySelectorAll('.permission-card, .diff-card').forEach(el => dismissCard(el as HTMLElement, 0));

                const r = msg.result;
                const completedMsg = buildAssistantMessage(
                    r.explanation || (r.steps && r.steps.length ? '' : '完成'),
                    r.steps,
                    Date.now()
                );
                chatArea.appendChild(completedMsg);
                restorePendingInteractiveCardsFromSteps(r.steps);

                // Batch 3.4: Extract question cards to the floating card queue
                const allQCards = Array.from(completedMsg.querySelectorAll('.question-card')) as HTMLElement[];
                if (allQCards.length > 0) {
                    const wizardDiv = document.createElement('div');
                    wizardDiv.className = 'question-wizard-container';
                    allQCards.forEach((c, idx) => {
                        c.parentNode?.removeChild(c);
                        wizardDiv.appendChild(c);
                        // Reset display to only show the first one
                        c.style.display = idx === 0 ? 'block' : 'none';
                    });
                    floatingCardQueue.push(wizardDiv);
                    if (!isShowingFloatingCard) processFloatingCardQueue();
                }

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

            case 'generationError': {
                removeReplayBanners();
                clearActiveSubagentViews();
                setGenerating(false);
                removeLiveAssistantViews();
                
                // Clear any unresolved interactive cards
                floatingCardQueue = [];
                floatingPermissionIds.clear();
                isShowingFloatingCard = false;
                document.querySelectorAll('.permission-card, .diff-card').forEach(el => dismissCard(el as HTMLElement, 0));

                const errNode = buildAssistantMessage(String(msg.error || ''), [], Date.now());
                errNode.classList.add('assistant-error-message');
                const errBubble = errNode.querySelector('.msg-bubble');
                if (errBubble) {
                    const icon = document.createElement('span');
                    icon.className = 'assistant-error-icon';
                    icon.innerHTML = svgIconNoMargin('x');
                    errBubble.prepend(document.createTextNode(' '));
                    errBubble.prepend(icon);
                }
                if (msg.canResume) {
                    const resumeBtn = document.createElement('button');
                    resumeBtn.className = 'resume-btn';
                    resumeBtn.style.cssText = 'margin-top: 10px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; font-size: 13px;';
                    resumeBtn.innerHTML = svgIcon('refresh') + ' 恢复执行 (Resume)';
                    resumeBtn.addEventListener('click', () => {
                        resumeBtn.disabled = true;
                        resumeBtn.innerHTML = svgIcon('refresh') + ' 恢复中...';
                        vscode.postMessage({ type: 'resumeGeneration' });
                    });
                    
                    const msgBubble = errNode.querySelector('.msg-bubble');
                    if (msgBubble) {
                        msgBubble.appendChild(document.createElement('br'));
                        msgBubble.appendChild(resumeBtn);
                    } else {
                        errNode.appendChild(resumeBtn);
                    }
                }
                chatArea.appendChild(errNode);
                scrollBottom(true);
                break;
            }

            case 'clearChat':
                if (!isCurrentSurface(msg.targetSurface)) break;
                clearActiveSubagentViews();
                clearTopicWorkspaceState();
                editingMessageIndex = null;
                renderEditComposerState();
                while (chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
                emptyState.style.display = '';
                chatArea.appendChild(emptyState);
                messageIndexMap.clear();
                userMessagePayloadMap.clear();
                setGenerating(false);
                currentAssistantDiv = null;
                streamStates.clear();
                totalConversationTokens = 0;
                artifacts = [];
                renderArtifactPanel();
                updateCurrentTopicHeader(null, null);
                { const bar = document.getElementById('tokenUsageBar'); if (bar) bar.style.display = 'none'; }
                setChatEmptyState(true);
                startPlaceholderRotation();
                break;

            case 'topicList': {
                const currentFromList = msg.stats?.currentTopicId
                    ? (msg.topics || []).find((t: TopicPanelItem) => t.id === msg.stats.currentTopicId)
                    : undefined;
                updateCurrentTopicHeader(
                    msg.stats?.currentTopicId ?? null,
                    msg.stats?.currentTopicTitle ?? currentFromList?.title ?? null
                );
                renderTopics(msg.topics, msg.stats);
                break;
            }

            case 'mentionSearchResults':
                renderMentionMenu(msg.results);
                break;
            case 'fileList':
                // If @ popup is open, refresh it
                if (_atPopupVisible) {
                    const filter = getMentionFilterBeforeCaret();
                    if (filter !== null) showAtPopup(filter);
                }
                break;

            case 'artifactList':
                artifacts = sortArtifactsByNewest(msg.artifacts || []);
                renderArtifactPanel();
                break;

            case 'topicTitleGenerated': {
                if (msg.topicId === currentTopicId) {
                    updateCurrentTopicHeader(msg.topicId, msg.title);
                }
                const list = document.getElementById('topicsList');
                if (list) {
                    for (const item of Array.from(list.querySelectorAll('.topic-item[data-topic-id]'))) {
                        if ((item as HTMLElement).dataset.topicId !== msg.topicId) continue;
                        const span = item.querySelector('.topic-title');
                        if (span) span.textContent = msg.title;
                    }
                }
                break;
            }

            case 'topicForked': {
                // Close the topics panel and show a notification
                topicsPanel.classList.remove('show');
                if (sideWorkspaceContent === topicsPanel) closeSideWorkspace();
                const notif = document.createElement('div');
                notif.className = 'special-step';
                notif.style.cssText = 'padding:6px 0;opacity:0.6;font-size:11px;';
                notif.innerHTML = `${svgIconNoMargin('gitBranch')} 已从此处分叉为新话题: ${escapeHtml(msg.title)}`;
                chatArea.appendChild(notif);
                scrollBottom();
                break;
            }

            case 'loadTopicMessages':
                if (!isCurrentSurface(msg.targetSurface)) break;
                clearActiveSubagentViews();
                chatArea.innerHTML = '';
                messageIndexMap.clear();
                userMessagePayloadMap.clear();
                restoreArtifactsFromMessages(msg.messages || []);
                msg.messages.forEach((m: any, idx: number) => {
                    if (m.isHidden === true) return;
                    
                    // M4 fix: pass images array when restoring user messages from history
                    if (m.role === 'user') addUserMessage(m.displayContent || m.content, idx, m.images, m.contexts);
                    else {
                        chatArea.appendChild(buildAssistantMessage(m.content, m.steps, null));
                        scrollBottom();
                        // Restore custom UI cards from steps
                        restorePendingInteractiveCardsFromSteps(m.steps);
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
                for (const [idx] of userMessagePayloadMap) {
                    if (idx >= msg.messageIndex) userMessagePayloadMap.delete(idx);
                }
                if (msg.restoredInput) {
                    editingMessageIndex = null;
                    renderEditComposerState();
                    restoreComposerPayload(msg.restoredInput);
                }
                break;
            }

            case 'pendingWriteFile': showPendingWriteCard(msg.file, msg.messageId, msg.isNewFile, msg); break;

            case 'floatingCardResolved':
                resolveFloatingCard(msg.card, msg.id);
                break;

            case 'permissionRequest': {
                showPermissionCard(msg.permissionId, msg.tool || '', msg.description || '', msg.command || '', !!msg.allowAlways, msg.preflight);
                break;
            }

            case 'modeChanged':
                switchMode(msg.mode, /* fromUI */ false);
                break;

            case 'setMode':
                // Restore mode selector state after panel rebuild (no backend call needed)
                switchMode(msg.mode, /* fromUI */ false);
                break;

            case 'workflowList':
                workflows = (msg.workflows || []) as WorkflowView[];
                activeWorkflowId = msg.currentWorkflowId || null;
                renderComposerChips();
                break;

            case 'workflowChanged':
                activeWorkflowId = msg.workflowId || null;
                if (msg.workflow && !workflows.some(workflow => workflow.id === msg.workflow.id)) {
                    workflows = [...workflows, msg.workflow as WorkflowView];
                }
                renderComposerChips();
                break;

            case 'replaySteps': {
                removeReplayBanners();
                const replayedSteps = Array.isArray(msg.steps) ? msg.steps : [];
                if (msg.isGenerating) {
                    setGenerating(true);
                    removeLiveAssistantViews();
                    currentAssistantDiv = initLiveAssistantDiv();
                    chatArea.appendChild(currentAssistantDiv);
                    for (const step of replayedSteps) {
                        applyLiveStep(step);
                    }
                } else if (replayedSteps.length > 0) {
                    removeLiveAssistantViews();
                    chatArea.appendChild(buildAssistantMessage('', replayedSteps, Date.now()));
                }
                scrollBottom();
                break;
                /*
                // Panel was hidden while AI was running — replay accumulated steps
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
                    if (sendIcon) (sendIcon as HTMLElement).style.display = 'none';
                    if (stopIcon) (stopIcon as HTMLElement).style.display = 'inline-block';
                }
                scrollBottom();
                break;
                */
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
                if (msg.showPanel && isCurrentSurface(msg.targetSurface)) showSettingsPage(msg.providers, msg.current, msg.ollamaModels);
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
                    ${(stats.cacheStats && stats.cacheStats.totalCachedTokens > 0) ? `累计缓存命中: <span style="color:var(--vscode-charts-green, #388a34);">${stats.cacheStats.totalCachedTokens.toLocaleString()}</span> tokens <span style="font-size:11px; opacity:0.6;">(命中率 ${stats.cacheStats.cacheHitRate.toFixed(1)}%, 约省 ¥${stats.cacheStats.estimatedSavingsCny.toFixed(2)})</span><br>` : ''}
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

            case 'orchestratorProgress': {
                const p = msg.progress;
                // Make sure the Agent Lane panel exists
                let lanePanel = document.getElementById('orchestratorLanePanel');
                if (!lanePanel) {
                    lanePanel = document.createElement('div');
                    lanePanel.id = 'orchestratorLanePanel';
                    lanePanel.className = 'orchestrator-lane-panel';
                    //Insert at the end of chatArea
                    chatArea.appendChild(lanePanel);
                }
                // Build progress summary header (use SVG icon instead of emoji)
                const phaseLabels: Record<string, string> = {
                    planning: `${svgIconNoMargin('clipboard')} 规划中`,
                    executing: `${svgIconNoMargin('zap')} 执行中`,
                    reviewing: `${svgIconNoMargin('search')} 审查中`,
                    complete: `${svgIconNoMargin('check')} 已完成`,
                    failed: `${svgIconNoMargin('x')} 失败`,
                };
                const phaseCls = p.phase === 'complete' ? 'phase-complete' : p.phase === 'failed' ? 'phase-failed' : 'phase-active';
                const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
                const lanes = Array.isArray(p.lanes) ? p.lanes : [];
                const laneStats = lanes.reduce((acc: Record<string, number>, lane: any) => {
                    const key = lane.status || 'pending';
                    acc[key] = (acc[key] || 0) + 1;
                    return acc;
                }, {});

                let html = `<div class="orch-header">
                    <span class="orch-phase ${phaseCls}">${phaseLabels[p.phase] || p.phase}</span>
                    <span class="orch-progress-text">${p.done}/${p.total} 完成 · ${pct}%</span>
                </div>
                <div class="orch-kpis">
                    <span>${svgIconNoMargin('refresh')} ${laneStats.running || 0} running</span>
                    <span>${svgIconNoMargin('check')} ${laneStats.done || 0} done</span>
                    <span>${svgIconNoMargin('warning')} ${laneStats.failed || 0} failed</span>
                    <span>${svgIconNoMargin('gear')} ${laneStats.pending || 0} pending</span>
                </div>
                <div class="orch-progress-bar">
                    <div class="orch-progress-fill" style="width:${pct}%"></div>
                </div>`;

                if (p.latestEvent) {
                    html += `<div class="orch-event">${escapeHtml(p.latestEvent)}</div>`;
                }

                // Build Agent Lanes (use SVG icons instead of emojis)
                if (lanes.length > 0) {
                    html += '<div class="orch-lanes">';
                    const roleIcons: Record<string, string> = {
                        explorer: svgIconNoMargin('search'),
                        architect: svgIconNoMargin('ruler'),
                        builder: svgIconNoMargin('edit'),
                        locWriter: svgIconNoMargin('pencil'),
                        reviewer: svgIconNoMargin('shield'),
                        assetGen: svgIconNoMargin('sparkles'),
                    };
                    const statusIcons: Record<string, string> = {
                        pending: svgIconNoMargin('gear'),
                        running: svgIconNoMargin('refresh'),
                        done: svgIconNoMargin('check'),
                        failed: svgIconNoMargin('x'),
                        cancelled: svgIconNoMargin('eyeOff'),
                    };
                    for (const lane of lanes) {
                        const icon = roleIcons[lane.role] || svgIconNoMargin('bot');
                        const sIcon = statusIcons[lane.status] || svgIconNoMargin('question');
                        const durationText = lane.duration ? `${(lane.duration / 1000).toFixed(1)}s` : '';
                        const tokenText = lane.tokenUsed > 0 ? `${formatNum(lane.tokenUsed)} tok` : '';
                        const statusClass = `lane-${lane.status}`;
                        const laneTitle = `${lane.role || 'agent'} · ${lane.status || 'pending'} · ${lane.taskNodeId || ''}`;
                        html += `<div class="orch-lane ${statusClass}" title="${escapeHtml(laneTitle)}">
                            <div class="lane-header">
                                <span class="lane-icon">${icon}</span>
                                <span class="lane-role">${escapeHtml(lane.role)}</span>
                                <span class="lane-status">${sIcon}</span>
                            </div>
                            <div class="lane-id">${escapeHtml(lane.taskNodeId)}</div>
                            <div class="lane-meta">
                                ${durationText ? `<span>${durationText}</span>` : ''}
                                ${tokenText ? `<span>${tokenText}</span>` : ''}
                                ${lane.stepCount > 0 ? `<span>${lane.stepCount} steps</span>` : ''}
                            </div>
                            ${lane.statusText ? `<div class="lane-status-text">${escapeHtml(lane.statusText)}</div>` : ''}
                        </div>`;
                    }
                    html += '</div>';
                }

                lanePanel.innerHTML = html;
                scrollBottom();
                break;
            }

            case 'planFileSaved': {
                // Compact card — just "open file" button; annotation is handled by renderPlan below
                const isOrchestratorPlan = msg.mode === 'orchestrator';
                const card = document.createElement('div');
                card.className = `plan-file-card ${isOrchestratorPlan ? 'orchestrator-plan-card' : ''}`;
                prepareSingleFileArtifactCard(card, 'plan', msg.filePath, msg.relPath);
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin(isOrchestratorPlan ? 'bot' : 'clipboard')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">${isOrchestratorPlan ? '多 Agent 执行计划已导出' : '计划已导出'}</div>
                        <div class="plan-file-path">${escapeHtml(msg.relPath)}</div>
                        <div class="plan-file-hint">${isOrchestratorPlan ? '确认后将进入 dispatch_agents 并行执行。' : '确认后将切换到构建执行。'}</div>
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
                document.querySelectorAll('.annotatable-plan.plan-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                const isOrchestratorPlan = msg.mode === 'orchestrator';
                const labels = isOrchestratorPlan ? chatI18n.annotations.orchestratorPlan : chatI18n.annotations.plan;
                const wrap = createAnnotationCard({
                    className: `plan-card-wrap ${isOrchestratorPlan ? 'orchestrator-plan-card' : ''}`,
                    icon: isOrchestratorPlan ? 'bot' : 'edit',
                    approveIcon: isOrchestratorPlan ? 'zap' : 'check',
                    sections: msg.sections || [],
                    labels,
                    renderMarkdown,
                    postMessage: message => vscode.postMessage(message),
                    dismissCard: (element, delay = 0, done, removeFromDom) => dismissCard(element, delay, done, removeFromDom),
                    approveMessageType: 'submitPlanAnnotations',
                    reviseMessageType: 'revisePlanWithAnnotations',
                });
                showResponsiveWorkspacePanel({
                    kind: 'plan',
                    title: labels.title,
                    subtitle: labels.hint,
                    content: wrap,
                    wide: true,
                });
                scheduleResponsiveWorkspaceLayoutSync();
                break;
            }

            case 'walkthroughFileSaved': {
                const card = document.createElement('div');
                card.className = 'plan-file-card walkthrough-file-card';
                prepareSingleFileArtifactCard(card, 'walkthrough', msg.filePath, msg.relPath);
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

            case 'blueprintFileSaved': {
                const card = document.createElement('div');
                card.className = 'plan-file-card blueprint-file-card';
                prepareSingleFileArtifactCard(card, 'blueprint', msg.filePath, msg.relPath);
                card.innerHTML = `
                    <div class="plan-file-icon">${svgIconNoMargin('layers')}</div>
                    <div class="plan-file-info">
                        <div class="plan-file-title">设计蓝图已导出</div>
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
                document.querySelectorAll('.annotatable-plan.walkthrough-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                const wrap = createAnnotationCard({
                    className: 'walkthrough-card-wrap',
                    icon: 'flag',
                    sections: msg.sections || [],
                    labels: chatI18n.annotations.walkthrough,
                    renderMarkdown,
                    postMessage: message => vscode.postMessage(message),
                    dismissCard: (element, delay = 0, done, removeFromDom) => dismissCard(element, delay, done, removeFromDom),
                    approveMessageType: 'approveWalkthrough',
                    reviseMessageType: 'reviseWalkthroughWithAnnotations',
                    disableApproveOnSubmit: true,
                });
                showResponsiveWorkspacePanel({
                    kind: 'walkthrough',
                    title: chatI18n.annotations.walkthrough.title,
                    subtitle: chatI18n.annotations.walkthrough.hint,
                    content: wrap,
                    wide: true,
                });
                scheduleResponsiveWorkspaceLayoutSync();
                break;
            }

            case 'renderBlueprint': {
                document.querySelectorAll('.annotatable-plan.blueprint-card-wrap').forEach(el => dismissCard(el as HTMLElement, 0));
                const wrap = createAnnotationCard({
                    className: 'blueprint-card-wrap',
                    icon: 'layers',
                    sections: msg.sections || [],
                    labels: chatI18n.annotations.blueprint,
                    renderMarkdown,
                    postMessage: message => vscode.postMessage(message),
                    dismissCard: (element, delay = 0, done, removeFromDom) => dismissCard(element, delay, done, removeFromDom),
                    approveMessageType: 'submitPlanAnnotations',
                    reviseMessageType: 'revisePlanWithAnnotations',
                });
                showResponsiveWorkspacePanel({
                    kind: 'blueprint',
                    title: chatI18n.annotations.blueprint.title,
                    subtitle: chatI18n.annotations.blueprint.hint,
                    content: wrap,
                    wide: true,
                });
                scheduleResponsiveWorkspaceLayoutSync();
                break;
            }

            case 'insertSelectionReference': {
                insertReferenceAtCaret({
                    id: generateContextId(),
                    type: 'code_selection',
                    label: msg.relPath.split('/').pop() || msg.relPath,
                    uri: msg.relPath,
                    startLine: msg.startLine,
                    endLine: msg.endLine,
                    tokenEstimate: Math.max(1, (msg.endLine - msg.startLine + 1) * 24),
                    cacheStatus: 'live',
                });
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
                        const cacheText = u.cachedTokens ? `, <span style="display:inline-flex; align-items:center; gap:2px; vertical-align:middle; color:var(--vscode-charts-green, #388a34); margin-top:-2px;">${svgIconNoMargin('zap')} ${formatNum(u.cachedTokens)} 缓存</span>` : '';
                        const base = `~${formatNum(gaugeUsage)} / ${formatNum(contextLimit)} tokens` + cacheText;
                        const cost = u.estimatedCostCny > 0
                            ? '  ·  ' + (u.estimatedCostCny < 0.01 ? '<¥0.01' : '¥' + u.estimatedCostCny.toFixed(2))
                            : '';
                        label.innerHTML = base + cost;
                    }
                }
                break;
            }

            case 'diffSummary': {
                if (!msg.files || msg.files.length === 0) break;
                const summaryFiles: SideDiffFile[] = msg.files.map((f: any) => ({
                    file: f.file,
                    status: f.status,
                    diffPreview: f.diffPreview,
                    additions: f.additions,
                    deletions: f.deletions,
                    diffLines: f.diffLines,
                }));
                const summarySourceKey = msg.summaryId || getSideDiffSourceKey('文件变更', summaryFiles);
                const card = document.createElement('div');
                card.className = 'diff-summary-card';

                // Header with total stats
                let totalAdd = 0, totalDel = 0;
                for (const f of msg.files) { totalAdd += f.additions || 0; totalDel += f.deletions || 0; }
                const headerHtml = `<div class="ds-header">
                    <button class="ds-collapse-btn" type="button" aria-label="收起文件变更摘要" aria-expanded="true">▾</button>
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
                            if (shouldUseSideWorkspace()) {
                                openDiffInSideWorkspace(summaryFiles, '文件变更', { sourceKey: summarySourceKey, focusFile: f.file });
                                return;
                            }
                            const isOpen = diffBody.style.display !== 'none';
                            diffBody.style.display = isOpen ? 'none' : 'block';
                            const btn = fileHeader.querySelector('.ds-expand-btn');
                            if (btn) btn.textContent = isOpen ? '▶' : '▼';
                        });
                    }

                    filesList.appendChild(fileEl);
                }

                card.appendChild(filesList);
                const collapseBtn = card.querySelector('.ds-collapse-btn') as HTMLButtonElement | null;
                if (collapseBtn) {
                    collapseBtn.addEventListener('click', event => {
                        event.stopPropagation();
                        const collapsed = card.classList.toggle('collapsed');
                        collapseBtn.textContent = collapsed ? '▸' : '▾';
                        collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
                        collapseBtn.setAttribute('aria-label', collapsed ? '展开文件变更摘要' : '收起文件变更摘要');
                    });
                }
                chatArea.appendChild(card);
                scrollBottom();
                if (shouldUseSideWorkspace()) {
                    openDiffInSideWorkspace(summaryFiles, '文件变更', { sourceKey: summarySourceKey });
                }
                break;
            }

            case 'topicSearchResults': {
                const currentFromResults = msg.stats?.currentTopicId
                    ? (msg.results || []).find((t: TopicPanelItem) => t.id === msg.stats.currentTopicId)
                    : undefined;
                updateCurrentTopicHeader(
                    msg.stats?.currentTopicId ?? currentTopicId,
                    msg.stats?.currentTopicTitle ?? currentFromResults?.title ?? currentTopicTitle
                );
                renderTopicSearchResults(msg.results || [], msg.query || '', msg.totalCount || (msg.results ? msg.results.length : 0), msg.stats);
                break;
            }
        }
    });

    // ── Topic list with date groups ────────────────────────────────────────────
    const showArchivedCb = document.getElementById('showArchivedCb') as HTMLInputElement;
    if (showArchivedCb) {
        showArchivedCb.addEventListener('change', (e) => {
            vscode.postMessage({ type: 'setShowArchived', show: (e.target as HTMLInputElement).checked });
        });
    }

    function updateCurrentTopicHeader(topicId?: string | null, title?: string | null) {
        currentTopicId = topicId || null;
        currentTopicTitle = title || '';
        const titleBtn = document.getElementById('currentTopicTitle') as HTMLButtonElement | null;
        const renameBtn = document.getElementById('currentTopicRename') as HTMLButtonElement | null;
        const chip = document.getElementById('currentTopicChip') as HTMLElement | null;
        const label = currentTopicTitle || '新话题';
        if (titleBtn) {
            titleBtn.textContent = label;
            titleBtn.title = currentTopicId ? `重命名：${label}` : '发送第一条消息后创建话题';
            titleBtn.disabled = !currentTopicId;
        }
        if (renameBtn) {
            renameBtn.disabled = !currentTopicId;
            renameBtn.style.display = currentTopicId ? '' : 'none';
        }
        if (chip) chip.classList.toggle('current-topic-empty', !currentTopicId);
    }

    function commitTopicRename(topicId: string, rawTitle: string, originalTitle: string) {
        const nextTitle = rawTitle.trim().replace(/\s+/g, ' ');
        if (!nextTitle || nextTitle === originalTitle) return false;
        vscode.postMessage({ type: 'renameTopic', topicId, title: nextTitle });
        return true;
    }

    function startTopicRename(topicId: string, title: string, source: 'header' | 'list' | 'search', titleEl?: HTMLElement) {
        if (!topicId) return;
        const originalTitle = title || '';
        const headerTitleBtn = source === 'header'
            ? document.getElementById('currentTopicTitle') as HTMLButtonElement | null
            : null;
        const input = document.createElement('input');
        input.className = 'topic-rename-input';
        input.value = originalTitle;
        input.maxLength = 120;
        input.setAttribute('aria-label', '话题名称');

        let cancelled = false;
        const finish = (commit: boolean) => {
            if (!input.isConnected) return;
            const parent = input.parentElement;
            if (commit && !cancelled) {
                commitTopicRename(topicId, input.value, originalTitle);
            }
            if (source === 'header') {
                if (headerTitleBtn && parent) {
                    parent.replaceChild(headerTitleBtn, input);
                }
                updateCurrentTopicHeader(currentTopicId, currentTopicTitle);
            } else if (titleEl && parent) {
                parent.replaceChild(titleEl, input);
            }
        };

        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelled = true;
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));

        if (source === 'header') {
            if (!headerTitleBtn?.parentElement) return;
            headerTitleBtn.replaceWith(input);
        } else if (titleEl?.parentElement) {
            titleEl.replaceWith(input);
        }

        requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    }

    function renderTopics(topics: TopicPanelItem[], stats?: TopicPanelStats) {
        renderTopicsView(
            { list: document.getElementById('topicsList'), summary: document.getElementById('topicsPanelSummary'), panel: topicsPanel },
            topics,
            stats,
            {
                postMessage: message => {
                    vscode.postMessage(message);
                    if ((message as any)?.type === 'loadTopic' && sideWorkspaceContent !== topicsPanel) {
                        topicsPanel.classList.remove('show');
                    }
                },
                startRename: (topicId, title, source, titleElement) => startTopicRename(topicId, title, source, titleElement),
                formatTime,
            },
            { grouping: document.body.classList.contains('agent-manager-shell') ? 'workspace' : 'date' },
        );
    }

    function renderTopicSearchResults(results: TopicPanelItem[], query: string, totalCount: number, stats?: TopicPanelStats) {
        renderTopicSearchResultsView(
            { list: document.getElementById('topicsList'), summary: document.getElementById('topicsPanelSummary'), panel: topicsPanel },
            results,
            query,
            totalCount,
            stats,
            {
                postMessage: message => {
                    vscode.postMessage(message);
                    if ((message as any)?.type === 'loadTopic' && sideWorkspaceContent !== topicsPanel) {
                        topicsPanel.classList.remove('show');
                    }
                },
                startRename: (topicId, title, source, titleElement) => startTopicRename(topicId, title, source, titleElement),
                formatTime,
            },
        );
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
        quickModelOptions = models.length > 0 ? models : (current.model ? [current.model] : []);
        quickModelCurrent = current.model || quickModelOptions[0] || '';
        qms.innerHTML = '';
        if (models.length > 0) {
            for (const m of models) { const opt = document.createElement('option'); opt.value = m; opt.textContent = m; opt.selected = m === current.model; qms.appendChild(opt); }
        } else { const opt = document.createElement('option'); opt.value = current.model || ''; opt.textContent = current.model || '(未设置)'; qms.appendChild(opt); }
        renderQuickModelMenu();
    }

    function refreshSettingsOverview() {
        const titleEl = document.getElementById('settingsOverviewTitle');
        const subtitleEl = document.getElementById('settingsOverviewSubtitle');
        const chipsEl = document.getElementById('settingsOverviewChips');
        const providerSel = document.getElementById('settingsProvider') as HTMLSelectElement | null;
        if (!titleEl || !subtitleEl || !chipsEl || !providerSel) return;

        const providerId = providerSel.value || settingsProviders[0]?.id || '';
        const provider = settingsProviders.find((p: any) => p.id === providerId);
        const modelInput = document.getElementById('settingsModelInput') as HTMLInputElement | null;
        const endpointInput = document.getElementById('settingsEndpoint') as HTMLInputElement | null;
        const ctxInput = document.getElementById('settingsCtx') as HTMLInputElement | null;
        const inlineEnabled = document.getElementById('inlineEnabled') as HTMLInputElement | null;
        const inlineProviderSel = document.getElementById('inlineProvider') as HTMLSelectElement | null;
        const agentModeSel = document.getElementById('agentWriteMode') as HTMLSelectElement | null;
        const reasoningSel = document.getElementById('settingsReasoningEffort') as HTMLSelectElement | null;
        const inlineProviderName = inlineProviderSel?.value
            ? (settingsProviders.find((p: any) => p.id === inlineProviderSel.value)?.name || inlineProviderSel.value)
            : undefined;
        applySettingsOverview(
            {
                title: titleEl,
                subtitle: subtitleEl,
                chips: chipsEl,
                headerSubtitle: document.getElementById('settingsHeaderSubtitle'),
            },
            buildSettingsOverviewModel({
                providers: settingsProviders,
                providerId,
                model: modelInput?.value.trim() || provider?.defaultModel,
                endpoint: endpointInput?.value.trim() || provider?.defaultEndpoint,
                contextTokens: parseInt(ctxInput?.value || '0', 10) || 0,
                inlineEnabled: !!inlineEnabled?.checked,
                inlineProviderName,
                mcpCount: document.querySelectorAll('#mcpServersList .mcp-server-block').length,
                writeMode: agentModeSel?.value || 'confirm',
                reasoningEffort: reasoningSel?.value || 'high',
            }, chatI18n),
        );
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
        // Brave Search API key — show masked placeholder if already set
        const braveKeyEl = document.getElementById('braveSearchApiKey') as HTMLInputElement | null;
        if (braveKeyEl) braveKeyEl.value = current.braveSearchApiKey || '';
        const exaKeyEl = document.getElementById('exaApiKey') as HTMLInputElement | null;
        if (exaKeyEl) exaKeyEl.value = current.exaApiKey || '';

        // Render MCP Servers
        const mcpList = document.getElementById('mcpServersList');
        if (mcpList) mcpList.innerHTML = '';
        if (current.mcp?.servers) {
            current.mcp.servers.forEach((s: any) => addMcpServerBlock(s));
        }

        // ── Child Agent model configuration: dynamically populate supplier/model drop-down ──────────────────────
        const savedAgentModels = current.orchestrator?.agentModels || {};
        document.querySelectorAll('.agent-model-row').forEach(row => {
            const role = (row as HTMLElement).dataset.role;
            if (!role) return;
            const provSel = row.querySelector('.agent-model-provider') as HTMLSelectElement;
            const modSel = row.querySelector('.agent-model-model') as HTMLSelectElement;
            if (!provSel || !modSel) return;

            // Populate the supplier dropdown
            provSel.innerHTML = '<option value="__inherit__">继承主设置</option>'
                + providers.map((p: any) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');

            const saved = savedAgentModels[role];
            if (saved?.provider && saved.provider !== '__inherit__') {
                provSel.value = saved.provider;
            }

            // Populate model dropdown (according to selected supplier)
            const fillModels = (pid: string) => {
                const provDef = providers.find((p: any) => p.id === pid);
                const models: string[] = pid === 'ollama'
                    ? (ollamaModels || []).map((m: any) => m.name)
                    : (provDef ? provDef.models : []);
                modSel.innerHTML = '<option value="__inherit__">继承主设置</option>'
                    + models.map(m => `<option value="${m}">${escapeHtml(m)}</option>`).join('');
            };

            if (saved?.provider && saved.provider !== '__inherit__') {
                fillModels(saved.provider);
                if (saved.model && saved.model !== '__inherit__') {
                    modSel.value = saved.model;
                }
            }

            // Linked update model drop-down when supplier changes
            provSel.addEventListener('change', () => {
                if (provSel.value === '__inherit__') {
                    modSel.innerHTML = '<option value="__inherit__">继承主设置</option>';
                } else {
                    fillModels(provSel.value);
                }
            });
        });

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
        settingsPage.classList.add('active');
        if (shouldUseSideWorkspace()) {
            settingsInSideWorkspace = true;
            responsiveWorkspacePinnedClosed = !!activeResponsiveWorkspace;
            openSideWorkspace({ title: 'AI 设置', subtitle: '模型、上下文、API 和工具', content: settingsPage });
        } else {
            settingsInSideWorkspace = false;
            closeSideWorkspace({ preserveResponsivePin: true });
            chatHeader.style.display = 'none';
            document.getElementById('chatArea')!.style.display = 'none';
            if (inputWrapper) inputWrapper.style.display = 'none';
            const mi = document.getElementById('modeIndicator');
            if (mi) mi.style.display = 'none';
            if (todoPanel) todoPanel.style.display = 'none';
        }
        const _tr = document.getElementById('testResult');
        if (_tr) { _tr.className = 'test-result'; _tr.textContent = ''; }
        refreshSettingsOverview();
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
        if (settingsInSideWorkspace) {
            closeSideWorkspace({ preserveResponsivePin: true });
            responsiveWorkspacePinnedClosed = false;
            syncResponsiveWorkspaceLayout();
            return;
        }
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
        const deleteBtn = document.getElementById('deleteApiKeyBtn') as HTMLButtonElement | null;
        if (p && p.requiresApiKey === false) {
            group.style.display = 'none';
            providerHint.innerHTML = '';
            if (deleteBtn) deleteBtn.disabled = true;
            refreshSettingsOverview();
            return;
        }
        group.style.display = '';
        
        if (p && p.hasKey) { status.innerHTML = svgIcon('check') + '已配置 API Key'; status.style.color = '#4caf50'; }
        else { status.innerHTML = svgIcon('warning') + '尚未配置 API Key'; status.style.color = '#ff9800'; }
        if (deleteBtn) deleteBtn.disabled = !(p && p.hasKey);
        
        if (p && p.registerUrl) {
            providerHint.innerHTML = `<a href="${p.registerUrl}" style="color:var(--vscode-textLink-foreground);">申请 API Key 地址</a>`;
        } else {
            providerHint.innerHTML = '';
        }
        refreshSettingsOverview();
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
        refreshSettingsOverview();
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
            refreshSettingsOverview();
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
        } else if (providerId === 'custom') {
            currentDropdownOpts = [];
            modelHint.textContent = '输入自定义渠道支持的模型名，或用 API Key 和 Endpoint 拉取模型';
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
        refreshSettingsOverview();
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
            refreshSettingsOverview();
        });
        refreshSettingsOverview();
    }

    document.getElementById('detectBtn')!.addEventListener('click', detectOllamaModels);
    document.getElementById('fetchApiModelsBtn')!.addEventListener('click', fetchApiModels);

    function deleteApiKey() {
        const providerId = (document.getElementById('settingsProvider') as HTMLSelectElement).value;
        if (!providerId) return;

        const keyInput = document.getElementById('settingsApiKey') as HTMLInputElement | null;
        if (keyInput) keyInput.value = '';
        const status = document.getElementById('apiKeyStatus');
        if (status) {
            status.textContent = '正在移除 API Key...';
            status.style.color = 'inherit';
        }
        vscode.postMessage({ type: 'deleteApiKey', providerId });
    }

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
                reasoningEffort: (document.getElementById('settingsReasoningEffort') as HTMLSelectElement).value || 'high',
                braveSearchApiKey: ((document.getElementById('braveSearchApiKey') as HTMLInputElement | null)?.value || '').trim(),
                exaApiKey: ((document.getElementById('exaApiKey') as HTMLInputElement | null)?.value || '').trim(),
                inlineCompletion: {
                    enabled: (document.getElementById('inlineEnabled') as HTMLInputElement).checked,
                    provider: (document.getElementById('inlineProvider') as HTMLSelectElement).value,
                    model: (document.getElementById('inlineModelInput') as HTMLInputElement).value.trim(),
                    endpoint: (document.getElementById('inlineEndpoint') as HTMLInputElement).value.trim(),
                    debounceMs: parseInt((document.getElementById('inlineDebounce') as HTMLInputElement).value) || 500,
                    overlapStripping: (document.getElementById('inlineOverlapStripping') as HTMLInputElement | null)?.checked ?? true,
                },
                mcp: { servers: mcpServers },
                orchestrator: {
                    agentModels: (() => {
                        const models: Record<string, { provider: string; model: string }> = {};
                        document.querySelectorAll('.agent-model-row').forEach(row => {
                            const role = (row as HTMLElement).dataset.role;
                            if (!role) return;
                            const prov = (row.querySelector('.agent-model-provider') as HTMLSelectElement)?.value || '__inherit__';
                            const mod = (row.querySelector('.agent-model-model') as HTMLSelectElement)?.value || '__inherit__';
                            //Only collect non-inherited configurations
                            if (prov !== '__inherit__' || mod !== '__inherit__') {
                                models[role] = { provider: prov, model: mod };
                            }
                        });
                        return Object.keys(models).length > 0 ? models : undefined;
                    })(),
                },
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

    // Send ready only after all message handlers are registered.
    (window as any).__cwtoolsPostReady = () => vscode.postMessage({ type: 'ready' });
    if (!isManagerShell()) {
        (window as any).__cwtoolsPostReady();
    }
})();
