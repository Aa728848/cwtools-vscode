import * as fs from 'fs';
import * as path from 'path';
import * as vs from 'vscode';
import { decodeDds, decodeTga } from './ddsDecoder';

export const TEXTURE_PREVIEW_VIEW_TYPE = 'cwtools.texturePreview';
export const OPEN_TEXTURE_PREVIEW_COMMAND = 'cwtools.openTexturePreview';

class TexturePreviewDocument implements vs.CustomDocument {
    constructor(public readonly uri: vs.Uri) { }
    dispose(): void { }
}

interface TexturePreviewPayload {
    fileName: string;
    filePath: string;
    dataUri: string;
    width: number;
    height: number;
    fileSizeLabel: string;
}

class TexturePreviewEditorProvider implements vs.CustomReadonlyEditorProvider<TexturePreviewDocument> {
    static register(): vs.Disposable {
        return vs.window.registerCustomEditorProvider(
            TEXTURE_PREVIEW_VIEW_TYPE,
            new TexturePreviewEditorProvider(),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            },
        );
    }

    openCustomDocument(
        uri: vs.Uri,
        _openContext: vs.CustomDocumentOpenContext,
        _token: vs.CancellationToken,
    ): TexturePreviewDocument {
        return new TexturePreviewDocument(uri);
    }

    resolveCustomEditor(
        document: TexturePreviewDocument,
        webviewPanel: vs.WebviewPanel,
        _token: vs.CancellationToken,
    ): void {
        webviewPanel.webview.options = {
            enableScripts: true,
        };
        webviewPanel.title = path.basename(document.uri.fsPath);
        webviewPanel.webview.html = renderTexturePreview(document.uri.fsPath);
    }
}

export function registerTexturePreviewEditor(context: vs.ExtensionContext): void {
    context.subscriptions.push(
        TexturePreviewEditorProvider.register(),
        vs.commands.registerCommand(OPEN_TEXTURE_PREVIEW_COMMAND, openTexturePreview),
    );
}

export async function openTexturePreview(target: string | vs.Uri): Promise<void> {
    const uri = typeof target === 'string' ? vs.Uri.file(target) : target;
    if (!uri?.fsPath || !fs.existsSync(uri.fsPath)) {
        await vs.window.showWarningMessage(`Texture file not found: ${typeof target === 'string' ? target : target?.fsPath ?? ''}`);
        return;
    }

    const ext = path.extname(uri.fsPath).toLowerCase();
    if (ext === '.dds' || ext === '.tga') {
        await vs.commands.executeCommand('vscode.openWith', uri, TEXTURE_PREVIEW_VIEW_TYPE, {
            preview: true,
            viewColumn: vs.ViewColumn.Active,
        });
        return;
    }

    await vs.commands.executeCommand('vscode.open', uri, {
        preview: true,
        viewColumn: vs.ViewColumn.Active,
    });
}

function renderTexturePreview(filePath: string): string {
    const payload = decodeTexture(filePath);
    if (!payload) {
        return renderErrorPreview(filePath);
    }
    return renderImagePreview(payload);
}

function decodeTexture(filePath: string): TexturePreviewPayload | null {
    const ext = path.extname(filePath).toLowerCase();
    const result = ext === '.dds'
        ? decodeDds(filePath)
        : ext === '.tga'
            ? decodeTga(filePath)
            : null;
    if (!result) return null;

    let fileSizeLabel = '';
    try {
        fileSizeLabel = formatBytes(fs.statSync(filePath).size);
    } catch {
        fileSizeLabel = '';
    }

    return {
        fileName: path.basename(filePath),
        filePath,
        dataUri: result.dataUri,
        width: result.width,
        height: result.height,
        fileSizeLabel,
    };
}

