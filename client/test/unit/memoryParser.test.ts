import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-memory-parser');

describe('MemoryParser topic storage', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-memory-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty */ }
    });

    it('writes new memory under the current topic folder', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_123');

        const result = await parser.appendMemory({
            key: 'namespace convention',
            content: 'Use foo namespace for test events.',
            priority: 'normal',
            domain: 'paradox',
        });

        const topicMemoryPath = path.join(workspaceRoot, '.cwtools', 'topic_123', '.cwtools-memory.md');
        expect(result.success).to.equal(true);
        expect(parser.memoryFilePath).to.equal(topicMemoryPath);
        expect(fs.existsSync(topicMemoryPath)).to.equal(true);
        expect(fs.readFileSync(topicMemoryPath, 'utf8')).to.include('Use foo namespace');
    });

    it('persists structured provenance, redacts secrets, and keeps prompt building read-only', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_structured');
        await parser.appendMemory({
            key: 'private convention',
            content: 'Use namespace alpha. token=sk-abcdefghijklmnopqrstuvwxyz123456',
            priority: 'high',
            domain: 'paradox',
            confidence: 0.95,
            source: 'run:test',
        });
        await parser.appendMemory({
            key: 'expired fact',
            content: 'This should disappear.',
            priority: 'low',
            domain: 'paradox',
            expiresAt: Date.now() - 1,
        });

        const jsonPath = parser.getStructuredMemoryFilePath();
        const beforeContent = fs.readFileSync(jsonPath, 'utf8');
        const beforeMtime = fs.statSync(jsonPath).mtimeMs;

        const prompt = parser.getMemoryPrompt(undefined, { domain: 'paradox' });
        expect(prompt).to.include('private convention');
        expect(prompt).to.include('[REDACTED_API_KEY]');
        expect(prompt).to.not.include('expired fact');

        // Read-only prompt building: no usage bump, no file rewrite, and expired
        // entries stay on disk (pruneMemory still drops them).
        expect(fs.readFileSync(jsonPath, 'utf8')).to.equal(beforeContent);
        expect(fs.statSync(jsonPath).mtimeMs).to.equal(beforeMtime);
        const structured = JSON.parse(beforeContent);
        expect(structured.entries).to.have.lengthOf(2);
        expect(structured.entries[0].source).to.equal('run:test');
        expect(structured.entries[0].usageCount ?? 0).to.equal(0);
        expect(structured.entries[0].kind).to.equal('inferred');

        parser.pruneMemory();
        const pruned = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        expect(pruned.entries).to.have.lengthOf(1);
        expect(pruned.entries[0].key).to.equal('private convention');
    });

    it('isolates structured memory by its explicit capability domain', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_domains');
        await parser.appendMemory({
            key: 'shared-name',
            content: 'Paradox-only explicit-domain fact.',
            priority: 'normal',
            domain: 'paradox',
        });
        await parser.appendMemory({
            key: 'shared-name',
            content: 'General repository fact.',
            priority: 'normal',
            domain: 'general',
        });

        const paradoxPrompt = parser.getMemoryPrompt('topic_domains', { domain: 'paradox' });
        const generalPrompt = parser.getMemoryPrompt('topic_domains', { domain: 'general' });
        expect(paradoxPrompt).to.include('Paradox-only explicit-domain fact.');
        expect(paradoxPrompt).to.not.include('General repository fact.');
        expect(generalPrompt).to.include('General repository fact.');
        expect(generalPrompt).to.not.include('Paradox-only explicit-domain fact.');

        expect(parser.markMemoryUsed('topic_domains', ['shared-name'], 'general')).to.equal(1);
        MemoryParser.flushUsageWrites();
        const entries = JSON.parse(fs.readFileSync(parser.getStructuredMemoryFilePath(), 'utf8')).entries;
        const paradoxEntry = entries.find((entry: { domain?: string }) => entry.domain === 'paradox');
        const generalEntry = entries.find((entry: { domain?: string }) => entry.domain === 'general');
        expect(paradoxEntry.usageCount ?? 0).to.equal(0);
        expect(generalEntry.usageCount).to.equal(1);
    });

    it('selects top-k entries by task relevance within a strict budget', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_topk');
        for (let i = 0; i < 15; i++) {
            await parser.appendMemory({
                key: `filler fact ${i}`,
                content: `Unrelated filler content number ${i} about bananas.`,
                priority: 'low',
                domain: 'paradox',
            });
        }
        await parser.appendMemory({
            key: 'stellaris event namespace',
            content: 'Use the foo namespace for stellaris events.',
            priority: 'low',
            domain: 'paradox',
        });

        const prompt = parser.getMemoryPrompt('topic_topk', {
            domain: 'paradox',
            taskText: 'add a stellaris event in namespace foo',
            gameId: 'stellaris',
        });
        const headings = prompt.match(/^## /gm) ?? [];
        // 16 candidates, but only the top-k are injected.
        expect(headings.length).to.equal(MemoryParser.TOP_K_MEMORY_ENTRIES);
        // The task-relevant entry wins over generic filler despite equal priority.
        expect(prompt).to.include('stellaris event namespace');
        // Strict total budget for entry content; the safety header has its own quota.
        expect(prompt.length).to.be.lessThan(MemoryParser.MAX_MEMORY_CHARS + 1000);
    });

    it('enforces the capacity limit even for high-priority entries', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_capacity');
        // 8 high-priority entries of ~2.6 KB each: ~21 KB total, far over the 12 KB cap.
        for (let i = 0; i < 8; i++) {
            await parser.appendMemory({
                key: `high fact ${i}`,
                content: `H${i}-` + 'x'.repeat(2400),
                priority: 'high',
                domain: 'paradox',
            });
        }
        await parser.appendMemory({ key: 'normal fact', content: 'n'.repeat(1000), priority: 'normal', domain: 'paradox' });

        const structured = JSON.parse(fs.readFileSync(parser.getStructuredMemoryFilePath(), 'utf8'));
        const totalSize = structured.entries.reduce(
            (sum: number, entry: { key: string; content: string }) => sum + entry.key.length + entry.content.length + 200,
            0,
        );
        expect(totalSize).to.be.at.most(MemoryParser.MAX_MEMORY_CHARS);
        const keys = structured.entries.map((entry: { key: string }) => entry.key);
        const highKeys = keys.filter((key: string) => key.startsWith('high fact'));
        // High priority affects eviction order only — excess high entries are dropped.
        expect(highKeys.length).to.be.lessThan(8);
        // A smaller normal entry that still fits after the kept high ones survives.
        expect(keys).to.include('normal fact');
    });

    it('counts usage only on explicit reference and persists debounced', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_usage');
        await parser.appendMemory({ key: 'alpha rule', content: 'Always alpha.', priority: 'normal', domain: 'paradox' });
        await parser.appendMemory({ key: 'beta rule', content: 'Always beta.', priority: 'normal', domain: 'paradox' });
        const jsonPath = parser.getStructuredMemoryFilePath();

        // Prompt building alone must not count usage.
        parser.getMemoryPrompt(undefined, { domain: 'paradox' });
        let entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).entries;
        expect(entries.every((entry: { usageCount?: number }) => (entry.usageCount ?? 0) === 0)).to.equal(true);

        // Verbatim key reference in model text counts once; unknown keys are ignored.
        expect(parser.markMemoryUsedInText(undefined, 'Applying alpha rule here.')).to.equal(1);
        expect(parser.markMemoryUsed(undefined, ['alpha rule', 'missing key'])).to.equal(1);
        MemoryParser.flushUsageWrites();

        entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).entries;
        const alpha = entries.find((entry: { key: string }) => entry.key === 'alpha rule');
        expect(alpha.usageCount).to.equal(2);
        expect(alpha.lastUsedAt).to.be.a('number');
        const beta = entries.find((entry: { key: string }) => entry.key === 'beta rule');
        expect(beta.usageCount ?? 0).to.equal(0);
        // Stats-only flush must not rewrite the generated Markdown with stale counts.
        const markdown = fs.readFileSync(parser.memoryFilePath, 'utf8');
        expect(markdown).to.include('alpha rule');
    });

    it('debounces usage persistence and coalesces repeated marks', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_debounce');
        await parser.appendMemory({ key: 'gamma rule', content: 'Always gamma.', priority: 'normal', domain: 'paradox' });
        const jsonPath = parser.getStructuredMemoryFilePath();

        const originalDebounce = MemoryParser.usagePersistDebounceMs;
        MemoryParser.usagePersistDebounceMs = 40;
        try {
            parser.markMemoryUsed(undefined, ['gamma rule']);
            parser.markMemoryUsed(undefined, ['gamma rule']);
            parser.markMemoryUsed(undefined, ['gamma rule']);
            // Still pending: the file has not been rewritten yet.
            let entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).entries;
            expect(entries[0].usageCount ?? 0).to.equal(0);

            await new Promise(resolve => setTimeout(resolve, 200));

            entries = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).entries;
            expect(entries[0].usageCount).to.equal(3);
        } finally {
            MemoryParser.flushUsageWrites();
            MemoryParser.usagePersistDebounceMs = originalDebounce;
        }
    });

    it('marks entries stale and excludes them from prompts until revalidated', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_stale');
        await parser.appendMemory({ key: 'rules depend on vanilla', content: 'CW rules v1.', priority: 'high', domain: 'paradox' });
        await parser.appendMemory({ key: 'user preference', content: 'Prefers tabs.', priority: 'normal', domain: 'paradox', source: 'user:instruction' });

        expect(parser.markMemoryStale(undefined, entry => entry.key.includes('rules'))).to.equal(1);

        let prompt = parser.getMemoryPrompt(undefined, { domain: 'paradox' });
        expect(prompt).to.not.include('rules depend on vanilla');
        expect(prompt).to.include('user preference');

        // Opt-in: stale entries are annotated instead of excluded.
        prompt = parser.getMemoryPrompt(undefined, { domain: 'paradox', includeStale: true });
        expect(prompt).to.include('rules depend on vanilla');
        expect(prompt).to.include('stale=true');

        const entries = JSON.parse(fs.readFileSync(parser.getStructuredMemoryFilePath(), 'utf8')).entries;
        expect(entries.find((entry: { key: string }) => entry.key === 'rules depend on vanilla').stale).to.equal(true);

        // Re-saving the key revalidates it (clears the stale flag).
        await parser.appendMemory({ key: 'rules depend on vanilla', content: 'CW rules v2.', priority: 'high', domain: 'paradox' });
        prompt = parser.getMemoryPrompt(undefined, { domain: 'paradox' });
        expect(prompt).to.include('CW rules v2.');
        expect(prompt).to.not.include('stale=true');
    });

    it('invalidates project facts across active topics without staling user facts', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const first = new MemoryParser(workspaceRoot, 'topic_project_a');
        const second = new MemoryParser(workspaceRoot, 'topic_project_b');
        await first.appendMemory({ key: 'project rule a', content: 'Old rule A.', priority: 'normal', domain: 'paradox', source: 'project-docs' });
        await first.appendMemory({ key: 'user preference a', content: 'Keep tabs.', priority: 'normal', domain: 'paradox', source: 'user:instruction' });
        await second.appendMemory({ key: 'project rule b', content: 'Old rule B.', priority: 'normal', domain: 'paradox', source: 'project-profile' });

        expect(MemoryParser.markWorkspaceProjectFactsStale(workspaceRoot)).to.equal(2);
        expect(first.getMemoryPrompt(undefined, { domain: 'paradox' })).to.not.include('project rule a');
        expect(first.getMemoryPrompt(undefined, { domain: 'paradox' })).to.include('user preference a');
        expect(second.getMemoryPrompt(undefined, { domain: 'paradox' })).to.not.include('project rule b');
    });

    it('queues stale project facts for metadata-only revalidation on a later task', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_revalidation_queue');
        await parser.appendMemory({
            key: 'stellaris event namespace',
            content: 'The old namespace is obsolete and must never be injected.',
            priority: 'high',
            domain: 'paradox',
            source: 'events/project_events.txt',
            revision: 'sha256:old',
        });

        parser.markMemoryStale(undefined, undefined, 'events_file_changed');
        const prompt = parser.getMemoryPrompt(undefined, {
            domain: 'paradox',
            taskText: 'update the stellaris event namespace',
            gameId: 'stellaris',
        });

        expect(prompt).to.include('<stale-project-memory>');
        expect(prompt).to.include('stellaris event namespace');
        expect(prompt).to.include('events/project_events.txt');
        expect(prompt).to.include('events_file_changed');
        expect(prompt).to.not.include('The old namespace is obsolete');

        const unrelatedPrompt = parser.getMemoryPrompt(undefined, {
            domain: 'paradox',
            taskText: 'translate a localisation tooltip',
            gameId: 'stellaris',
        });
        expect(unrelatedPrompt).to.not.include('<stale-project-memory>');
    });

    it('preserves project provenance when a stale key is re-saved by a later run', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_project_rewrite');
        await parser.appendMemory({
            key: 'project namespace',
            content: 'Use old namespace.',
            priority: 'normal',
            domain: 'paradox',
            source: 'events/project_events.txt',
            revision: 'sha256:old',
        });
        parser.markMemoryStale(undefined, undefined, 'events_file_changed');

        const denied = await parser.appendMemory({
            key: 'project namespace',
            content: 'Use new namespace.',
            priority: 'normal',
            domain: 'paradox',
            source: 'run:revalidation-run',
            revision: 'sha256:new',
        });
        expect(denied.success).to.equal(false);
        expect(denied.message).to.include('current authoritative');

        const currentProjectRevision = MemoryParser.getWorkspaceProjectRevision(workspaceRoot);
        const result = await parser.appendMemory({
            key: 'project namespace',
            content: 'Use new namespace.',
            priority: 'normal',
            domain: 'paradox',
            source: 'run:revalidation-run',
            revision: 'sha256:new',
        }, undefined, { authoritativeProjectRevision: currentProjectRevision });

        expect(result.revalidatedProjectFact).to.equal(true);
        const entries = JSON.parse(fs.readFileSync(parser.getStructuredMemoryFilePath(), 'utf8')).entries;
        expect(entries[0]).to.include({
            kind: 'project_fact',
            source: 'events/project_events.txt',
            revision: 'sha256:new',
            projectRevision: currentProjectRevision,
        });
        expect(entries[0].stale).to.equal(undefined);
        expect(parser.getMemoryPrompt(undefined, { domain: 'paradox', taskText: 'project namespace' })).to.include('Use new namespace.');
        expect(parser.getMemoryPrompt(undefined, { domain: 'paradox', taskText: 'project namespace' })).to.not.include('<stale-project-memory>');
    });

    it('lazily invalidates an inactive topic after the workspace revision advances', () => {
        const { MemoryParser } = loadMemoryParserModule();
        const currentRevision = MemoryParser.getWorkspaceProjectRevision(workspaceRoot);
        const topicDir = path.join(workspaceRoot, '.cwtools', 'topic_inactive');
        fs.mkdirSync(topicDir, { recursive: true });
        fs.writeFileSync(path.join(topicDir, 'memory.json'), JSON.stringify({
            version: MemoryParser.STRUCTURED_MEMORY_VERSION,
            entries: [{
                key: 'inactive project fact',
                content: 'This value belongs to the old project revision.',
                priority: 'normal',
                source: 'project-profile',
                domain: 'paradox',
                kind: 'project_fact',
                projectRevision: currentRevision,
            }],
        }), 'utf8');

        MemoryParser.advanceWorkspaceProjectRevision(workspaceRoot, 'project_changed_while_topic_inactive');
        const parser = new MemoryParser(workspaceRoot, 'topic_inactive');
        const prompt = parser.getMemoryPrompt(undefined, { domain: 'paradox', taskText: 'inactive project fact' });

        expect(prompt).to.include('<stale-project-memory>');
        expect(prompt).to.not.include('This value belongs to the old project revision.');
        const auditPrompt = parser.getMemoryPrompt(undefined, { domain: 'paradox', includeStale: true });
        expect(auditPrompt).to.include('stale=true');
    });

    it('treats project facts from an earlier extension session as stale without rewriting memory on read', async () => {
        const firstModule = loadMemoryParserModule();
        const firstParser = new firstModule.MemoryParser(workspaceRoot, 'topic_restart');
        await firstParser.appendMemory({
            key: 'session-bound project fact',
            content: 'Value observed before the extension restarted.',
            priority: 'normal',
            domain: 'paradox',
            source: 'project-profile',
            kind: 'project_fact',
        });
        const jsonPath = firstParser.getStructuredMemoryFilePath();
        const before = fs.readFileSync(jsonPath, 'utf8');

        const restartedModule = loadMemoryParserModule();
        const restartedParser = new restartedModule.MemoryParser(workspaceRoot, 'topic_restart');
        const prompt = restartedParser.getMemoryPrompt(undefined, { domain: 'paradox', taskText: 'session-bound project fact' });

        expect(prompt).to.include('<stale-project-memory>');
        expect(prompt).to.not.include('Value observed before the extension restarted.');
        expect(fs.readFileSync(jsonPath, 'utf8')).to.equal(before);
    });

    it('rejects non-current structured memory versions', () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_obsolete');
        const topicDir = path.join(workspaceRoot, '.cwtools', 'topic_obsolete');
        fs.mkdirSync(topicDir, { recursive: true });
        const obsoleteEntries = [
            { key: 'agent learned fact', content: 'Model inferred this.', priority: 'normal', source: 'run:abc' },
            { key: 'user instruction fact', content: 'User said tabs.', priority: 'normal', source: 'user:instruction' },
            { key: 'project convention', content: 'From docs.', priority: 'high', source: 'project-docs' },
            { key: 'unsourced fact', content: 'Obsolete without source.', priority: 'low' },
            { key: 42, content: 'invalid entry without string key' },
            { content: 'entry without any key' },
        ];
        fs.writeFileSync(
            path.join(topicDir, 'memory.json'),
            JSON.stringify({ version: 1, entries: obsoleteEntries }),
            'utf8',
        );

        const prompt = parser.getMemoryPrompt('topic_obsolete', { domain: 'paradox' });
        expect(prompt).to.equal('');
    });

    it('serializes concurrent writes and rejects stale expected revisions', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const first = new MemoryParser(workspaceRoot, 'topic_cas');
        const second = new MemoryParser(workspaceRoot, 'topic_cas');
        const [one, two] = await Promise.all([
            first.appendMemory({ key: 'shared', content: 'one', priority: 'normal', domain: 'paradox' }),
            second.appendMemory({ key: 'shared', content: 'two', priority: 'normal', domain: 'paradox' }),
        ]);
        expect([one.storeRevision, two.storeRevision].sort()).to.deep.equal([1, 2]);

        const conflict = await first.appendMemory(
            { key: 'shared', content: 'stale update', priority: 'normal', domain: 'paradox' },
            'topic_cas',
            { expectedRevision: 1 },
        );
        expect(conflict.success).to.equal(false);
        expect(conflict.storeRevision).to.equal(2);
        expect(first.getMemoryPrompt('topic_cas', { domain: 'paradox' })).to.not.include('stale update');
    });

    it('archives memory from recall and exposes a metadata-only retrieval trace', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_trace');
        const saved = await parser.appendMemory({ key: 'trace key', content: 'recallable value', priority: 'normal', domain: 'paradox' });
        expect(parser.getMemoryPrompt('topic_trace', { domain: 'paradox', taskText: 'trace key' })).to.include('recallable value');
        const trace = parser.getRecallTrace('topic_trace');
        expect(trace?.selected[0]).to.include({ key: 'trace key', storeRevision: 1 });
        expect(JSON.stringify(trace)).to.not.include('recallable value');

        const archived = await parser.forgetMemory('trace key', 'paradox', 'archive', 'topic_trace', saved.storeRevision);
        expect(archived.success).to.equal(true);
        expect(parser.getMemoryPrompt('topic_trace', { domain: 'paradox', taskText: 'trace key' })).to.not.include('recallable value');
        expect(parser.getRecallTrace('topic_trace')?.excluded.archived).to.equal(1);
    });
});

function loadMemoryParserModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/memoryParser')];
        return require('../../extension/ai/memoryParser') as typeof import('../../extension/ai/memoryParser');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const vscodeStub = {
    workspace: {
        workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};
