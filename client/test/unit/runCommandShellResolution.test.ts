/**
 * Unit tests for run_command shell resolution (`resolveRunCommandShell`).
 * Probes are injected fakes — no real processes are spawned.
 */

import { expect } from 'chai';
import { externalTools } from './agentToolSafetyFixtures';

const { resolveRunCommandShell, __resetShellDetectionCacheForTests } = externalTools;

type ExecFileFn = typeof import('child_process').execFile;
type ProbeOutcome = { error?: Error; stdout?: string };

interface RecordedCall {
    file: string;
    args: string[];
}

function fakeExecFile(behavior: (file: string, args: string[]) => ProbeOutcome) {
    const calls: RecordedCall[] = [];
    const execFile = ((file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        calls.push({ file, args });
        const outcome = behavior(file, args);
        callback(outcome.error ?? null, outcome.stdout ?? '');
    }) as unknown as ExecFileFn;
    return { execFile, calls };
}

describe('run_command shell resolution', () => {
    beforeEach(() => {
        __resetShellDetectionCacheForTests();
    });

    it('resolves Windows auto to pwsh when PowerShell 7+ is installed', async () => {
        const { execFile, calls } = fakeExecFile(file => file === 'pwsh.exe' ? { stdout: '7\r\n' } : { error: new Error('not found') });
        const resolved = await resolveRunCommandShell('auto', 'win32', execFile);

        expect(resolved).to.deep.include({ exe: 'pwsh.exe', family: 'pwsh', loginShell: false, description: 'pwsh-7' });
        expect(resolved.fallbackNote).to.equal(undefined);
        // powershell.exe is never probed once pwsh wins.
        expect(calls.map(call => call.file)).to.deep.equal(['pwsh.exe']);
    });

    it('falls back to Windows PowerShell when the pwsh probe fails', async () => {
        const { execFile } = fakeExecFile(file => file === 'pwsh.exe'
            ? { error: new Error('spawn pwsh.exe ENOENT') }
            : { stdout: '5\r\n' });
        const resolved = await resolveRunCommandShell('auto', 'win32', execFile);

        expect(resolved).to.deep.include({ exe: 'powershell.exe', family: 'powershell', loginShell: false, description: 'powershell-5' });
        expect(resolved.fallbackNote).to.equal(undefined);
    });

    it('rejects a pwsh that reports a major version below 7', async () => {
        const { execFile } = fakeExecFile(file => file === 'pwsh.exe' ? { stdout: '5\r\n' } : { stdout: '5\r\n' });
        const resolved = await resolveRunCommandShell('auto', 'win32', execFile);

        expect(resolved.family).to.equal('powershell');
        expect(resolved.exe).to.equal('powershell.exe');
    });

    it('treats unparseable pwsh probe output as unavailable', async () => {
        const { execFile } = fakeExecFile(file => file === 'pwsh.exe' ? { stdout: 'garbage' } : { error: new Error('missing') });
        const resolved = await resolveRunCommandShell('auto', 'win32', execFile);

        expect(resolved).to.deep.include({ exe: 'powershell.exe', family: 'powershell', description: 'powershell' });
    });

    it('falls back with a bilingual note when explicit shell=pwsh is unavailable', async () => {
        const { execFile } = fakeExecFile(file => file === 'pwsh.exe'
            ? { error: new Error('spawn pwsh.exe ENOENT') }
            : { stdout: '5\r\n' });
        const resolved = await resolveRunCommandShell('pwsh', 'win32', execFile);

        expect(resolved).to.deep.include({ exe: 'powershell.exe', family: 'powershell', description: 'powershell-5' });
        expect(resolved.fallbackNote).to.be.a('string').and.to.include('shell=pwsh');
    });

    it('honors explicit shell=powershell without probing pwsh', async () => {
        const { execFile, calls } = fakeExecFile(() => ({ stdout: '5\r\n' }));
        const resolved = await resolveRunCommandShell('powershell', 'win32', execFile);

        expect(resolved).to.deep.include({ exe: 'powershell.exe', family: 'powershell', loginShell: false, description: 'powershell-5' });
        expect(calls.map(call => call.file)).to.deep.equal(['powershell.exe']);
    });

    it('resolves macOS/Linux auto to bash without sourcing a login profile', async () => {
        const { execFile } = fakeExecFile((file, args) => file === '/bin/sh' && args[1] === 'command -v bash'
            ? { stdout: '/usr/bin/bash\n' }
            : { error: new Error('unexpected probe') });
        const resolved = await resolveRunCommandShell('auto', 'linux', execFile);

        // loginShell=false: auto-resolved bash runs plain `-c`, keeping execution deterministic.
        expect(resolved).to.deep.include({ exe: 'bash', family: 'bash', loginShell: false, description: 'bash' });
    });

    it('falls back to /bin/sh on macOS/Linux when bash is missing', async () => {
        const { execFile } = fakeExecFile(() => ({ error: new Error('sh: command: not found') }));
        const resolved = await resolveRunCommandShell('auto', 'darwin', execFile);

        expect(resolved).to.deep.include({ exe: '/bin/sh', family: 'sh', loginShell: false, description: 'sh' });
    });

    it('keeps the historical login-shell invocation for explicit shell=bash', async () => {
        const { execFile, calls } = fakeExecFile(() => ({ error: new Error('must not probe') }));
        const resolved = await resolveRunCommandShell('bash', 'linux', execFile);

        expect(resolved).to.deep.include({ exe: 'bash', family: 'bash', loginShell: true, description: 'bash' });
        expect(calls).to.have.length(0);
    });

    it('keeps /bin/sh -c for explicit shell=sh without probing', async () => {
        const { execFile, calls } = fakeExecFile(() => ({ error: new Error('must not probe') }));
        const resolved = await resolveRunCommandShell('sh', 'darwin', execFile);

        expect(resolved).to.deep.include({ exe: '/bin/sh', family: 'sh', loginShell: false, description: 'sh' });
        expect(calls).to.have.length(0);
    });

    it('never selects cmd in any fallback chain', async () => {
        const { execFile } = fakeExecFile(() => ({ error: new Error('missing') }));
        for (const requested of ['auto', 'pwsh', 'powershell'] as const) {
            const resolved = await resolveRunCommandShell(requested, 'win32', execFile);
            expect(resolved.exe).to.not.match(/cmd/i);
        }
    });
});
