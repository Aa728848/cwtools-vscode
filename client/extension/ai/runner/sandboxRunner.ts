import type { ChildProcess, SpawnOptions } from 'child_process';

export interface SandboxSpawnRequest {
    command: string;
    args: string[];
    options: SpawnOptions;
    profile?: {
        sandboxMode?: string;
        networkAccess?: boolean;
    };
}

export interface SandboxRunner {
    spawn(request: SandboxSpawnRequest): ChildProcess;
}

export class DirectSandboxRunner implements SandboxRunner {
    constructor(private readonly spawnFn: typeof import('child_process').spawn) {}

    spawn(request: SandboxSpawnRequest): ChildProcess {
        return this.spawnFn(request.command, request.args, request.options);
    }
}
