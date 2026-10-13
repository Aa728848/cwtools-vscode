import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-experience-distill');

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

function loadExperienceStoreModule() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        delete require.cache[require.resolve('../../extension/ai/workspacePaths')];
        delete require.cache[require.resolve('../../extension/ai/memoryParser')];
        delete require.cache[require.resolve('../../extension/ai/experienceStore')];
        return require('../../extension/ai/experienceStore') as typeof import('../../extension/ai/experienceStore');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

type Store = ReturnType<typeof loadExperienceStoreModule>;

function eligibility(store: Store, overrides: Partial<import('../../extension/ai/experienceStore').ExperienceEligibilityInput> = {}) {
    return store.shouldDistillExperience({
        status: 'completed',
        toolCallCount: 7,
        toolCallsByName: { edit_file: 3, read_file: 4 },
        writtenFiles: ['events/alpha.txt'],
        persistence: 'full',
        isSubAgentRun: false,
        alreadyDistilled: false,
        enabled: true,
        ...overrides,
    });
}

describe('shouldDistillExperience (run-end hook gate)', () => {
    const store = loadExperienceStoreModule();

    it('triggers for a completed run with at least 5 tool calls and real work', () => {
        expect(eligibility(store)).to.equal(true);
        expect(eligibility(store, { toolCallCount: 5, writtenFiles: [] })).to.equal(true, 'action tool calls qualify without written files');
    });

    it('never triggers below the 5-tool-call threshold', () => {
        expect(eligibility(store, { toolCallCount: 4 })).to.equal(false);
        expect(eligibility(store, { toolCallCount: 0 })).to.equal(false);
    });

    it('skips pure Q&A runs: many read-only tool calls but no action and no writes', () => {
        expect(eligibility(store, {
            toolCallCount: 12,
            toolCallsByName: { read_file: 6, grep: 4, get_pdx_block: 2 },
            writtenFiles: [],
        })).to.equal(false);
    });

    it('skips non-completed statuses', () => {
        expect(eligibility(store, { status: 'failed' })).to.equal(false);
        expect(eligibility(store, { status: 'paused' })).to.equal(false);
        expect(eligibility(store, { status: 'running' })).to.equal(false);
    });

    it('respects the history persistence policy', () => {
        expect(eligibility(store, { persistence: 'off' })).to.equal(false);
        expect(eligibility(store, { persistence: 'metadata' })).to.equal(false);
    });

    it('skips sub-agent runs, repeat distillation, and a disabled feature gate', () => {
        expect(eligibility(store, { isSubAgentRun: true })).to.equal(false);
        expect(eligibility(store, { alreadyDistilled: true })).to.equal(false);
        expect(eligibility(store, { enabled: false })).to.equal(false);
    });
});

describe('parseExperienceDistillation (untrusted LLM output)', () => {
    const store = loadExperienceStoreModule();

    it('parses a plain JSON array and narrows each field', () => {
        const drafts = store.parseExperienceDistillation(JSON.stringify([{
            title: ' 先建实体再写本地化 ',
            lesson: '本地化写入依赖已存在的 owning entity。',
            approach: 'entity → diagnostics → yml',
            pitfalls: ['先写 yml 会被拒绝', 42, null],
            fileAnchors: ['localisation/english/a_l_english.yml', false],
            confidence: 'high',
            domain: 'paradox',
            extra: 'ignored',
        }]));
        expect(drafts).to.have.lengthOf(1);
        expect(drafts[0]!.title).to.equal(' 先建实体再写本地化 ');
        expect(drafts[0]!.approach).to.equal('entity → diagnostics → yml');
        expect(drafts[0]!.pitfalls).to.deep.equal(['先写 yml 会被拒绝']);
        expect(drafts[0]!.fileAnchors).to.deep.equal(['localisation/english/a_l_english.yml']);
        expect(drafts[0]!.confidence).to.equal('high');
        expect(drafts[0]!.domain).to.equal('paradox');
        expect(drafts[0]).to.not.have.property('extra');
    });

    it('tolerates Markdown fences and surrounding prose', () => {
        const fenced = store.parseExperienceDistillation('Here you go:\n```json\n[{"title":"a","lesson":"b"}]\n```\nThanks!');
        expect(fenced).to.have.lengthOf(1);
        const prosaic = store.parseExperienceDistillation('Result: [{"title":"a","lesson":"b"}] — done.');
        expect(prosaic).to.have.lengthOf(1);
    });

    it('caps at three drafts and drops invalid items silently', () => {
        const items = [
            { title: 'one', lesson: 'l1' },
            { title: '', lesson: 'no title' },
            { lesson: 'missing title' },
            'not-an-object',
            { title: 'two', lesson: 'l2', confidence: 'bogus', domain: 'bogus' },
            { title: 'three', lesson: 'l3' },
            { title: 'four', lesson: 'l4' },
        ];
        const drafts = store.parseExperienceDistillation(JSON.stringify(items));
        expect(drafts).to.have.lengthOf(3);
        expect(drafts.map(draft => draft.title)).to.deep.equal(['one', 'two', 'three']);
        expect(drafts[1]!.confidence).to.equal('medium');
        expect(drafts[1]!.domain).to.equal(undefined);
    });

    it('returns nothing for unparseable or non-array output', () => {
        expect(store.parseExperienceDistillation('')).to.have.lengthOf(0);
        expect(store.parseExperienceDistillation('no json at all')).to.have.lengthOf(0);
        expect(store.parseExperienceDistillation('[{broken')).to.have.lengthOf(0);
        expect(store.parseExperienceDistillation('{"title":"a","lesson":"b"}')).to.have.lengthOf(0);
        expect(store.parseExperienceDistillation('[]')).to.have.lengthOf(0);
    });
});

