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
<div id="root"></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
