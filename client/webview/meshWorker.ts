/**
 * Web Worker for PDX Mesh parsing.
 * Runs parsePdxMesh in a separate thread to avoid blocking the Webview UI.
 *
 * Protocol:
 *   Main → Worker: { type: 'parse', buffer: ArrayBuffer, id: string }
 *   Worker → Main: { type: 'parsed', id: string, mesh: ParsedMeshFile }
 *                  { type: 'progress', id: string, percent: number }
 *                  { type: 'error', id: string, message: string }
 */

import { parsePdxMesh, type ParsedMeshFile } from './pdxMeshParser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(msg: any): void };

self.onmessage = (e: MessageEvent) => {
    const { type, buffer, id } = e.data;
    if (type !== 'parse' || !buffer || !id) return;

    try {
        const mesh: ParsedMeshFile = parsePdxMesh(
            buffer,
            (percent: number) => {
                self.postMessage({ type: 'progress', id, percent });
            },
        );
        self.postMessage({ type: 'parsed', id, mesh });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        self.postMessage({ type: 'error', id, message });
    }
};