describe('distillRunExperience (injectable requester)', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-expd-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty */ }
    });

    const runInput = {
        goal: '给 country_event 加本地化并修复诊断',
        finalAnswer: '已完成：新建事件实体，补齐 yml，诊断清零。',
        toolCallsByName: { edit_file: 3, write_localisation: 2, get_diagnostics: 2 },
        failedToolCount: 1,
        writtenFiles: ['events/alpha.txt', 'localisation/english/alpha_l_english.yml'],
        sourceRunId: 'run_distill_test',
    };

    it('sends a bounded prompt and stores the parsed lessons without a real model call', async () => {
        const store = loadExperienceStoreModule();
        let capturedMessages: import('../../extension/ai/types').ChatMessage[] = [];
        const fakeRequester = async (messages: import('../../extension/ai/types').ChatMessage[]): Promise<string> => {
            capturedMessages = messages;
            return JSON.stringify([{
                title: '先实体后本地化',
                lesson: 'write_localisation 前必须先有 owning entity，否则写入被拒。',
                confidence: 'high',
            }]);
        };

        const result = await store.distillRunExperience(workspaceRoot, runInput, fakeRequester);

        expect(result.stored).to.equal(1);
        expect(result.titles).to.deep.equal(['先实体后本地化']);
        expect(capturedMessages).to.have.lengthOf(2);
        expect(capturedMessages[0]!.role).to.equal('system');
        const userContent = String(capturedMessages[1]!.content);
        expect(userContent).to.include('给 country_event 加本地化并修复诊断');
        expect(userContent).to.include('edit_file: 3');
        expect(userContent).to.include('failed tool calls: 1');
        expect(userContent).to.include('events/alpha.txt');

        const onDisk = JSON.parse(fs.readFileSync(store.getExperienceStoreFilePath(workspaceRoot), 'utf8'));
        expect(onDisk.entries).to.have.lengthOf(1);
        expect(onDisk.entries[0].sourceRunId).to.equal('run_distill_test');
    });

    it('stores nothing when the model returns garbage (silent parse failure)', async () => {
        const store = loadExperienceStoreModule();
        const result = await store.distillRunExperience(workspaceRoot, runInput, async () => 'Sorry, I cannot help with that.');
        expect(result.stored).to.equal(0);
        expect(result.titles).to.deep.equal([]);
        expect(fs.existsSync(store.getExperienceStoreFilePath(workspaceRoot))).to.equal(false);
    });

    it('stores nothing for an empty-but-valid array', async () => {
        const store = loadExperienceStoreModule();
        const result = await store.distillRunExperience(workspaceRoot, runInput, async () => '[]');
        expect(result.stored).to.equal(0);
        expect(fs.existsSync(store.getExperienceStoreFilePath(workspaceRoot))).to.equal(false);
    });

    it('propagates requester errors so the caller can treat them as best-effort', async () => {
        const store = loadExperienceStoreModule();
        let thrown: unknown;
        try {
            await store.distillRunExperience(workspaceRoot, runInput, async () => { throw new Error('429 rate limit'); });
        } catch (error) {
            thrown = error;
        }
        expect(thrown).to.be.instanceOf(Error);
        expect((thrown as Error).message).to.include('429');
    });
});
