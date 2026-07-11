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

        const topicMemoryPath = path.join(workspaceRoot, '.cwtools-ai', 'topic_123', '.cwtools-ai-memory.md');
        const legacyRootPath = path.join(workspaceRoot, '.cwtools-ai-memory.md');

        expect(result.success).to.equal(true);
        expect(parser.memoryFilePath).to.equal(topicMemoryPath);
        expect(fs.existsSync(topicMemoryPath)).to.equal(true);
        expect(fs.existsSync(legacyRootPath)).to.equal(false);
        expect(fs.readFileSync(topicMemoryPath, 'utf8')).to.include('Use foo namespace');
    });

    it('reads legacy root memory as a fallback alongside topic memory', () => {
        const { MemoryParser } = loadMemoryParserModule();
        const topicDir = path.join(workspaceRoot, '.cwtools-ai', 'topic_legacy');
        fs.mkdirSync(topicDir, { recursive: true });
        fs.writeFileSync(path.join(workspaceRoot, '.cwtools-ai-memory.md'), '# Legacy\n\nLEGACY_MEMORY', 'utf8');
        fs.writeFileSync(path.join(topicDir, '.cwtools-ai-memory.md'), '# Topic\n\nTOPIC_MEMORY', 'utf8');

        const parser = new MemoryParser(workspaceRoot, 'topic_legacy');
        const prompt = parser.getMemoryPrompt();

        expect(prompt).to.include('TOPIC_MEMORY');
        expect(prompt).to.include('LEGACY_MEMORY');
    });

    it('persists structured provenance, redacts secrets, tracks usage, and expires stale entries', async () => {
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

        const prompt = parser.getMemoryPrompt();
        expect(prompt).to.include('private convention');
        expect(prompt).to.include('[REDACTED_API_KEY]');
        expect(prompt).to.not.include('expired fact');

        const structured = JSON.parse(fs.readFileSync(parser.getStructuredMemoryFilePath(), 'utf8'));
        expect(structured.entries).to.have.lengthOf(1);
        expect(structured.entries[0].source).to.equal('run:test');
        expect(structured.entries[0].usageCount).to.equal(1);
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
