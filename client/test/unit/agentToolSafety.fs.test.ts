import { expect } from 'chai';
import sinon from 'sinon';
import * as fs from 'fs';
import * as path from 'path';
import {
    GENERAL_WRITE,
    PARADOX_WRITE,
    LOCALIZATION_WRITE,
} from './schedulingFixtures';
import {
    FileToolHandler,
    AgentToolExecutor,
    makeWorkspace,
    cleanupWorkspace,
    makeContext,
    resetStubState,
    stubConfigOverrides,
    setStubConfigOverrides,
    getParadoxUserDataRoots,
    resetSandboxStorageForTesting,
    getAgentToolTargetFiles,
    SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS,
    TOOL_DEFINITIONS,
} from './agentToolSafetyFixtures';

describe('agent tool file path safety', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        workspaceRoot = makeWorkspace();
    });

    afterEach(() => {
        resetStubState();
        cleanupWorkspace(workspaceRoot);
    });

    function createFileHandler() {
        return new FileToolHandler({ workspaceRoot, fileWriteMode: 'auto' });
    }

    it('rejects git_ops file arguments outside the workspace before invoking git', async () => {
        fs.mkdirSync(path.join(workspaceRoot, '.git'));
        const handler = createFileHandler();
        const diff = await handler.gitOps({ action: 'diff', file: '../outside.txt' });
        const checkout = await handler.gitOps({ action: 'checkout', file: '../outside.txt' });
        expect(diff.success).to.equal(false);
        expect(diff.message).to.include('inside the workspace');
        expect(checkout.success).to.equal(false);
        expect(checkout.message).to.include('inside the workspace');
    });

    it('bypasses ReadTracker only for exact .cwtools path segments', async () => {
        const handler = createFileHandler();
        const rejectedContext = makeContext('topic-123');
        const rejectedCanWrite = sinon.stub().returns({ ok: false, reason: 'file was not read' });
        rejectedContext.agentRunner = {
            readTracker: { canWrite: rejectedCanWrite, markWritten: sinon.spy() },
        };

        const rejected = await handler.writeFile(
            { file: '.cwtools-evil/notes.md', content: 'must be read first' },
            rejectedContext,
        );

        expect(rejected.success).to.equal(false);
        expect(rejected.message).to.include('ReadTracker Blocked');
        expect(rejectedCanWrite.calledOnce).to.equal(true);

        const allowedContext = makeContext('topic-123');
        const allowedCanWrite = sinon.stub().returns({ ok: false, reason: 'file was not read' });
        allowedContext.agentRunner = {
            readTracker: { canWrite: allowedCanWrite, markWritten: sinon.spy() },
        };
        const allowed = await handler.writeFile(
            { file: '.cwtools/topic-123/notes.md', content: 'topic artifact' },
            allowedContext,
        );

        expect(allowed.success).to.equal(true);
        expect(allowedCanWrite.called).to.equal(false);
    });

    it('rejects absolute paths that only share the workspace path prefix', async () => {
        const handler = createFileHandler();
        const siblingRoot = `${workspaceRoot}-sibling`;
        fs.mkdirSync(siblingRoot, { recursive: true });
        try {
            const result = await handler.writeFile(
                { file: path.join(siblingRoot, 'outside.txt'), content: 'outside' },
                makeContext('topic-123'),
            );

            expect(result.success).to.equal(false);
            expect(result.message).to.include('outside the workspace root');
            expect(fs.existsSync(path.join(siblingRoot, 'outside.txt'))).to.equal(false);
        } finally {
            cleanupWorkspace(siblingRoot);
        }
    });

    it('rejects .yml writes through generic write tools', async () => {
        const handler = createFileHandler();
        const ctx = makeContext();
        const ymlRel = 'localisation/english/test_l_english.yml';
        const ymlAbs = path.join(workspaceRoot, ...ymlRel.split('/'));
        const original = 'l_english:\n old_key:0 "Old"\n';
        fs.mkdirSync(path.dirname(ymlAbs), { recursive: true });
        fs.writeFileSync(ymlAbs, original, 'utf8');

        const writeResult = await handler.writeFile({ file: ymlRel, content: 'l_english:\n old_key:0 "New"\n' }, ctx);
        expect(writeResult.success).to.equal(false);
        expect(writeResult.message).to.include('write_localisation');

        const editResult = await handler.editFile({
            filePath: ymlRel,
            oldString: ' old_key:0 "Old"',
            newString: ' old_key:0 "New"',
        }, ctx) as any;
        expect(editResult.success).to.equal(false);
        expect(editResult.message).to.include('write_localisation');

        expect(fs.readFileSync(ymlAbs, 'utf8')).to.equal(original);
    });

    it('lets General Coding write ordinary YAML and text without Paradox file gates', async () => {
        const handler = createFileHandler();
        const ctx = makeContext();
        ctx.runnerOptions.schedulingState = GENERAL_WRITE;

        const yamlRel = '.github/workflows/verify.yml';
        const yamlResult = await handler.writeFile({
            file: yamlRel,
            content: 'name: verify\non:\n  push:\n',
        }, ctx);
        expect(yamlResult.success).to.equal(true);
        const yamlBytes = fs.readFileSync(path.join(workspaceRoot, '.github', 'workflows', 'verify.yml'));
        expect(yamlBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))).to.equal(false);

        const textRel = 'fixtures/unbalanced-template.txt';
        const textResult = await handler.writeFile({
            file: textRel,
            content: 'literal template brace: {\n',
        }, ctx);
        expect(textResult.success).to.equal(true);
        expect(fs.readFileSync(path.join(workspaceRoot, 'fixtures', 'unbalanced-template.txt'), 'utf8'))
            .to.equal('literal template brace: {\n');
    });

    it('enforces UTF-8 without BOM for new PDXScript files even if utf8bom is requested', async () => {
        const handler = createFileHandler();
        const ctx = makeContext();
        ctx.runnerOptions.schedulingState = PARADOX_WRITE;

        const commonRel = 'common/traits/00_custom_traits.txt';
        const writeResult = await handler.writeFile({
            file: commonRel,
            content: 'trait_custom = {\n\tcost = 1\n}\n',
            encoding: 'utf8bom',
        }, ctx);
        expect(writeResult.success).to.equal(true);
        const fileBytes = fs.readFileSync(path.join(workspaceRoot, commonRel));
        expect(fileBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))).to.equal(false);
        expect(fileBytes.toString('utf8')).to.equal('trait_custom = {\n\tcost = 1\n}\n');

        // editFile also must not inject a BOM into a non-BOM file
        const editResult = await handler.editFile({
            filePath: commonRel,
            oldString: 'cost = 1',
            newString: 'cost = 2',
            encoding: 'utf8bom',
        }, ctx) as any;
        expect(editResult.success).to.equal(true);
        const editedBytes = fs.readFileSync(path.join(workspaceRoot, commonRel));
        expect(editedBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))).to.equal(false);
        expect(editedBytes.toString('utf8')).to.include('cost = 2');

        // If existing file has BOM, editing with encoding: 'utf8' strips the BOM
        const legacyBomFile = 'events/legacy_bom.txt';
        const legacyAbs = path.join(workspaceRoot, legacyBomFile);
        fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
        fs.writeFileSync(legacyAbs, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('namespace = test\n', 'utf8')]));

        const stripResult = await handler.editFile({
            filePath: legacyBomFile,
            oldString: 'namespace = test',
            newString: 'namespace = updated',
            encoding: 'utf8',
        }, ctx) as any;
        expect(stripResult.success).to.equal(true);
        const strippedBytes = fs.readFileSync(legacyAbs);
        expect(strippedBytes.subarray(0, 3).equals(Buffer.from([0xEF, 0xBB, 0xBF]))).to.equal(false);
        expect(strippedBytes.toString('utf8')).to.equal('namespace = updated\n');
    });

    it('serves targeted read_file context consistently across domains', async () => {
        const eventDir = path.join(workspaceRoot, 'events');
        fs.mkdirSync(eventDir, { recursive: true });
        const target = path.join(eventDir, 'sample.txt');
        fs.writeFileSync(target, 'sample = {\n}\n');
        const executor = new AgentToolExecutor({} as any, workspaceRoot);

        const general = await executor.execute('read_file', { file: target, centerLine: 0, radius: 1 }, {
            runnerOptions: { schedulingState: GENERAL_WRITE },
        } as any) as any;
        expect(general.content).to.include('sample = {');

        const paradox = await executor.execute('read_file', { file: target, centerLine: 0, radius: 1 }, {
            runnerOptions: { schedulingState: PARADOX_WRITE },
        } as any) as any;
        expect(paradox.content).to.equal(general.content);
    });

    it('marks read_file argument failures as failed tool results', async () => {
        const target = path.join(workspaceRoot, 'sample.txt');
        fs.writeFileSync(target, 'sample\n');

        const result = await createFileHandler().readFile({ file: target, centerLine: -1 });

        expect(result.error).to.include('centerLine must be a non-negative 0-based integer');
        expect(result.content).to.equal(result.error);
    });

    it('ignores zero range placeholders in a center-based read_file call', async () => {
        const target = path.join(workspaceRoot, 'large.txt');
        fs.writeFileSync(target, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));

        const result = await createFileHandler().readFile({
            file: target,
            startLine: 0,
            endLine: 0,
            centerLine: 9,
            radius: 1,
        });

        expect(result.content).to.include('9 | line 9');
        expect(result.content).to.include('11 | line 11');
        expect(result.content).to.not.include('12 | line 12');
    });

    it('ignores provider minimum-range placeholders in a center-based read_file call', async () => {
        const target = path.join(workspaceRoot, 'large.txt');
        fs.writeFileSync(target, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));

        const result = await createFileHandler().readFile({
            file: target,
            startLine: 1,
            endLine: 1,
            centerLine: 9,
            radius: 1,
        });

        expect(result.content).to.include('9 | line 9');
        expect(result.content).to.include('11 | line 11');
        expect(result.content).to.not.include('12 | line 12');
    });

    it('prefers an explicit range over conflicting read_file center defaults', async () => {
        const target = path.join(workspaceRoot, 'large.txt');
        fs.writeFileSync(target, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));

        const result = await createFileHandler().readFile({
            file: target,
            startLine: 9,
            endLine: 11,
            centerLine: 0,
            radius: 20,
        });

        expect(result.content).to.include('9 | line 9');
        expect(result.content).to.include('11 | line 11');
        expect(result.content).to.not.include('12 | line 12');
    });

    it('ignores zero window placeholders in a range-based read_file call', async () => {
        const target = path.join(workspaceRoot, 'large.txt');
        fs.writeFileSync(target, Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n'));

        const result = await createFileHandler().readFile({
            file: target,
            startLine: 9,
            endLine: 11,
            centerLine: 0,
            radius: 0,
        });

        expect(result.content).to.include('9 | line 9');
        expect(result.content).to.include('11 | line 11');
        expect(result.content).to.not.include('12 | line 12');
    });

    it('allows reading arbitrary local external files in Antigravity model and blocks sensitive credentials', async () => {
        const configuredRoot = makeWorkspace();
        const otherRoot = makeWorkspace();
        const vanillaFile = path.join(configuredRoot, 'common', 'game_rules', '00_rules.txt');
        const otherFile = path.join(otherRoot, 'outside.txt');
        const sshKeyFile = path.join(otherRoot, '.ssh', 'id_rsa');
        fs.mkdirSync(path.dirname(vanillaFile), { recursive: true });
        fs.mkdirSync(path.dirname(sshKeyFile), { recursive: true });
        fs.writeFileSync(vanillaFile, 'vanilla_rule = yes\n');
        fs.writeFileSync(otherFile, 'outside content\n');
        fs.writeFileSync(sshKeyFile, 'secret_rsa_key\n');
        stubConfigOverrides['cache.stellaris'] = configuredRoot;

        try {
            const handler = createFileHandler();
            const vanilla = await handler.readFile({ file: vanillaFile });
            const outside = await handler.readFile({ file: otherFile });
            const blocked = await handler.readFile({ file: sshKeyFile });

            expect(vanilla.content).to.include('vanilla_rule = yes');
            expect(outside.content).to.include('outside content');
            expect(blocked.content).to.include('outside the workspace and configured game directories');
        } finally {
            cleanupWorkspace(configuredRoot);
            cleanupWorkspace(otherRoot);
        }
    });

    it('applies Antigravity read model to file-scoped read tools and protects credentials', async () => {
        const configuredRoot = makeWorkspace();
        const otherRoot = makeWorkspace();
        const vanillaFile = path.join(configuredRoot, 'common', 'game_rules', '00_rules.txt');
        const otherFile = path.join(otherRoot, 'outside.txt');
        const sshKeyFile = path.join(otherRoot, '.ssh', 'id_rsa');
        fs.mkdirSync(path.dirname(vanillaFile), { recursive: true });
        fs.mkdirSync(path.dirname(sshKeyFile), { recursive: true });
        fs.writeFileSync(vanillaFile, 'vanilla_rule = yes\n');
        fs.writeFileSync(otherFile, 'outside_rule = yes\n');
        fs.writeFileSync(sshKeyFile, 'secret_key\n');
        stubConfigOverrides['cache.stellaris'] = configuredRoot;

        try {
            const executor = new AgentToolExecutor({} as any, workspaceRoot);
            const allowedVanilla = await executor.execute('document_symbols', { file: vanillaFile }, makeContext());
            const allowedOutside = await executor.execute('document_symbols', { file: otherFile }, makeContext());
            const blockedCredential = await executor.execute('document_symbols', { file: sshKeyFile }, makeContext()) as any;

            expect(allowedVanilla).to.have.property('symbols');
            expect(allowedOutside).to.have.property('symbols');
            expect(blockedCredential.success).to.equal(false);
            expect(blockedCredential.error).to.include('outside the workspace and configured game directories');
        } finally {
            cleanupWorkspace(configuredRoot);
            cleanupWorkspace(otherRoot);
        }
    });

    it('allows reads under globalStorage cache directories (e.g. .cwtools/stellaris)', async () => {
        const globalStorageDir = makeWorkspace();
        const cachedRulesFile = path.join(
            globalStorageDir,
            '.cwtools',
            'stellaris',
            'common',
            'global_ship_designs',
            'event_ship_designs_shroud.txt'
        );
        fs.mkdirSync(path.dirname(cachedRulesFile), { recursive: true });
        fs.writeFileSync(cachedRulesFile, 'event_ship_design = { name = "NAME_Shroud" }\n');

        try {
            const executor = new AgentToolExecutor({} as any, workspaceRoot, undefined, globalStorageDir);
            const handler = createFileHandler();
            const readResult = await handler.readFile({ file: cachedRulesFile });
            expect(readResult.content).to.include('event_ship_design = { name = "NAME_Shroud" }');

            const symbolsResult = await executor.execute('document_symbols', { file: cachedRulesFile }, makeContext());
            expect(symbolsResult).to.have.property('symbols');
        } finally {
            cleanupWorkspace(globalStorageDir);
        }
    });

    it('allows reads under custom rules_folder configuration', async () => {
        const customRulesDir = makeWorkspace();
        const ruleFile = path.join(customRulesDir, 'common', 'game_rules', 'custom_rules.txt');
        fs.mkdirSync(path.dirname(ruleFile), { recursive: true });
        fs.writeFileSync(ruleFile, 'custom_rule = yes\n');
        stubConfigOverrides['rules_folder'] = customRulesDir;

        try {
            const handler = createFileHandler();
            const readResult = await handler.readFile({ file: ruleFile });
            expect(readResult.content).to.include('custom_rule = yes');
        } finally {
            cleanupWorkspace(customRulesDir);
        }
    });

    it('strictly denies outside-workspace writes regardless of approval mode', async () => {
        const outsideDir = makeWorkspace();
        const outsideFile = path.join(outsideDir, 'external_config.txt');
        fs.writeFileSync(outsideFile, 'initial = 1\n');

        try {
            const handler = createFileHandler();

            const result = await handler.writeFile({
                file: outsideFile,
                content: 'new content',
            }, {
                reviewerMode: 'auto_review',
                onPermissionRequest: async () => true,
            } as any);
            expect(result.success).to.equal(false);
            expect(result.message).to.include('Cannot write outside the workspace root');
            expect(fs.readFileSync(outsideFile, 'utf8')).to.equal('initial = 1\n');
        } finally {
            cleanupWorkspace(outsideDir);
        }
    });

    it('derives expected Paradox Interactive user data roots across platforms', () => {
        const winRoots = getParadoxUserDataRoots('win32', 'C:\\Users\\TestUser', {
            USERPROFILE: 'C:\\Users\\TestUser',
            OneDrive: 'C:\\Users\\TestUser\\OneDrive',
        } as any);
        expect(winRoots).to.include(path.win32.resolve('C:\\Users\\TestUser\\Documents\\Paradox Interactive'));
        expect(winRoots).to.include(path.win32.resolve('C:\\Users\\TestUser\\OneDrive\\Documents\\Paradox Interactive'));

        const linuxRoots = getParadoxUserDataRoots('linux', '/home/testuser', {} as any);
        expect(linuxRoots).to.include(path.posix.resolve('/home/testuser/.local/share/Paradox Interactive'));
        expect(linuxRoots).to.include(path.posix.resolve('/home/testuser/.paradoxinteractive'));

        const macRoots = getParadoxUserDataRoots('darwin', '/Users/testuser', {} as any);
        expect(macRoots).to.include(path.posix.resolve('/Users/testuser/Documents/Paradox Interactive'));
        expect(macRoots).to.include(path.posix.resolve('/Users/testuser/Library/Application Support/Paradox Interactive'));
    });

    it('rejects writes to globalStorage and auxiliary readable paths', async () => {
        const globalStorageDir = makeWorkspace();
        const targetFile = path.join(globalStorageDir, '.cwtools', 'stellaris', 'test_write.txt');
        fs.mkdirSync(path.dirname(targetFile), { recursive: true });

        try {
            const executor = new AgentToolExecutor({} as any, workspaceRoot, undefined, globalStorageDir);
            const handler = createFileHandler();
            const result = await handler.writeFile({
                file: targetFile,
                content: 'should be blocked',
            });
            expect(result.success).to.equal(false);
            expect(result.message).to.include('outside the workspace root');
        } finally {
            cleanupWorkspace(globalStorageDir);
        }
    });

    it('falls back to structural symbols for an external vanilla PDX file', async () => {

        const configuredRoot = makeWorkspace();
        const vanillaFile = path.join(configuredRoot, 'common', 'game_rules', '00_rules.txt');
        fs.mkdirSync(path.dirname(vanillaFile), { recursive: true });
        fs.writeFileSync(vanillaFile, [
            'first_rule = {',
            '    potential = { always = yes }',
            '}',
            'can_generate_leader_from_species = {',
            '    possible = { is_species_class = BIOLOGICAL }',
            '}',
        ].join('\n'));
        stubConfigOverrides['cache.stellaris'] = configuredRoot;

        try {
            const executor = new AgentToolExecutor({} as any, workspaceRoot);
            const symbols = await executor.execute('document_symbols', { file: vanillaFile }, makeContext()) as any;
            const block = await executor.execute('get_pdx_block', {
                file: vanillaFile,
                symbol: 'can_generate_leader_from_species',
            }, makeContext()) as any;

            expect(symbols.symbols.map((symbol: any) => symbol.name)).to.deep.equal([
                'first_rule',
                'can_generate_leader_from_species',
            ]);
            expect(block.content).to.include('possible = { is_species_class = BIOLOGICAL }');
            expect(block.startLine).to.equal(4);
            expect(block.endLine).to.equal(6);
        } finally {
            cleanupWorkspace(configuredRoot);
        }
    });

    it('applies edit_file replacements through the shared fuzzy replacer', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'notes.md');
        fs.writeFileSync(fileAbs, '  old title  \n  old body  \n', 'utf8');

        const result = await handler.editFile({
            filePath: fileAbs,
            oldString: 'old title\nold body',
            newString: 'new title\nnew body',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('new title\nnew body\n');
        expect(result.stats.linesAdded).to.equal(0);
        expect(result.stats.linesRemoved).to.equal(0);
    });

    it('replaces an explicit line range with replace_lines', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'test_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'line one\nold a\nold b\nline four', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            newContent: 'new a\nnew b',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('line one\nnew a\nnew b\nline four');
    });

    it('guards replace_lines with expectedContent to avoid stale line-range edits', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'guarded_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'line one\nchanged a\nold b\nline four', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            expectedContent: 'old a\nold b',
            newContent: 'new a\nnew b',
        }, makeContext()) as any;

        expect(result.success).to.equal(false);
        expect(result.message).to.include('safety check failed');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal('line one\nchanged a\nold b\nline four');
    });

    it('allows guarded replace_lines when expected anchors still match', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'anchored_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = old.1\n\tis_triggered_only = yes\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            expectedStartText: 'id = old.1',
            expectedEndText: 'is_triggered_only = yes',
            newContent: '\tid = new.1\n\tis_triggered_only = yes',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = new.1');
    });

    it('rejects replace_lines for .yml localisation files', async () => {
        const handler = createFileHandler();
        const ymlRel = 'localisation/english/test_l_english.yml';
        const ymlAbs = path.join(workspaceRoot, ...ymlRel.split('/'));
        const original = 'l_english:\n old_key:0 "Old"\n';
        fs.mkdirSync(path.dirname(ymlAbs), { recursive: true });
        fs.writeFileSync(ymlAbs, original, 'utf8');

        const result = await handler.replaceLines({
            filePath: ymlRel,
            startLine: 2,
            endLine: 2,
            newContent: ' old_key:0 "New"',
        }, makeContext()) as any;

        expect(result.success).to.equal(false);
        expect(result.message).to.include('write_localisation');
        expect(fs.readFileSync(ymlAbs, 'utf8')).to.equal(original);
    });

    it('rejects generic PDX edits that would unbalance brace structure', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'common', 'buildings', 'guarded_buildings.txt');
        const original = 'building_guarded = {\n\tcost = { minerals = 100 }\n}\n';
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, original, 'utf8');

        const writeResult = await handler.writeFile({
            file: fileAbs,
            content: 'building_guarded = {\n\tcost = { minerals = 200 }\n',
        }, makeContext()) as any;
        expect(writeResult.success).to.equal(false);
        expect(writeResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

        const replaceResult = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 3,
            endLine: 3,
            newContent: '',
        }, makeContext()) as any;
        expect(replaceResult.success).to.equal(false);
        expect(replaceResult.message).to.include('PDX brace structure');
        expect(fs.readFileSync(fileAbs, 'utf8')).to.equal(original);

    });

    it('ignores PDX brace-like text in strings and comments during edit safety checks', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'string_braces_events.txt');
        const original = 'country_event = {\n\ttitle = "old { title }"\n\t# } comment brace\n}\n';
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, original, 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 3,
            newContent: '\ttitle = "new } title {"\n\t# { comment brace',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('title = "new } title {"');
    });

    it('rejects write_localisation targets outside real localisation folders', async () => {
        const handler = createFileHandler();
        const result = await handler.writeLocalisation({
            filePath: '.cwtools/scratch/bad_l_english.yml',
            language: 'l_english',
            entries: [{ key: 'bad_key', value: 'Bad' }],
        }, makeContext('topic-123'));

        expect(result.success).to.equal(false);
        expect(result.message).to.include('Localisation files must be written under');
        const rejectedPath = path.join(workspaceRoot, '.cwtools', 'topic-123', 'scratch', 'bad_l_english.yml');
        expect(fs.existsSync(rejectedPath)).to.equal(false);
    });

    it('writes localisation entries into an explicit multi-file language transaction', async () => {
        const handler = createFileHandler();
        fs.mkdirSync(path.join(workspaceRoot, 'localisation', 'english'), { recursive: true });
        const base = path.join('localisation', 'english', 'samplemod_events_l_english.yml');
        const result = await handler.writeLocalisation({
            filePath: base,
            language: 'l_english',
            languages: ['l_english', 'l_simp_chinese'],
            entries: [{ key: 'samplemod.1.title', value: 'SampleMod Echo' }],
        }, makeContext('topic-123'));
        expect(result.success).to.equal(true);
        const englishPath = path.join(workspaceRoot, 'localisation', 'english', 'samplemod_events_l_english.yml');
        const chinesePath = path.join(workspaceRoot, 'localisation', 'simp_chinese', 'samplemod_events_l_simp_chinese.yml');
        expect(fs.existsSync(englishPath)).to.equal(true);
        expect(fs.existsSync(chinesePath)).to.equal(true);
        expect(fs.readFileSync(englishPath, 'utf8')).to.include('samplemod.1.title');
        expect(fs.readFileSync(chinesePath, 'utf8')).to.include('samplemod.1.title');
    });

    it('rolls back every language when a multi-file localisation write fails', async () => {
        const handler = createFileHandler();
        const englishPath = path.join(workspaceRoot, 'localisation', 'english', 'rollback_l_english.yml');
        const chinesePath = path.join(workspaceRoot, 'localisation', 'simp_chinese', 'rollback_l_simp_chinese.yml');
        fs.mkdirSync(path.dirname(englishPath), { recursive: true });
        fs.mkdirSync(path.dirname(chinesePath), { recursive: true });
        const englishOriginal = '\uFEFFl_english:\n old_key:0 "Old"\n';
        const chineseOriginal = '\uFEFFl_simp_chinese:\n old_key:0 "旧"\n';
        fs.writeFileSync(englishPath, englishOriginal, 'utf8');
        fs.writeFileSync(chinesePath, chineseOriginal, 'utf8');
        const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
        let injected = false;
        const writeStub = sinon.stub(fs.promises, 'writeFile').callsFake(async (target: any, data: any, options: any) => {
            if (!injected && path.resolve(String(target)) === path.resolve(chinesePath) && String(data).includes('new_key')) {
                injected = true;
                throw new Error('injected second-language failure');
            }
            return originalWriteFile(target, data, options as any);
        });
        try {
            const result = await handler.writeLocalisation({
                filePath: path.relative(workspaceRoot, englishPath),
                language: 'l_english',
                languages: ['l_english', 'l_simp_chinese'],
                entries: [{ key: 'new_key', value: 'New' }],
            }, makeContext('topic-rollback'));
            expect(result.success).to.equal(false);
            expect(result.message).to.include('rolled back');
            expect(fs.readFileSync(englishPath, 'utf8')).to.equal(englishOriginal);
            expect(fs.readFileSync(chinesePath, 'utf8')).to.equal(chineseOriginal);
        } finally {
            writeStub.restore();
        }
    });

    it('preserves multi-file localisation authorization failures and writes nothing', async () => {
        const handler = createFileHandler();
        const english = path.join(workspaceRoot, 'localisation', 'english', 'auth_l_english.yml');
        const chinese = path.join(workspaceRoot, 'localisation', 'simp_chinese', 'auth_l_simp_chinese.yml');
        fs.mkdirSync(path.dirname(english), { recursive: true });
        fs.mkdirSync(path.dirname(chinese), { recursive: true });
        fs.writeFileSync(english, '\uFEFFl_english:\n key:0 "Old"\n', 'utf8');
        fs.writeFileSync(chinese, '\uFEFFl_simp_chinese:\n key:0 "Old Chinese"\n', 'utf8');
        const context = makeContext();
        context.agentRunner = {
            readTracker: {
                canWrite: sinon.stub().returns({ ok: false, reason: 'file was not read' }),
                markWritten: sinon.spy(),
            },
        };

        const result = await handler.writeLocalisation({
            filePath: english,
            language: 'l_english',
            languages: ['l_english', 'l_simp_chinese'],
            entries: [{ key: 'key', value: 'New' }],
        }, context);

        expect(result.success).to.equal(false);
        expect(result.message).to.include('authorization failed for l_english');
        expect(result.message).to.include('ReadTracker Blocked');
        expect(fs.readFileSync(english, 'utf8')).to.include('Old');
        expect(fs.readFileSync(chinese, 'utf8')).to.include('Old Chinese');
    });

    it('rejects a multi-file transaction when the primary file is outside localisation folders', async () => {
        const handler = createFileHandler();
        const result = await handler.writeLocalisation({
            filePath: '.cwtools/scratch/samplemod_events_l_english.yml',
            language: 'l_english',
            languages: ['l_english', 'l_simp_chinese'],
            entries: [{ key: 'samplemod.1.title', value: 'SampleMod Echo' }],
        }, makeContext('topic-123'));
        expect(result.success).to.equal(false);
        expect(result.message).to.include('multi-file transaction rejected');
    });

    it('reports list_directory truncation metadata without claiming a full total', async () => {
        const handler = createFileHandler();
        const dirAbs = path.join(workspaceRoot, 'many-files');
        fs.mkdirSync(dirAbs, { recursive: true });
        for (let i = 0; i < 205; i++) {
            fs.writeFileSync(path.join(dirAbs, `file-${String(i).padStart(3, '0')}.txt`), 'x', 'utf8');
        }

        const result = await handler.listDirectory({ directory: dirAbs });

        expect(result.entries).to.have.length(200);
        expect(result.truncated).to.equal(true);
        expect(result.hasMore).to.equal(true);
        expect(result.returnedCount).to.equal(200);
        expect(result.limit).to.equal(200);
        expect(result).to.not.have.property('total');
    });

    it('extracts write target paths for runner scheduling without marking localisation as superseded', () => {
        expect(getAgentToolTargetFiles('write_localisation', {
            filePath: 'localisation/english/samplemod_l_english.yml',
            languages: ['l_english', 'l_simp_chinese'],
        }, workspaceRoot)).to.deep.equal([
            path.join(workspaceRoot, 'localisation', 'english', 'samplemod_l_english.yml'),
            path.join(workspaceRoot, 'localisation', 'simp_chinese', 'samplemod_l_simp_chinese.yml'),
        ]);
        expect(getAgentToolTargetFiles('replace_lines', { filePath: 'common/scripted_effects/samplemod.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'common', 'scripted_effects', 'samplemod.txt')]);
        expect(getAgentToolTargetFiles('write_file', { file: 'common/relics/samplemod.txt' }, workspaceRoot))
            .to.deep.equal([path.join(workspaceRoot, 'common', 'relics', 'samplemod.txt')]);
        expect(getAgentToolTargetFiles('write_design_blueprint', {}, workspaceRoot, 'topic-123'))
            .to.deep.equal([
                path.join(workspaceRoot, '.cwtools', 'topic-123', 'Implementation_Plan.md'),
            ]);

        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_file')).to.equal(true);
        expect(SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS.has('write_localisation')).to.equal(false);
    });

    it('keeps blueprint detail behind one deferred write tool', () => {
        const tool = TOOL_DEFINITIONS.find(def => def.function.name === 'write_design_blueprint');
        const contractTool = TOOL_DEFINITIONS.find(def => def.function.name === 'get_design_blueprint_contract');
        const required = tool?.function.parameters.required ?? [];

        expect(contractTool).to.equal(undefined);
        expect(required).to.deep.equal(['blueprint']);
        expect(JSON.stringify(tool).length).to.be.lessThan(1_500);
    });

    it('saves and submits a sparse model-authored blueprint without a host completeness gate', async () => {
        const handler = createFileHandler();
        const result = await handler.writeDesignBlueprint({
            title: 'Incomplete Chain',
            entities: [{ id: 'test.1', type: 'country_event', file: 'events/test.txt' }],
            dependencyOrder: ['events/test.txt'],
        } as any, makeContext('topic-blueprint'));

        expect(result.success).to.equal(true);
        expect(result.approvalReady).to.equal(true);
        expect(result.message).to.include('submitted for approval');
        const content = fs.readFileSync(path.join(workspaceRoot, '.cwtools', 'topic-blueprint', 'Implementation_Plan.md'), 'utf8');
        expect(content).to.include('## Blueprint Self-Check (Advisory)');
        expect(content).to.include('Semantic evidence: not supplied (optional)');
        expect(content).to.not.include('## Executable Feature Relationship Contract');
        expect(content).to.not.include('## Approved Multi-Agent Task DAG');
    });

    it('saves a partial blueprint as an incremental draft', async () => {
        const handler = createFileHandler();
        const result = await handler.writeDesignBlueprint({
            title: 'Partial Chain',
            entities: [{ id: 'test.1', type: 'country_event', file: 'events/test.txt' }],
            unresolvedCritical: ['Choose the trigger mechanism.'],
        }, makeContext('topic-blueprint'));

        expect(result.success).to.equal(true);
        expect(result.approvalReady).to.equal(false);
        const content = fs.readFileSync(result.filePath, 'utf8');
        expect(content).to.include('Choose the trigger mechanism.');
        expect(content).to.not.include('```cwtools-blueprint');
        expect(content).to.include('```cwtools-plan');
        const draftContract = JSON.parse(content.match(/```cwtools-plan\n([\s\S]*?)\n```/)?.[1] ?? '{}');
        expect(draftContract.status).to.equal('draft');
        expect(draftContract.blueprint.unresolvedCritical).to.deep.equal(['Choose the trigger mechanism.']);
    });

    it('writes detailed design blueprints with an advisory self-check', async () => {
        const handler = createFileHandler();
        const result = await handler.writeDesignBlueprint({
            title: 'Native Hook Event Chain',
            entities: [{
                id: 'test.1',
                type: 'country_event',
                file: 'events/test.txt',
                triggeredBy: 'common/on_actions yearly pulse',
                fires: ['test_reward via owner country scope'],
                scopeContext: 'this=country root=country',
            }],
            commonDirectoryReview: [
                {
                    directory: 'common/on_actions',
                    role: 'entry hook',
                    candidateTypes: ['on_action'],
                    selected: true,
                    rationale: 'Native yearly hook matches the requested entry point.',
                    findings: 'CWT/LSP on_action evidence confirms country pulse hook support.',
                },
                {
                    directory: 'common/situations',
                    role: 'progression anchor',
                    candidateTypes: ['situation'],
                    selected: false,
                    rationale: 'The request does not need long-running UI progression.',
                    findings: 'list_directory("common") found situations, but archetype role is too heavy for this flow.',
                },
            ],
            subsystemPlan: [{
                layer: 'hooks',
                directories: ['common/on_actions'],
                entities: ['test_on_action'],
                rationale: 'Use the engine hook as the cascade entry.',
                requirementSource: 'user requested an event chain with native trigger.',
            }],
            triggerPlan: [{
                nodeId: 'test.1',
                mechanism: 'on_action',
                scopeBridge: 'country_event in country scope',
                timing: 'yearly pulse',
                rationale: 'Native timing avoids a pure text-only chain.',
            }],
            rewardPlan: [{
                rewardId: 'test_reward',
                directory: 'common/relics',
                entityType: 'relic',
                playerValue: 'Permanent reward with active effect.',
                implementation: 'Final event grants the relic with add_relic.',
                balanceNotes: 'Activation cooldown and cost are planned.',
            }],
            cleanupPlan: [{
                target: 'test_chain_active flag',
                lifecycle: 'Set when the first event fires.',
                cleanup: 'Removed in the resolution event.',
                owner: 'country',
            }],
            evidence: [
                {
                    sourceType: 'cwt',
                    source: 'query_rules(effect=country_event)',
                    insight: 'CWT/LSP scope evidence supports the event call.',
                },
                {
                    sourceType: 'common_inventory',
                    source: 'list_directory("common")',
                    insight: 'common/on_actions and common/situations were compared.',
                },
            ],
            dependencyOrder: ['common/on_actions/test.txt', 'events/test.txt'],
            featureManifest: {
                objective: 'Create a native-hook event with a closed flag lifecycle.',
                entities: [
                    { kind: 'event', id: 'test.1', operation: 'define' },
                    { kind: 'flag', id: 'test_chain_active', operation: 'set' },
                    { kind: 'flag', id: 'test_chain_active', operation: 'read' },
                ],
                requiredEdges: [
                    { from: 'test.1', relation: 'set', to: 'test_chain_active' },
                ],
                invariants: ['The flag is read after it is set and removed at closure.'],
                acceptanceCriteria: [
                    { id: 'event_exists', description: 'The event is defined.', type: 'entity_exists', subject: 'test.1' },
                    { id: 'typed_flag_lifecycle', description: 'The flag is set and read.', type: 'typed_lifecycle', entityKind: 'flag', subject: 'test_chain_active' },
                ],
                expectsFileChanges: true,
            },
            taskPlan: [{
                id: 'build_event',
                profileName: 'paradox-coder',
                prompt: 'Implement test.1 with the approved flag lifecycle.',
                plannedFiles: ['events/test.txt'],
                produces: [
                    { kind: 'event', id: 'test.1', operation: 'define' },
                    { kind: 'flag', id: 'test_chain_active', operation: 'set' },
                ],
                consumes: [{ kind: 'flag', id: 'test_chain_active', operation: 'read' }],
                dependencies: [],
                acceptanceChecks: [
                    { id: 'event_exists', description: 'The event is defined.', type: 'entity_exists', subject: 'test.1' },
                    { id: 'typed_flag_lifecycle', description: 'The flag is set and read.', type: 'typed_lifecycle', entityKind: 'flag', subject: 'test_chain_active' },
                ],
            }],
            unresolvedCritical: [],
        }, makeContext('topic-blueprint'));

        expect(result.success).to.equal(true);
        expect(result.approvalReady).to.equal(true);
        const planPath = path.join(workspaceRoot, '.cwtools', 'topic-blueprint', 'Implementation_Plan.md');
        const content = fs.readFileSync(planPath, 'utf8');
        expect(content).to.include('# Implementation Plan: Native Hook Event Chain');
        expect(content).to.include('## Blueprint Self-Check (Advisory)');
        expect(content).to.include('Common Directory Capability Review');
        expect(content).to.include('Reward and Outcome Plan');
        expect(content).to.include('Executable Feature Relationship Contract');
        expect(content).to.include('Approved Multi-Agent Task DAG');
        expect(content).to.not.include('```cwtools-blueprint');
        expect(content).to.include('```cwtools-plan');
        expect(result.dataFilePath).to.equal(planPath);
        expect(result.writtenFiles).to.deep.equal([planPath]);

        const planBlock = content.match(/```cwtools-plan\n([\s\S]*?)\n```/)?.[1];
        expect(planBlock).to.not.equal(undefined);
        const draftBlueprint = JSON.parse(planBlock!).blueprint;
        delete draftBlueprint.schemaVersion;
        delete draftBlueprint.generatedAt;
        const leanBlueprint = JSON.parse(JSON.stringify(draftBlueprint));
        leanBlueprint.commonDirectoryReview = [];
        leanBlueprint.subsystemPlan = [];
        leanBlueprint.triggerPlan = [];
        leanBlueprint.rewardPlan = [];
        leanBlueprint.cleanupPlan = [];
        leanBlueprint.dependencyOrder = [];
        leanBlueprint.evidence = [leanBlueprint.evidence[0]];
        const leanResult = await handler.writeDesignBlueprint(leanBlueprint, makeContext('topic-blueprint'));
        expect(leanResult.success).to.equal(true);
        expect(leanResult.approvalReady).to.equal(true);

        draftBlueprint.entities.push(
            { ...draftBlueprint.entities[0], id: 'test.2' },
            { ...draftBlueprint.entities[0], id: 'test.3' },
        );
        draftBlueprint.evidence.push({
            sourceType: 'project_knowledge',
            source: 'query_project_knowledge(test chain)',
            insight: 'Current project patterns support the planned event family.',
        });
        draftBlueprint.unresolvedCritical = ['Choose the leader eligibility scope.'];

        const draftResult = await handler.writeDesignBlueprint(draftBlueprint, makeContext('topic-blueprint'));
        const draftContent = fs.readFileSync(planPath, 'utf8');
        expect(draftResult.success).to.equal(true);
        expect(draftResult.approvalReady).to.equal(false);
        expect(draftResult.message).to.include('Blueprint draft saved');
        expect(draftContent).to.include('## Unresolved Critical Decisions');
        expect(draftContent).to.include('Choose the leader eligibility scope.');
        expect(draftContent).to.include('```cwtools-plan');
        expect(JSON.parse(draftContent.match(/```cwtools-plan\n([\s\S]*?)\n```/)?.[1] ?? '{}').status).to.equal('draft');
    });

    it('lets orchestrator sub-agents write localisation without waiting for pending-write confirmation', async () => {
        const pendingWrite = sinon.stub().resolves(false);
        const handler = new FileToolHandler({
            workspaceRoot,
            fileWriteMode: 'confirm',
            onPendingWrite: pendingWrite,
        });

        const result = await handler.writeLocalisation({
            filePath: 'localisation/english/samplemod_rakata_arc_epilogue_l_english.yml',
            language: 'l_english',
            entries: [{ key: 'samplemod_rakata_arc_epilogue_title', value: 'Epilogue' }],
        }, {
            runnerOptions: {
                schedulingState: LOCALIZATION_WRITE,
                topicId: 'topic-123',
                useSlimPrompt: true,
                forceAutoApplyWrites: true,
                abortSignal: new AbortController().signal,
            },
        } as any);

        expect(result.success).to.equal(true);
        expect(pendingWrite.called).to.equal(false);
        const ymlAbs = path.join(workspaceRoot, 'localisation', 'english', 'samplemod_rakata_arc_epilogue_l_english.yml');
        expect(fs.readFileSync(ymlAbs, 'utf8')).to.include('samplemod_rakata_arc_epilogue_title');
    });

    it('lets orchestrator sub-agents run guarded replace_lines without pending-write confirmation', async () => {
        const pendingWrite = sinon.stub().resolves(false);
        const handler = new FileToolHandler({
            workspaceRoot,
            fileWriteMode: 'confirm',
            onPendingWrite: pendingWrite,
        });
        const fileAbs = path.join(workspaceRoot, 'events', 'samplemod_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = samplemod.1\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 2,
            expectedContent: '\tid = samplemod.1',
            newContent: '\tid = samplemod.2',
        }, {
            runnerOptions: {
                schedulingState: PARADOX_WRITE,
                topicId: 'topic-123',
                useSlimPrompt: true,
                forceAutoApplyWrites: true,
                abortSignal: new AbortController().signal,
            },
        } as any) as any;

        expect(result.success).to.equal(true);
        expect(pendingWrite.called).to.equal(false);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = samplemod.2');
    });

    it('accepts replace_lines expectedContent copied from numbered read_file output', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'numbered_guard_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = guard.1\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 2,
            expectedContent: '2 | \tid = guard.1',
            newContent: '\tid = guard.2',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        expect(fs.readFileSync(fileAbs, 'utf8')).to.include('id = guard.2');
    });

    it('strips line-number prefixes from replace_lines newContent before writing', async () => {
        const handler = createFileHandler();
        const fileAbs = path.join(workspaceRoot, 'events', 'numbered_content_events.txt');
        fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
        fs.writeFileSync(fileAbs, 'country_event = {\n\tid = strip.1\n}\n', 'utf8');

        const result = await handler.replaceLines({
            filePath: fileAbs,
            startLine: 2,
            endLine: 2,
            newContent: '2 | \tid = strip.2',
        }, makeContext()) as any;

        expect(result.success).to.equal(true);
        const written = fs.readFileSync(fileAbs, 'utf8');
        expect(written).to.include('\tid = strip.2');
        expect(written).to.not.include('2 | ');
    });

    it('strips line-number prefixes from write_file content copied from read output', async () => {
        const handler = createFileHandler();
        const result = await handler.writeFile({
            file: 'common/defines/numbered_defines.txt',
            content: '1 | NDefines = {\n2 | \tNGame = { something = 1 }\n3 | }',
        }, makeContext());

        expect(result.success).to.equal(true);
        const written = fs.readFileSync(path.join(workspaceRoot, 'common', 'defines', 'numbered_defines.txt'), 'utf8');
        expect(written).to.equal('NDefines = {\n\tNGame = { something = 1 }\n}');
    });
});

