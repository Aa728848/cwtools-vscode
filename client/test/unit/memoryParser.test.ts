import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const TEMP_BASE = path.resolve(__dirname, '../../..', '.tmp-test');

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
        });

        const topicMemoryPath = path.join(workspaceRoot, '.cwtools', 'topic_123', '.cwtools-memory.md');
        const legacyRootPath = path.join(workspaceRoot, '.cwtools-memory.md');

        expect(result.success).to.equal(true);
        expect(parser.memoryFilePath).to.equal(topicMemoryPath);
        expect(fs.existsSync(topicMemoryPath)).to.equal(true);
        expect(fs.existsSync(legacyRootPath)).to.equal(false);
        expect(fs.readFileSync(topicMemoryPath, 'utf8')).to.include('Use foo namespace');
    });

    it('reads legacy root memory as a fallback alongside topic memory', () => {
        const { MemoryParser } = loadMemoryParserModule();
        const topicDir = path.join(workspaceRoot, '.cwtools', 'topic_legacy');
        fs.mkdirSync(topicDir, { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools-memory.md'), '# Legacy\n\nLEGACY_MEMORY', 'utf8');
        fs.writeFileSync(path.join(topicDir, '.cwtools-memory.md'), '# Topic\n\nTOPIC_MEMORY', 'utf8');

        const parser = new MemoryParser(workspaceRoot, 'topic_legacy');
        const prompt = parser.getMemoryPrompt();

        expect(prompt).to.include('TOPIC_MEMORY');
        expect(prompt).to.include('LEGACY_MEMORY');
    });

    it('persists structured provenance, redacts secrets, and keeps prompt building read-only', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_structured');
        await parser.appendMemory({
            key: 'private convention',
            content: 'Use namespace alpha. token=sk-abcdefghijklmnopqrstuvwxyz123456',
            priority: 'high',
            confidence: 0.95,
            source: 'run:test',
        });
        await parser.appendMemory({
            key: 'expired fact',
            content: 'This should disappear.',
            priority: 'low',
            expiresAt: Date.now() - 1,
        });

        const jsonPath = parser.getStructuredMemoryFilePath();
        const beforeContent = fs.readFileSync(jsonPath, 'utf8');
        const beforeMtime = fs.statSync(jsonPath).mtimeMs;

        const prompt = parser.getMemoryPrompt();
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

    it('selects top-k entries by task relevance within a strict budget', async () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_topk');
        for (let i = 0; i < 15; i++) {
            await parser.appendMemory({
                key: `filler fact ${i}`,
                content: `Unrelated filler content number ${i} about bananas.`,
                priority: 'low',
            });
        }
        await parser.appendMemory({
            key: 'stellaris event namespace',
            content: 'Use the foo namespace for stellaris events.',
            priority: 'low',
        });

        const prompt = parser.getMemoryPrompt('topic_topk', {
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
            });
        }
        await parser.appendMemory({ key: 'normal fact', content: 'n'.repeat(1000), priority: 'normal' });

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
        await parser.appendMemory({ key: 'alpha rule', content: 'Always alpha.', priority: 'normal' });
        await parser.appendMemory({ key: 'beta rule', content: 'Always beta.', priority: 'normal' });
        const jsonPath = parser.getStructuredMemoryFilePath();

        // Prompt building alone must not count usage.
        parser.getMemoryPrompt();
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
        await parser.appendMemory({ key: 'gamma rule', content: 'Always gamma.', priority: 'normal' });
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
        await parser.appendMemory({ key: 'rules depend on vanilla', content: 'CW rules v1.', priority: 'high' });
        await parser.appendMemory({ key: 'user preference', content: 'Prefers tabs.', priority: 'normal', source: 'user:instruction' });

        expect(parser.markMemoryStale(undefined, entry => entry.key.includes('rules'))).to.equal(1);

        let prompt = parser.getMemoryPrompt();
        expect(prompt).to.not.include('rules depend on vanilla');
        expect(prompt).to.include('user preference');

        // Opt-in: stale entries are annotated instead of excluded.
        prompt = parser.getMemoryPrompt(undefined, { includeStale: true });
        expect(prompt).to.include('rules depend on vanilla');
        expect(prompt).to.include('stale=true');

        const entries = JSON.parse(fs.readFileSync(parser.getStructuredMemoryFilePath(), 'utf8')).entries;
        expect(entries.find((entry: { key: string }) => entry.key === 'rules depend on vanilla').stale).to.equal(true);

        // Re-saving the key revalidates it (clears the stale flag).
        await parser.appendMemory({ key: 'rules depend on vanilla', content: 'CW rules v2.', priority: 'high' });
        prompt = parser.getMemoryPrompt();
        expect(prompt).to.include('CW rules v2.');
        expect(prompt).to.not.include('stale=true');
    });

    it('reads version 1 memory files and infers kinds conservatively', () => {
        const { MemoryParser } = loadMemoryParserModule();
        const parser = new MemoryParser(workspaceRoot, 'topic_v1');
        const topicDir = path.join(workspaceRoot, '.cwtools', 'topic_v1');
        fs.mkdirSync(topicDir, { recursive: true });
        const legacyEntries = [
            { key: 'agent learned fact', content: 'Model inferred this.', priority: 'normal', source: 'run:abc' },
            { key: 'user instruction fact', content: 'User said tabs.', priority: 'normal', source: 'user:instruction' },
            { key: 'project convention', content: 'From docs.', priority: 'high', source: 'project-docs' },
            { key: 'unsourced fact', content: 'Legacy without source.', priority: 'low' },
            { key: 42, content: 'invalid entry without string key' },
            { content: 'entry without any key' },
        ];
        fs.writeFileSync(
            path.join(topicDir, 'memory.json'),
            JSON.stringify({ version: 1, entries: legacyEntries }),
            'utf8',
        );

        const prompt = parser.getMemoryPrompt('topic_v1');
        expect(prompt).to.include('agent learned fact');
        expect(prompt).to.include('kind=inferred');
        expect(prompt).to.include('kind=user_fact');
        expect(prompt).to.include('kind=project_fact');
        expect(prompt).to.include('unsourced fact');
        // Invalid entries are dropped at the untrusted-JSON boundary.
        expect(prompt).to.not.include('invalid entry without string key');
        expect(prompt).to.not.include('entry without any key');
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
