/**
 * Neutral path-scope helpers with no vscode / fs / AI-layer dependencies, so both UI
 * modules (entityPanel, …) and AI modules (workspaceSandbox, …) can share them without
 * creating a UI → AI dependency edge.
 *
 * Case folding is platform-conditional: Windows folds to lowercase (case-insensitive
 * filesystem), Linux/macOS keep case (case-sensitive), mirroring the real filesystem.
 */
import * as path from 'path';

/** Fold case only on Windows; keep original case on Linux/macOS. */
export function foldPathCase(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * True when `candidate` is inside, or equal to, `root`. Uses path.relative (not a string
 * prefix test) so `/repo-mod` does NOT match `/repo-mod-evil`, and folds case only on
 * Windows. This is the correct primitive for filesystem containment / sandbox checks.
 */
export function isPathInsideOrEqual(candidate: string, root: string): boolean {
    if (!root) return false;
    const normalizedCandidate = path.resolve(candidate);
    const normalizedRoot = path.resolve(root);
    const checkCandidate = foldPathCase(normalizedCandidate);
    const checkRoot = foldPathCase(normalizedRoot);
    const relative = path.relative(checkRoot, checkCandidate);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
