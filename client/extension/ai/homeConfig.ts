import * as os from 'os';
import * as path from 'path';

/**
 * Single entry point for the user-level CWTools home directory (`~/.cwtools`).
 *
 * All home-scoped configuration — agent skills (`skills/`), MCP server files
 * (`mcp.json`), agent profiles (`agents/`) — must resolve through these
 * helpers so the location stays consistent across features and platforms.
 * Mirrors the user-level config convention of Kimi Code / Claude Code.
 */
export function getCwtoolsHomeDir(): string {
    return path.join(os.homedir(), '.cwtools');
}

/** Resolve a named subdirectory inside the CWTools home directory. */
export function getCwtoolsHomeSubdir(name: string): string {
    return path.join(getCwtoolsHomeDir(), name);
}
