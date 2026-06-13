/**
 * Shell env allowlist (plan: Shell And External Process Sandbox).
 * Allowlist, not blacklist; per-platform baseline + user additions.
 */

export type EnvAllowlistMode = 'off' | 'log' | 'enforce';

const WINDOWS_BASELINE = [
    'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'OS',
    'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
    'PSMODULEPATH', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
];

const POSIX_BASELINE = [
    'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'LANG', 'TERM', 'USER', 'LOGNAME',
];

// Prefix allowances for toolchain runtime variables.
const PREFIX_BASELINE = ['DOTNET_', 'LC_', 'NODE_', 'NPM_CONFIG_', 'JAVA_', 'POWERSHELL_', 'VSCODE_'];

export interface SandboxedEnvResult {
    env: Record<string, string | undefined>;
    dropped: string[];
}

export function buildSandboxedEnv(
    fullEnv: Record<string, string | undefined>,
    options: { platform?: NodeJS.Platform; userAdditions?: string[] } = {}
): SandboxedEnvResult {
    const platform = options.platform ?? process.platform;
    const baseline = new Set((platform === 'win32' ? WINDOWS_BASELINE : POSIX_BASELINE).map(v => v.toUpperCase()));
    for (const extra of options.userAdditions ?? []) {
        if (typeof extra === 'string' && extra.trim()) baseline.add(extra.trim().toUpperCase());
    }
    const env: Record<string, string | undefined> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(fullEnv)) {
        const upper = key.toUpperCase();
        const allowed = baseline.has(upper)
            || PREFIX_BASELINE.some(prefix => upper.startsWith(prefix))
            || upper.startsWith('CWT_');
        if (allowed) env[key] = value;
        else dropped.push(key);
    }
    return { env, dropped };
}