function renderImagePreview(payload: TexturePreviewPayload): string {
    const nonce = getNonce();
    const scriptPayload = JSON.stringify({
        width: payload.width,
        height: payload.height,
    }).replace(/<\/script/gi, '<\\/script');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(payload.fileName)}</title>
    <style nonce="${nonce}">
        html, body {
            height: 100%;
            margin: 0;
            padding: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            overflow: hidden;
        }
        body {
            display: grid;
            grid-template-rows: auto 1fr;
        }
        .toolbar {
            min-height: 38px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 6px 10px;
            box-sizing: border-box;
            border-bottom: 1px solid var(--vscode-editorWidget-border);
            background: var(--vscode-sideBar-background);
        }
        .meta {
            min-width: 0;
            display: flex;
            align-items: baseline;
            gap: 10px;
        }
        .name {
            min-width: 0;
            max-width: min(56vw, 760px);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            font-weight: 600;
        }
        .detail, .zoom-label {
            color: var(--vscode-descriptionForeground);
            white-space: nowrap;
        }
        .actions {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        .backgrounds {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-right: 6px;
            padding-right: 6px;
            border-right: 1px solid var(--vscode-editorWidget-border);
        }
        button {
            min-width: 32px;
            height: 26px;
            padding: 0 8px;
            border: 1px solid var(--vscode-button-border, var(--vscode-editorWidget-border));
            border-radius: 3px;
            color: var(--vscode-button-foreground);
            background: var(--vscode-button-background);
            font: inherit;
            cursor: pointer;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
        button:focus-visible {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 2px;
        }
        .swatch {
            min-width: 24px;
            width: 24px;
            height: 24px;
            padding: 0;
        }
        .swatch[data-bg="black"] {
            background: #000;
        }
        .swatch[data-bg="white"] {
            background: #fff;
        }
        .swatch[data-bg="gray"] {
            background: #808080;
        }
        .swatch.active {
            outline: 2px solid var(--vscode-focusBorder);
            outline-offset: 1px;
        }
        .stage {
            min-height: 0;
            overflow: auto;
            display: grid;
            place-items: center;
            padding: 24px;
            box-sizing: border-box;
        }
        .stage[data-background="black"] {
            background: #000;
        }
        .stage[data-background="white"] {
            background: #fff;
        }
        .stage[data-background="gray"] {
            background: #808080;
        }
        .surface {
            line-height: 0;
            box-shadow: 0 0 0 1px var(--vscode-editorWidget-border);
        }
        img {
            display: block;
            width: auto;
            height: auto;
            max-width: none;
            max-height: none;
            user-select: none;
        }
        @media (max-width: 520px) {
            .toolbar {
                align-items: stretch;
                flex-direction: column;
            }
            .meta, .actions {
                justify-content: space-between;
            }
            .name {
                max-width: 100%;
            }
        }
    </style>
</head>
<body>
    <header class="toolbar">
        <div class="meta">
            <span class="name" title="${escapeHtml(payload.filePath)}">${escapeHtml(payload.fileName)}</span>
            <span class="detail">${payload.width} x ${payload.height}</span>
            ${payload.fileSizeLabel ? `<span class="detail">${escapeHtml(payload.fileSizeLabel)}</span>` : ''}
        </div>
        <div class="actions">
            <div class="backgrounds" role="group" aria-label="Background">
                <button type="button" class="swatch" data-bg="black" title="Black background" aria-label="Black background"></button>
                <button type="button" class="swatch" data-bg="white" title="White background" aria-label="White background"></button>
                <button type="button" class="swatch active" data-bg="gray" title="Gray background" aria-label="Gray background"></button>
            </div>
            <button type="button" id="zoomOut" title="Zoom out" aria-label="Zoom out">-</button>
            <button type="button" id="fit" title="Fit" aria-label="Fit">Fit</button>
            <button type="button" id="actual" title="Actual size" aria-label="Actual size">1:1</button>
            <button type="button" id="zoomIn" title="Zoom in" aria-label="Zoom in">+</button>
            <span id="zoomLabel" class="zoom-label">100%</span>
        </div>
    </header>
    <main id="stage" class="stage" data-background="gray">
        <div class="surface">
            <img id="texture" src="${payload.dataUri}" alt="${escapeHtml(payload.fileName)}">
        </div>
    </main>
    <script nonce="${nonce}">
        const textureMeta = ${scriptPayload};
        const stage = document.getElementById('stage');
        const image = document.getElementById('texture');
        const zoomLabel = document.getElementById('zoomLabel');
        const backgroundButtons = Array.from(document.querySelectorAll('.swatch'));
        let zoom = 1;
        let fitMode = true;

        function clamp(value, min, max) {
            return Math.max(min, Math.min(max, value));
        }

        function applyZoom() {
            const width = Math.max(1, Math.round(textureMeta.width * zoom));
            image.style.width = width + 'px';
            image.style.height = 'auto';
            zoomLabel.textContent = Math.round(zoom * 100) + '%';
        }

        function setZoom(nextZoom, anchorEvent) {
            const previousZoom = zoom;
            const rect = stage.getBoundingClientRect();
            const anchorX = anchorEvent ? anchorEvent.clientX - rect.left : rect.width / 2;
            const anchorY = anchorEvent ? anchorEvent.clientY - rect.top : rect.height / 2;
            const scrollAnchorX = stage.scrollLeft + anchorX;
            const scrollAnchorY = stage.scrollTop + anchorY;

            zoom = clamp(nextZoom, 0.02, 16);
            applyZoom();

            if (previousZoom > 0 && previousZoom !== zoom) {
                const ratio = zoom / previousZoom;
                stage.scrollLeft = scrollAnchorX * ratio - anchorX;
                stage.scrollTop = scrollAnchorY * ratio - anchorY;
            }
        }

        function fitToStage() {
            const rect = stage.getBoundingClientRect();
            const xScale = (rect.width - 48) / textureMeta.width;
            const yScale = (rect.height - 48) / textureMeta.height;
            zoom = clamp(Math.min(1, xScale, yScale), 0.02, 16);
            applyZoom();
        }

        function setBackground(name) {
            stage.dataset.background = name;
            backgroundButtons.forEach(button => {
                button.classList.toggle('active', button.dataset.bg === name);
            });
        }

        document.getElementById('zoomOut').addEventListener('click', () => {
            fitMode = false;
            setZoom(zoom / 1.25);
        });
        document.getElementById('zoomIn').addEventListener('click', () => {
            fitMode = false;
            setZoom(zoom * 1.25);
        });
        document.getElementById('fit').addEventListener('click', () => {
            fitMode = true;
            fitToStage();
        });
        document.getElementById('actual').addEventListener('click', () => {
            fitMode = false;
            setZoom(1);
        });
        stage.addEventListener('wheel', event => {
            event.preventDefault();
            fitMode = false;
            const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
            setZoom(zoom * factor, event);
        }, { passive: false });
        backgroundButtons.forEach(button => {
            button.addEventListener('click', () => {
                if (button.dataset.bg) setBackground(button.dataset.bg);
            });
        });
        window.addEventListener('resize', () => {
            if (fitMode) fitToStage();
        });
        image.addEventListener('load', fitToStage, { once: true });
        setBackground('gray');
        if (image.complete) fitToStage();
    </script>
</body>
</html>`;
}

function renderErrorPreview(filePath: string): string {
    const nonce = getNonce();
    const fileName = path.basename(filePath);
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(fileName)}</title>
    <style nonce="${nonce}">
        html, body {
            height: 100%;
            margin: 0;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }
        body {
            display: grid;
            place-items: center;
            padding: 24px;
            box-sizing: border-box;
        }
        .message {
            max-width: 560px;
            text-align: center;
        }
        h1 {
            margin: 0 0 8px;
            font-size: 18px;
            font-weight: 600;
        }
        p {
            margin: 0;
            color: var(--vscode-descriptionForeground);
        }
        code {
            color: var(--vscode-textPreformat-foreground);
        }
    </style>
</head>
<body>
    <main class="message">
        <h1>Preview unavailable</h1>
        <p><code>${escapeHtml(fileName)}</code> is not a supported DDS/TGA texture or could not be decoded.</p>
    </main>
</body>
</html>`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    for (const unit of units) {
        if (value < 1024) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
        value /= 1024;
    }
    return `${value.toFixed(1)} TB`;
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, ch => {
        switch (ch) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#39;';
            default: return ch;
        }
    });
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}
