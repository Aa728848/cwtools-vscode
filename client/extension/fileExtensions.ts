/**
 * Cross-platform file-extension matching helpers.
 *
 * Neutral module with no vscode / Node-fs / AI-layer dependencies so that both
 * UI/preview modules (entityPanel, guiPanel, solarSystemPanel, graphicsFeatures,
 * locDecorations, extension) and AI tool modules (fileTools, lspTools) can reuse
 * it without creating a UI → AI-tools dependency edge.
 *
 * Why this exists: Windows file systems are case-insensitive, but Linux is
 * case-sensitive. Paradox ships assets with mixed-case extensions (e.g. `.DDS`,
 * `.TGA`), so a bare `name.endsWith('.dds')` silently misses them on Linux and
 * breaks previews. Always compare extensions through `matchesExt`.
 */

/** Graphics asset extensions handled by the previews (lowercase, with dot). */
export const GRAPHICS_EXTS = ['.dds', '.tga', '.png', '.jpg', '.jpeg', '.bmp'];

/**
 * Case-insensitive "does `name` end with `ext`" check.
 * Both sides are lowercased so `Foo.DDS` matches `.dds` on every platform.
 */
export function matchesExt(name: string, ext: string): boolean {
    return name.toLowerCase().endsWith(ext.toLowerCase());
}

/** True when `name` ends with any extension in `exts` (case-insensitive). */
export function matchesAnyExt(name: string, exts: readonly string[]): boolean {
    const lower = name.toLowerCase();
    return exts.some(ext => lower.endsWith(ext.toLowerCase()));
}

/**
 * Strip a trailing extension case-insensitively (e.g. `stripExt('city_room.DDS', '.dds')`
 * → `'city_room'`). Unlike `path.basename(name, ext)`, this matches regardless of case, so
 * uppercase Paradox asset extensions do not leak into derived names/identifiers.
 */
export function stripExt(name: string, ext: string): string {
    return name.toLowerCase().endsWith(ext.toLowerCase())
        ? name.slice(0, name.length - ext.length)
        : name;
}
