/**
 * Sidebar form for the Steam Workshop upload.
 *
 * The view owns nothing but presentation: it renders a form, forwards the user's
 * edits to `workshopUpload.ts`, and repaints the progress/result state it gets
 * back. The command and the editor/title button both end up here, so there is
 * exactly one upload UI.
 *
 * The message contract below is shared verbatim with `client/webview/`.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
    PREVIEW_EXTENSIONS,
    WORKSHOP_UPLOAD_VIEW_ID,
    WORKSHOP_VISIBILITIES,
    getPendingWorkshopUploadTarget,
    isSteamworksPlatformSupported,
    isUsablePreviewPath,
    isWorkshopUploadInFlight,
    onWorkshopUploadTargetRequested,
    fetchExistingItemDetails,
    registerWorkshopUploadCommands,
    resolveModRoot,
    resolveWorkshopTarget,
    uploadWorkshopMod,
    type WorkshopUploadStage,
    type WorkshopVisibility,
} from './workshopUpload';
import { isChineseLocale, localize } from './panelI18n';
import {
    fields,
    isOneOf,
    isString,
    isStringArray,
    optional,
    parseProtocolMessage,
} from '../shared/protocolValidation';

/** Form state the Webview hands back with an `upload` message. */
export interface WorkshopUploadFormData {
    title: string;
    description: string;
    tags: string[];
    previewPath?: string;
    visibility: WorkshopVisibility;
    changeNote: string;
}

/** Everything the form needs to describe the mod it is about to upload. */
export interface WorkshopUploadPrefill {
    title: string;
    description: string;
    tags: string[];
    previewPath?: string;
    visibility: WorkshopVisibility;
    changeNote: string;
    modRoot: string;
    remoteFileId?: string;
    appId: string;
    gameId: string;
    locale: 'en' | 'zh';
}

// ─── Host ⇄ Webview message protocol ──────────────────────────────────────────

export type WorkshopWebviewMessage =
    | { type: 'ready' }
    | { type: 'pickPreview' }
    | { type: 'upload'; data: WorkshopUploadFormData };

export type WorkshopHostMessage =
    | { type: 'prefill'; data: WorkshopUploadPrefill }
    | { type: 'previewPicked'; path?: string; webviewUri?: string }
    | { type: 'progress'; stage: WorkshopUploadStage; done: number; total: number }
    | { type: 'busy'; busy: boolean }
    | {
        type: 'result';
        ok: boolean;
        created?: boolean;
        itemId?: string;
        url?: string;
        needsAgreement?: boolean;
        error?: string;
    };

const isWorkshopVisibility = isOneOf(WORKSHOP_VISIBILITIES);

const WORKSHOP_MESSAGE_VALIDATORS: Record<WorkshopWebviewMessage['type'], (message: Record<string, unknown>) => boolean> = {
    ready: fields(),
    pickPreview: fields(),
    upload: fields({
        data: message =>
            message !== null &&
            typeof message === 'object' &&
            isString((message as WorkshopUploadFormData).title) &&
            isString((message as WorkshopUploadFormData).description) &&
            isStringArray((message as WorkshopUploadFormData).tags) &&
            isString((message as WorkshopUploadFormData).changeNote) &&
            isWorkshopVisibility((message as WorkshopUploadFormData).visibility) &&
            optional(isString)((message as WorkshopUploadFormData).previewPath),
    }),
};

// ─── Webview document ──────────────────────────────────────────────────────────

const WEBVIEW_ROOT_SEGMENTS = ['bin', 'client', 'webview'] as const;
const WEBVIEW_SCRIPT_NAME = 'workshopUpload.js';

/** Mount point the Webview bundle renders into. */
const WEBVIEW_ROOT_ELEMENT_ID = 'workshop-upload-root';

/**
 * Builds the Webview document. Markup and styling belong to
 * `client/webview/workshopUpload.ts`, which ships as one self-contained
 * bundle; the host only supplies the mount point, the CSP, and the locale.
 */
