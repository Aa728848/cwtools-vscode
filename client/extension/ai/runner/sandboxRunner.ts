import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { execFile } from 'child_process';

export type SandboxBackend = 'direct' | 'bubblewrap' | 'seatbelt' | 'windows-helper' | 'wsl-bubblewrap';

export interface SandboxSpawnRequest {
    command: string;
    args: string[];
    options: SpawnOptions;
    profile?: {
        sandboxMode?: string;
        networkAccess?: boolean;
        writableRoots?: string[];
        protectedPaths?: string[];
    };
}

export interface SandboxRunner {
    spawn(request: SandboxSpawnRequest): ChildProcess;
}

export class SandboxUnavailableError extends Error {
    constructor(public readonly platform: NodeJS.Platform) {
        super(`No enforced command sandbox is available for ${platform}. Retry with requestEscalation=true and unsandboxed=true only for an explicitly approved one-shot bypass.`);
        this.name = 'SandboxUnavailableError';
    }
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
    return candidates.find(candidate => !!candidate && fs.existsSync(candidate));
}

function windowsHelperPath(): string | undefined {
    return firstExisting([
        process.env.CWTOOLS_SANDBOX_HELPER,
        path.resolve(__dirname, '../../../../sandbox/cwtools-agent-sandbox.exe'),
    ]);
}

type DetectedSandboxBackend = { backend: SandboxBackend; executable?: string; distro?: string };
let cachedWindowsBackend: DetectedSandboxBackend | undefined | null;
let windowsBackendProbe: Promise<DetectedSandboxBackend | undefined> | undefined;

function detectWslBubblewrap(): Promise<DetectedSandboxBackend | undefined> {
    const wsl = firstExisting([
        process.env.CWTOOLS_WSL_PATH,
        process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'wsl.exe') : undefined,
        'C:\\Windows\\System32\\wsl.exe',
    ]);
    if (!wsl) return Promise.resolve(undefined);
    const distro = process.env.CWTOOLS_WSL_DISTRO?.trim() || undefined;
    const args = [...(distro ? ['--distribution', distro] : []), '--exec', 'sh', '-lc', 'command -v bwrap'];
    return new Promise(resolve => {
        execFile(wsl, args, { encoding: 'utf8', timeout: 4000, windowsHide: true }, (error, stdout) => {
            resolve(!error && /(?:^|\/)bwrap$/.test(String(stdout ?? '').trim())
                ? { backend: 'wsl-bubblewrap', executable: wsl, distro }
                : undefined);
        });
    });
}

function verifyWindowsHelper(): Promise<DetectedSandboxBackend | undefined> {
    const executable = windowsHelperPath();
    if (!executable) return Promise.resolve(undefined);
    return new Promise(resolve => {
        execFile(executable, ['--self-test', '--format', 'json'], { encoding: 'utf8', timeout: 4000, windowsHide: true }, (error, stdout) => {
            if (error) return resolve(undefined);
            try {
                const result = JSON.parse(String(stdout ?? '')) as Record<string, unknown>;
                resolve(result.protocolVersion === 1
                    && result.sandbox === true
                    && result.filesystem === 'enforced'
                    && result.network === 'allow-deny'
                    ? { backend: 'windows-helper', executable }
                    : undefined);
            } catch {
                resolve(undefined);
            }
        });
    });
}

export function detectSandboxBackend(platform = process.platform): DetectedSandboxBackend | undefined {
    if (platform === 'linux') {
        const executable = firstExisting([process.env.CWTOOLS_BWRAP_PATH, '/usr/bin/bwrap', '/bin/bwrap']);
        return executable ? { backend: 'bubblewrap', executable } : undefined;
    }
    if (platform === 'darwin') {
        const executable = firstExisting([process.env.CWTOOLS_SANDBOX_EXEC_PATH, '/usr/bin/sandbox-exec']);
        return executable ? { backend: 'seatbelt', executable } : undefined;
    }
    if (platform === 'win32') {
        return cachedWindowsBackend ?? undefined;
    }
    return undefined;
}

/** Probe slower platform fallbacks without blocking the VS Code Extension Host. */
export async function detectSandboxBackendAsync(platform = process.platform): Promise<DetectedSandboxBackend | undefined> {
    const immediate = detectSandboxBackend(platform);
    if (immediate || platform !== 'win32') return immediate;
    if (cachedWindowsBackend === null) return undefined;
    if (!windowsBackendProbe) {
        windowsBackendProbe = verifyWindowsHelper().then(result => result ?? detectWslBubblewrap()).then(result => {
            cachedWindowsBackend = result ?? null;
            return result;
        }).finally(() => {
            windowsBackendProbe = undefined;
        });
    }
    return windowsBackendProbe;
}

/**
 * Runs commands through a separate broker. Enforced profiles fail closed when
 * the host has no verified OS sandbox backend; direct execution is used only
 * for Full Access or an explicitly approved one-shot `unsandboxed` bypass.
 */
export class BrokeredSandboxRunner implements SandboxRunner {
    constructor(private readonly spawnFn: typeof import('child_process').spawn) {}

    spawn(request: SandboxSpawnRequest): ChildProcess {
        if (request.profile?.sandboxMode === 'disabled') {
            return this.spawnFn(request.command, request.args, request.options);
        }
        const detected = detectSandboxBackend();
        if (!detected) throw new SandboxUnavailableError(process.platform);

        const brokerPath = path.join(__dirname, 'sandboxBroker.js');
        if (!fs.existsSync(brokerPath)) throw new Error(`Command sandbox broker is missing: ${brokerPath}`);
        const config = Buffer.from(JSON.stringify({
            backend: detected.backend,
            backendExecutable: detected.executable,
            command: request.command,
            args: request.args,
            cwd: request.options.cwd,
            writableRoots: request.profile?.writableRoots ?? [String(request.options.cwd ?? '')],
            protectedPaths: request.profile?.protectedPaths ?? [],
            networkAccess: request.profile?.networkAccess === true,
            distro: detected.distro,
            environment: Object.fromEntries(Object.entries(request.options.env ?? {})
                .filter(([key, value]) => value !== undefined && (/^CWT_/.test(key) || ['PYTHONUTF8', 'PYTHONIOENCODING', 'LC_ALL', 'LANG'].includes(key)))),
        }), 'utf8').toString('base64url');

        return this.spawnFn(process.execPath, [brokerPath, config], {
            ...request.options,
            env: {
                ...(request.options.env ?? process.env),
                ELECTRON_RUN_AS_NODE: '1',
            },
        });
    }
}

/** Kept for Full Access, one-shot unsandboxed execution, and compatibility tests. */
export class DirectSandboxRunner implements SandboxRunner {
    constructor(private readonly spawnFn: typeof import('child_process').spawn) {}
    spawn(request: SandboxSpawnRequest): ChildProcess {
        return this.spawnFn(request.command, request.args, request.options);
    }
}
