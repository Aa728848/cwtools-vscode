/**
 * Case-insensitive filesystem path resolution.
 *
 * Windows file systems are case-insensitive, so an exact `fs.existsSync` already
 * succeeds there and callers never reach this fallback. On Linux (case-sensitive)
 * and case-sensitive macOS volumes, Paradox asset references whose directory/file
 * case does not match the on-disk path would otherwise fail to resolve. This walks
 * the path segment-by-segment, matching each segment case-insensitively, and only
 * does any work when the exact path does not exist.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolve `absPath` tolerating case differences in directory/file segments.
 * Returns the real on-disk path, or `null` if no case-insensitive match exists.
 */
export function resolveCaseInsensitivePath(absPath: string): string | null {
    if (fs.existsSync(absPath)) return absPath;
    const segments = absPath.split(path.sep);
    // Start from the filesystem root: drive (e.g. "C:") on Windows, "" → "/" on POSIX.
    let current = segments[0]!.length ? segments[0]! + path.sep : path.sep;
    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i]!;
        if (!seg) continue;
        const exact = path.join(current, seg);
        if (fs.existsSync(exact)) { current = exact; continue; }
        let matched: string | undefined;
        try {
            const lower = seg.toLowerCase();
            const hit = fs.readdirSync(current, { withFileTypes: true })
                .find(e => e.name.toLowerCase() === lower);
            if (hit) matched = path.join(current, hit.name);
        } catch { return null; }
        if (!matched) return null;
        current = matched;
    }
    return fs.existsSync(current) ? current : null;
}
