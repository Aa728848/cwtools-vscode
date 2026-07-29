import * as childProcess from 'child_process';
import { randomUUID } from 'crypto';

export interface LanguageServerProcessEvent {
	stage: 'spawned' | 'exited' | 'force-kill-start' | 'force-kill-complete';
	pid?: number;
	instanceId?: string;
	code?: number | null;
	signal?: NodeJS.Signals | null;
	reason?: string;
}

export interface LanguageServerProcessOptions {
	command: string;
	args?: string[];
	cwd?: string;
	onEvent?: (event: LanguageServerProcessEvent) => void;
}

interface TrackedProcess {
	process: childProcess.ChildProcess;
	instanceId: string;
}

export interface TrackedLanguageServerProcess {
	process: childProcess.ChildProcess;
	detached: boolean;
}

const PROCESS_EXIT_GRACE_MS = 500;

function isProcessAlive(process: childProcess.ChildProcess): boolean {
	if (!process.pid || process.exitCode !== null || process.signalCode !== null) return false;
	try {
		global.process.kill(process.pid, 0);
		return true;
	} catch {
		return false;
	}
}

function waitForExit(process: childProcess.ChildProcess, timeoutMs: number): Promise<void> {
	if (!isProcessAlive(process)) return Promise.resolve();
	return new Promise(resolve => {
		const timer = setTimeout(finish, timeoutMs);
		timer.unref?.();
		process.once('exit', finish);

		function finish(): void {
			clearTimeout(timer);
			process.removeListener('exit', finish);
			resolve();
		}
	});
}

async function runWindowsTreeKill(pid: number): Promise<void> {
	await new Promise<void>(resolve => {
		const killer = childProcess.spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
			stdio: 'ignore',
			windowsHide: true,
		});
		killer.once('error', () => resolve());
		killer.once('exit', () => resolve());
	});
}

export class LanguageServerProcessController {
	private tracked: TrackedProcess | undefined;

	constructor(private readonly options: LanguageServerProcessOptions) {}

	createServerOptions(): () => Promise<TrackedLanguageServerProcess> {
		return async () => {
			await this.terminateIfRunning(this.tracked?.process, 'replace-before-restart');
			const instanceId = randomUUID();
			const detached = global.process.platform !== 'win32';
			const serverProcess = childProcess.spawn(this.options.command, [...(this.options.args ?? []), '--stdio'], {
				cwd: this.options.cwd,
				env: {
					...global.process.env,
					CWTOOLS_SERVER_INSTANCE_ID: instanceId,
				},
				detached,
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});

			await new Promise<void>((resolve, reject) => {
				const onSpawn = (): void => {
					serverProcess.removeListener('error', onError);
					resolve();
				};
				const onError = (error: Error): void => {
					serverProcess.removeListener('spawn', onSpawn);
					reject(error);
				};
				serverProcess.once('spawn', onSpawn);
				serverProcess.once('error', onError);
			});

			this.tracked = { process: serverProcess, instanceId };
			this.options.onEvent?.({ stage: 'spawned', pid: serverProcess.pid, instanceId });
			serverProcess.once('exit', (code, signal) => {
				if (this.tracked?.process === serverProcess) this.tracked = undefined;
				this.options.onEvent?.({
					stage: 'exited',
					pid: serverProcess.pid,
					instanceId,
					code,
					signal,
				});
			});

			return { process: serverProcess, detached };
		};
	}

	captureCurrentProcess(): childProcess.ChildProcess | undefined {
		return this.tracked?.process;
	}

	async terminateIfRunning(process: childProcess.ChildProcess | undefined, reason: string): Promise<void> {
		if (!process || !isProcessAlive(process)) return;
		const tracked = this.tracked?.process === process ? this.tracked : undefined;
		this.options.onEvent?.({
			stage: 'force-kill-start',
			pid: process.pid,
			instanceId: tracked?.instanceId,
			reason,
		});

		const pid = process.pid;
		if (pid && global.process.platform === 'win32') {
			await runWindowsTreeKill(pid);
		} else if (pid) {
			try {
				global.process.kill(-pid, 'SIGTERM');
			} catch {
				try { process.kill('SIGTERM'); } catch { /* best effort */ }
			}
			await waitForExit(process, PROCESS_EXIT_GRACE_MS);
			if (isProcessAlive(process)) {
				try {
					global.process.kill(-pid, 'SIGKILL');
				} catch {
					try { process.kill('SIGKILL'); } catch { /* best effort */ }
				}
			}
		}

		await waitForExit(process, PROCESS_EXIT_GRACE_MS);
		if (isProcessAlive(process)) {
			try { process.kill('SIGKILL'); } catch { /* best effort */ }
			await waitForExit(process, PROCESS_EXIT_GRACE_MS);
		}
		if (this.tracked?.process === process) this.tracked = undefined;
		this.options.onEvent?.({
			stage: 'force-kill-complete',
			pid,
			instanceId: tracked?.instanceId,
			reason,
		});
	}
}
