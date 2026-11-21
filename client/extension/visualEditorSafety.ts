/**
 * Dirty-Buffer Safety Guards for Visual Editors (`.gui` and Global Ship Designs).
 *
 * Checks open `file://` documents with unsaved edits (`scheme === 'file' && isDirty`)
 * so AI file-write tools (`ai/tools/fileTools.ts`) and visual workbench hosts
 * (`guiSafety.ts`, `shipDesignPanel.ts`) refuse to silently overwrite dirty buffers.
 * Pure module (no vscode dependency).
 */

import * as path from 'path';

export interface VisualEditorDocumentState {
    uri: { scheme: string; fsPath: string };
    isDirty: boolean;
}

function normalizeDocumentPath(value: string, platform: NodeJS.Platform): string {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function findDirtyMatchingDocument<T extends VisualEditorDocumentState>(
    filePath: string,
    documents: readonly T[],
    platform: NodeJS.Platform,
): T | undefined {
    const target = normalizeDocumentPath(filePath, platform);
    return documents.find(document => document.uri.scheme === 'file'
        && document.isDirty
        && normalizeDocumentPath(document.uri.fsPath, platform) === target);
}

export function findDirtyGuiDocument<T extends VisualEditorDocumentState>(
    filePath: string,
    documents: readonly T[],
    platform: NodeJS.Platform = process.platform,
): T | undefined {
    return findDirtyMatchingDocument(filePath, documents, platform);
}

export function isGlobalShipDesignPath(filePath: string): boolean {
    const normalized = path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('.txt') && normalized.includes('/common/global_ship_designs/');
}

export function findDirtyShipDesignDocument<T extends VisualEditorDocumentState>(
    filePath: string,
    documents: readonly T[],
    platform: NodeJS.Platform = process.platform,
): T | undefined {
    return isGlobalShipDesignPath(filePath)
        ? findDirtyMatchingDocument(filePath, documents, platform)
        : undefined;
}
