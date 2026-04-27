/**
 * VS Code Webview API — ambient declaration shared by all webview scripts.
 * Each webview file calls `acquireVsCodeApi()` to obtain the API object.
 */
interface VsCodeApi {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
