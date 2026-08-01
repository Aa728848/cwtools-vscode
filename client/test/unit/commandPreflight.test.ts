import { expect } from 'chai';

describe('CommandPreflight Unit Tests', () => {
    it('ranks safe commands as low risk (riskLevel <= 1)', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const result = preflightCommand('npm run compile');
        expect(result.riskLevel).to.be.at.most(1);
        expect(result.decision).to.equal('allow');
        expect(result.requiresEscalation).to.be.false;
    });

    it('identifies dangerous command chains and escalates to riskLevel 2 or 3', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        // Concatenation or redirection
        const resultChain = preflightCommand('npm run compile && rm -rf /');
        expect(resultChain.riskLevel).to.equal(3);
        expect(resultChain.requiresEscalation).to.be.true;

        // Interactive or destructive commands
        const resultRm = preflightCommand('rm -rf client');
        expect(resultRm.riskLevel).to.be.at.least(2);
        expect(resultRm.requiresEscalation).to.be.true;
    });

    it('correctly catches system sensitive operations', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const resultSensitive = preflightCommand('format C:');
        expect(resultSensitive.riskLevel).to.equal(3);
        expect(resultSensitive.requiresEscalation).to.be.true;
    });

    // ── 跨平台 POSIX 分类（采纳评审 #2：保守、不扩大自动执行面）──
    it('classifies unambiguous read-only POSIX utilities as low risk', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const cmd of ['stat foo.txt', 'cut -d, -f1 data.csv', 'realpath .', 'tree src', 'printenv PATH']) {
            const r = preflightCommand(cmd);
            expect(r.requiresPermission, cmd).to.be.false;
            expect(r.requiresEscalation, cmd).to.be.false;
        }
    });

    it('treats sed -i (in-place edit) as a write, not read-only', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const r = preflightCommand('sed -i s/a/b/ file.txt');
        expect(r.segments[0]!.classification).to.equal('write');
        expect(r.decision).to.equal('allow');
        expect(r.requiresPermission).to.be.false;
    });

    it('escalates find -delete and find -exec to destructive', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const del = preflightCommand('find . -name "*.tmp" -delete');
        expect(del.riskLevel).to.equal(3);
        expect(del.requiresEscalation).to.be.true;

        const exec = preflightCommand('find . -type f -exec rm {} +');
        expect(exec.riskLevel).to.equal(3);
        expect(exec.requiresEscalation).to.be.true;
    });

    it('catches force+recursive rm in any flag order', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const cmd of ['rm -fr build', 'rm -r -f build', 'rm --recursive --force build']) {
            const r = preflightCommand(cmd);
            expect(r.riskLevel, cmd).to.equal(3);
            expect(r.requiresEscalation, cmd).to.be.true;
        }
    });

    it('confines plain rm to the sandbox without escalation', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const r = preflightCommand('rm stale.txt');
        expect(r.decision).to.equal('allow');
        expect(r.requiresPermission).to.be.false;
        expect(r.requiresEscalation).to.be.false;
    });

    it('treats rm force forms as forbidden even without recursive flags', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const command of ['rm -f stale.txt', 'sudo rm -f stale.txt', 'env TEST=1 rm -rf stale']) {
            const result = preflightCommand(command);
            expect(result.decision, command).to.equal('forbidden');
            expect(result.requiresEscalation, command).to.equal(true);
        }
    });

    it('does not classify mutating Git subcommands as read-only', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const cmd of ['git branch -D feature', 'git tag -d v1', 'git remote set-url origin https://example.com/x', 'git config user.name agent', 'git diff --output=out.patch']) {
            const r = preflightCommand(cmd);
            expect(r.requiresPermission, cmd).to.be.true;
            expect(r.segments[0]!.classification, cmd).to.not.equal('readonly');
        }
    });

    it('keeps narrow Git listing forms read-only', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const cmd of ['git status', 'git branch --show-current', 'git branch -a', 'git tag --list', 'git remote -v', 'git config --get user.name']) {
            const r = preflightCommand(cmd);
            expect(r.requiresPermission, cmd).to.be.false;
            expect(r.segments[0]!.classification, cmd).to.equal('readonly');
        }
    });

    it('escalates Git actions that discard or rewrite local/remote history', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const command of [
            'git checkout -- src/file.ts',
            'git restore src/file.ts',
            'git stash drop',
            'git push --force origin main',
        ]) {
            const result = preflightCommand(command);
            expect(result.riskLevel, command).to.equal(3);
            expect(result.requiresEscalation, command).to.equal(true);
        }
    });

    it('does not auto-approve script blocks hidden behind read-only pipeline cmdlets', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const command of [
            'Get-Content file.txt | Where-Object { Remove-Item secret.txt; $_ }',
            'cat "$(rm file.txt)"',
            'Get-Content `"$(Write-Output path)`"',
        ]) {
            const result = preflightCommand(command);
            expect(result.decision, command).to.equal('prompt');
            expect(result.requiresPermission, command).to.equal(true);
            expect(result.segments.some(segment => segment.classification === 'interpreter'), command).to.equal(true);
        }
    });

    it('parses quoted operators without splitting them into commands', () => {
        const { parseShellCommandLine } = loadCommandPreflightModule();
        const parsed = parseShellCommandLine('rg "a|b && c" src | wc -l');
        expect(parsed.structured).to.equal(true);
        expect(parsed.segments).to.have.length(2);
        expect(parsed.segments[0]!.words).to.deep.equal(['rg', 'a|b && c', 'src']);
    });

    it('allows structured read-only pipelines but prompts for redirection and substitution', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        expect(preflightCommand('rg TODO client | wc -l').decision).to.equal('allow');
        expect(preflightCommand('rg TODO client > results.txt').decision).to.equal('prompt');
        expect(preflightCommand('echo $(pwd)').decision).to.equal('prompt');
    });

    it('does not let read-only Git classification hide complex shell syntax', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const command of [
            'git status > status.txt',
            'git status $(Remove-Item target.txt)',
            'git log "$(rm -f target.txt)"',
        ]) {
            const result = preflightCommand(command);
            expect(result.decision, command).to.equal('prompt');
            expect(result.opaqueExecution, command).to.equal(true);
            expect(result.segments[0]!.classification, command).to.equal('interpreter');
        }
    });

    it('recursively checks nested shell command bodies', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        expect(preflightCommand('bash -lc "ls | wc -l"').decision).to.equal('allow');
        expect(preflightCommand('bash -lc "rm -rf build"').decision).to.equal('forbidden');
        expect(preflightCommand('cmd /c "del /f generated.txt"').decision).to.equal('forbidden');
        expect(preflightCommand('powershell -EncodedCommand SQBFAFgA').decision).to.equal('prompt');
    });

    it('checks read-only tools for options that execute helpers', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const command of ['rg --pre processor TODO .', 'rg --search-zip TODO .']) {
            const result = preflightCommand(command);
            expect(result.decision, command).to.equal('prompt');
            expect(result.segments[0]!.classification, command).to.equal('interpreter');
        }
    });

    it('applies configurable token-prefix rules without weakening destructive protections', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        const forbidden = preflightCommand('npm publish', [{
            prefix: ['npm', 'publish'], decision: 'forbidden', justification: 'Publishing is disabled',
        }]);
        expect(forbidden.decision).to.equal('forbidden');
        expect(forbidden.riskLevel).to.equal(3);
        expect(forbidden.segments[0]!.reason).to.equal('Publishing is disabled');

        const broadInterpreterAllow = preflightCommand('python -c "print(1)"', [{ prefix: ['python'], decision: 'allow' }]);
        expect(broadInterpreterAllow.segments[0]!.matchedRule).to.equal(undefined);
        const absoluteBroadAllow = preflightCommand('/usr/bin/python -c "print(1)"', [{ prefix: ['/usr/bin/python'], decision: 'allow' }]);
        expect(absoluteBroadAllow.segments[0]!.matchedRule).to.equal(undefined);

        const destructive = preflightCommand('rm -rf build', [{ prefix: ['rm', '-rf'], decision: 'allow' }]);
        expect(destructive.decision).to.equal('forbidden');
    });

    it('requires approval for opaque inline and data-driven execution', () => {
        const { preflightCommand } = loadCommandPreflightModule();
        for (const command of [
            'python -c "print(1)"',
            'node --eval "console.log(1)"',
            'ruby -e "puts 1"',
            'xargs rm',
            'pwsh -Command Invoke-Expression',
            'bash -lc "xargs rm"',
        ]) {
            const result = preflightCommand(command);
            expect(result.decision, command).to.equal('prompt');
            expect(result.opaqueExecution, command).to.equal(true);
            expect(result.segments[0]!.classification, command).to.equal('interpreter');
        }
    });
});

function loadCommandPreflightModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return require('../../extension/ai/runner/commandPreflight') as typeof import('../../extension/ai/runner/commandPreflight');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [],
    },
};
