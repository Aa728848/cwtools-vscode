import * as fs from 'fs';
import * as path from 'path';
import type { ChildProcess, SpawnOptions } from 'child_process';

export type SandboxBackend = 'direct' | 'bubblewrap' | 'seatbelt' | 'windows-helper';

export interface SandboxSpawnRequest {
    command: string;
    args: string[];
    options: SpawnOptions;
    profile?: {
        sandboxMode?: string;
        networkAccess?: boolean;
        writableRoots?: string[];
    };
}

export interface SandboxRunner {
    spawn(request: SandboxSpawnRequest): ChildProcess;
}

export class SandboxUnavailableError extends Error {
    constructor(public readonly platform: NodeJS.Platform) {
        super(`No enforced command sandbox is available for ${platform}. Retry with requestEscalation=true for an explicitly approved unsandboxed run.`);
        this.name = 'SandboxUnavailableError';
    }
}

function firstExisting(candidates: Array<string | undefined>): string | undefined {
    return candidates.find(candidate => !!candidate && fs.existsSync(candidate));
}

export function detectSandboxBackend(platform = process.platform): { backend: SandboxBackend; executable?: string } | undefined {
    if (platform === 'linux') {
        const executable = firstExisting([process.env.CWTOOLS_BWRAP_PATH, '/usr/bin/bwrap', '/bin/bwrap']);
        return executable ? { backend: 'bubblewrap', executable } : undefined;
    }
    if (platform === 'darwin') {
        const executable = firstExisting([process.env.CWTOOLS_SANDBOX_EXEC_PATH, '/usr/bin/sandbox-exec']);
        return executable ? { backend: 'seatbelt', executable } : undefined;
    }
    if (platform === 'win32') {
        const executable = firstExisting([
            process.env.CWTOOLS_SANDBOX_HELPER,
            path.resolve(__dirname, '../../../../sandbox/cwtools-agent-sandbox.exe'),
        ]);
        return executable ? { backend: 'windows-helper', executable } : undefined;
    }
    return undefined;
}

/**
 * Runs commands through a separate broker. Enforced profiles fail closed when
 * the host has no verified OS sandbox backend; direct execution is used only
 * for an explicit security bypass/escalation.
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
            networkAccess: request.profile?.networkAccess === true,
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

/** Kept for explicitly approved full-access execution and compatibility tests. */
export class DirectSandboxRunner implements SandboxRunner {
    constructor(private readonly spawnFn: typeof import('child_process').spawn) {}
    spawn(request: SandboxSpawnRequest): ChildProcess {
        return this.spawnFn(request.command, request.args, request.options);
    }
}