export function getWorkshopUploadHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview
        .asWebviewUri(vscode.Uri.joinPath(extensionUri, ...WEBVIEW_ROOT_SEGMENTS, WEBVIEW_SCRIPT_NAME))
        .toString();
    const csp = webview.cspSource;
    const locale: 'en' | 'zh' = isChineseLocale() ? 'zh' : 'en';
    return `<!DOCTYPE html>
<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; style-src ${csp} 'unsafe-inline'; script-src ${csp};">
<title>${localize('Steam Workshop Upload', 'Steam 创意工坊上传')}</title>
</head>
<body class="workshop-upload" data-locale="${locale}">
<div id="${WEBVIEW_ROOT_ELEMENT_ID}"></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

// ─── Provider ──────────────────────────────────────────────────────────────────

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : String(error);
}

export class WorkshopUploadViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = WORKSHOP_UPLOAD_VIEW_ID;

    private view?: vscode.WebviewView;
    private modRoot?: string;
    private disposables: vscode.Disposable[] = [];

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ): void {
        this.view = webviewView;
        this.disposeViewState();
        this.modRoot = this.modRoot ?? getPendingWorkshopUploadTarget() ?? resolveModRoot();

        webviewView.webview.html = getWorkshopUploadHtml(webviewView.webview, this.extensionUri);
        this.updateResourceRoots();

        webviewView.webview.onDidReceiveMessage(
            (raw: unknown) => {
                void this.handleMessage(raw);
            },
            undefined,
            this.disposables,
        );
        webviewView.onDidChangeVisibility(
            () => {
                if (webviewView.visible) void this.sendPrefill();
            },
            undefined,
            this.disposables,
        );
        this.disposables.push(
            onWorkshopUploadTargetRequested(modRoot => {
                this.modRoot = modRoot;
                void this.sendPrefill();
            }),
        );
    }

    dispose(): void {
        this.disposeViewState();
        this.view = undefined;
        this.modRoot = undefined;
    }

    private disposeViewState(): void {
        for (const disposable of this.disposables) {
            try {
                disposable.dispose();
            } catch {
                // Disposal must never block a re-resolve.
            }
        }
        this.disposables = [];
    }

    /**
     * The preview image lives inside the mod folder, so the mod root has to be an
     * allowed local resource before `asWebviewUri` can hand it to the Webview.
     */
    private updateResourceRoots(): void {
        const webview = this.view?.webview;
        if (!webview) return;
        const roots = [
            vscode.Uri.joinPath(this.extensionUri, ...WEBVIEW_ROOT_SEGMENTS),
        ];
        if (this.modRoot) {
            roots.push(vscode.Uri.file(this.modRoot));
        }
        webview.options = { enableScripts: true, localResourceRoots: roots };
    }

    private post(message: WorkshopHostMessage): void {
        void this.view?.webview.postMessage(message);
    }

    // ─── Message handling ────────────────────────────────────────────────────

    private async handleMessage(raw: unknown): Promise<void> {
        const message = parseProtocolMessage<WorkshopWebviewMessage>(raw, WORKSHOP_MESSAGE_VALIDATORS);
        if (!message) return;
        switch (message.type) {
            case 'ready':
                await this.sendPrefill();
                return;
            case 'pickPreview':
                await this.pickPreview();
                return;
            case 'upload':
                await this.runUpload(message.data);
                return;
        }
    }

    /** Sends the current mod's state, or explains why there is nothing to show. */
    private async sendPrefill(): Promise<void> {
        const modRoot = this.modRoot ?? getPendingWorkshopUploadTarget() ?? resolveModRoot();
        if (!modRoot) {
            this.post({
                type: 'result',
                ok: false,
                error: localize(
                    'Open a mod folder to upload it to the Steam Workshop.',
                    '请先打开一个 Mod 文件夹再上传到 Steam 创意工坊。'
                ),
            });
            return;
        }
        this.modRoot = modRoot;
        this.updateResourceRoots();

        const resolved = resolveWorkshopTarget(vscode.Uri.file(modRoot));
        if (!resolved.ok) {
            this.post({ type: 'result', ok: false, error: resolved.failure.message });
            return;
        }
        const target = resolved.target;
        // An update pre-fills the description from the Workshop page itself: it
        // is the one field that only lives on Steam, never in descriptor.mod.
        const existing = target.descriptor.remoteFileId
            ? await fetchExistingItemDetails(target.appId, target.descriptor.remoteFileId)
            : undefined;
        this.post({
            type: 'prefill',
            data: {
                title: target.descriptor.name?.trim() || path.basename(target.modRoot),
                description: existing?.description ?? '',
                tags: target.descriptor.tags ?? [],
                previewPath: target.previewPath,
                visibility: target.defaultVisibility,
                changeNote: '',
                modRoot: target.modRoot,
                remoteFileId: target.descriptor.remoteFileId,
                appId: target.appId,
                gameId: target.gameId ?? '',
                locale: isChineseLocale() ? 'zh' : 'en',
            },
        });
    }

    /**
     * Lets the user pick a preview image. Cancelling and picking an unusable file
     * both leave the form untouched; only a valid pick is reported back.
     */
    private async pickPreview(): Promise<void> {
        const modRoot = this.modRoot;
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: localize('Use Preview Image', '使用该预览图'),
            filters: { 'Images': [...PREVIEW_EXTENSIONS.map(extension => extension.replace('.', ''))] },
            defaultUri: modRoot ? vscode.Uri.file(modRoot) : undefined,
        });
        const file = picked?.[0];
        if (!file) return;
        if (!isUsablePreviewPath(file.fsPath)) {
            void vscode.window.showWarningMessage(
                localize(
                    'The preview image must be a PNG or JPG smaller than 1 MB.',
                    '预览图必须是小于 1 MB 的 PNG 或 JPG 文件。'
                )
            );
            return;
        }
        this.post({
            type: 'previewPicked',
            path: file.fsPath,
            webviewUri: this.view?.webview.asWebviewUri(file).toString(),
        });
    }

    private async runUpload(data: WorkshopUploadFormData): Promise<void> {
        const modRoot = this.modRoot;
        if (!modRoot) {
            this.post({
                type: 'result',
                ok: false,
                error: localize(
                    'Open a mod folder to upload it to the Steam Workshop.',
                    '请先打开一个 Mod 文件夹再上传到 Steam 创意工坊。'
                ),
            });
            return;
        }
        if (isWorkshopUploadInFlight()) {
            this.post({
                type: 'result',
                ok: false,
                error: localize(
                    'Another Steam Workshop upload is already running.',
                    '已有一个 Steam 创意工坊上传正在进行中。'
                ),
            });
            return;
        }
        if (!isSteamworksPlatformSupported()) {
            this.post({
                type: 'result',
                ok: false,
                error: localize(
                    `Steam Workshop upload is not supported on ${process.platform}-${process.arch}.`,
                    `当前平台 ${process.platform}-${process.arch} 不支持 Steam 创意工坊上传。`
                ),
            });
            return;
        }
        if (data.previewPath && !isUsablePreviewPath(data.previewPath)) {
            this.post({
                type: 'result',
                ok: false,
                error: localize(
                    'The preview image must be a PNG or JPG smaller than 1 MB.',
                    '预览图必须是小于 1 MB 的 PNG 或 JPG 文件。'
                ),
            });
            return;
        }

        // Re-resolve rather than trusting the prefill: the descriptor may have
        // been edited or removed since the form was filled in.
        const resolved = resolveWorkshopTarget(vscode.Uri.file(modRoot));
        if (!resolved.ok) {
            this.post({ type: 'result', ok: false, error: resolved.failure.message });
            return;
        }
        const target = resolved.target;

        this.post({ type: 'busy', busy: true });
        this.post({ type: 'progress', stage: 'connecting', done: 0, total: 0 });
        try {
            const result = await uploadWorkshopMod({
                modRoot,
                appId: target.appId,
                title: data.title,
                description: data.description,
                tags: data.tags,
                changeNote: data.changeNote,
                visibility: data.visibility,
                previewPath: data.previewPath,
                remoteFileId: target.descriptor.remoteFileId,
                onProgress: progress =>
                    this.post({
                        type: 'progress',
                        stage: progress.stage,
                        done: progress.done,
                        total: progress.total,
                    }),
            });
            this.post({
                type: 'progress',
                stage: 'done',
                done: 1,
                total: 1,
            });
            this.post({
                type: 'result',
                ok: result.ok,
                created: result.created,
                itemId: result.itemId || undefined,
                url: result.url,
                needsAgreement: result.needsAgreement,
                // A successful upload can still carry a non-fatal warning (the
                // descriptor write-back), and `error` is the only text channel.
                error: result.error ?? result.warning,
            });
        } catch (error) {
            this.post({ type: 'result', ok: false, error: describeError(error) });
        } finally {
            this.post({ type: 'busy', busy: false });
        }
    }

}

/**
 * Single registration entry point: the upload command, its editor/title context
 * key, and the sidebar view. Reload-safe because every disposable is pushed onto
 * `context.subscriptions`, which `cwtools.reloadExtension` clears first.
 */
export function registerWorkshopUpload(context: vscode.ExtensionContext): void {
    registerWorkshopUploadCommands(context);
    const provider = new WorkshopUploadViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(WorkshopUploadViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        }),
        provider,
    );
}
