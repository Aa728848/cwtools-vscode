import * as vs from 'vscode';
import { getChatPanelHtml } from './chatHtml';

export function getAgentManagerHtml(webview: vs.Webview, extensionUri: vs.Uri): string {
    const managerCssUri = webview.asWebviewUri(
        vs.Uri.joinPath(extensionUri, 'bin', 'client', 'webview', 'agentManager.css')
    ).toString();

    return getChatPanelHtml(webview, extensionUri, {
        title: 'Agent Manager',
        bodyClass: 'chat-empty agent-manager-shell',
        extraStylesheets: [managerCssUri],
        scriptName: 'agentManager.js',
        surface: 'manager',
        layout: 'detached',
        enableCodexUi: true,
    });
}
