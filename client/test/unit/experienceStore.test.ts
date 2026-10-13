import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-experience-store');

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

describe('ExperienceStore', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-exp-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty */ }
    });

    function readStore(store: ReturnType<typeof loadExperienceStoreModule>): { version: number; entries: any[] } {
        const filePath = store.getExperienceStoreFilePath(workspaceRoot);
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }

    it('appends entries atomically and refreshes the human-readable projection', () => {
        const store = loadExperienceStoreModule();
        const result = store.appendExperiences(workspaceRoot, [{
            title: 'Localisation keys need owner first',
            lesson: 'Create the owning entity before writing localisation, or the yml write is rejected.',
            approach: 'Define entity → diagnostics → localisation.',
            pitfalls: ['Writing yml before the entity exists'],
            fileAnchors: ['localisation/english/events_l_english.yml'],
            confidence: 'high',
        }], { sourceRunId: 'run_test_1' });

        expect(result.appended).to.equal(1);
        expect(result.merged).to.equal(0);
        expect(result.stored).to.have.lengthOf(1);
        expect(result.stored[0]!.confidence).to.equal('high');
        expect(result.stored[0]!.sourceRunId).to.equal('run_test_1');
        expect(result.stored[0]!.id).to.match(/^exp_/);

        const filePath = store.getExperienceStoreFilePath(workspaceRoot);
        expect(filePath).to.not.equal('');
        expect(fs.existsSync(filePath)).to.equal(true);
        // Atomic tmp+rename leaves no temp file behind and valid JSON.
        expect(fs.existsSync(`${filePath}.tmp`)).to.equal(false);
        const stored = readStore(store);
        expect(stored.version).to.equal(1);
        expect(stored.entries).to.have.lengthOf(1);

        const projectionPath = store.getExperienceProjectionPath(workspaceRoot);
        expect(projectionPath).to.equal(path.join(workspaceRoot, '.cwtools', 'experience.md'));
        const projection = fs.readFileSync(projectionPath, 'utf8');
        expect(projection).to.include('Localisation keys need owner first');
        expect(projection).to.include('Auto-generated projection');
        expect(projection).to.include('cwtools-experience:');
    });

    it('redacts secrets and truncates oversized fields before persistence', () => {
        const store = loadExperienceStoreModule();
        const result = store.appendExperiences(workspaceRoot, [{
            title: 'api setup',
            lesson: `Configure the provider with token=sk-abcdefghijklmnopqrstuvwxyz123456 and never commit it.`,
            approach: 'x'.repeat(5000),
            pitfalls: [`password="hunter2secret" leaks`, 'p'.repeat(400)],
            fileAnchors: ['a'.repeat(400)],
        }]);

        expect(result.appended).to.equal(1);
        const entry = result.stored[0]!;
        expect(entry.lesson).to.include('[REDACTED_API_KEY]');
        expect(entry.lesson).to.not.include('sk-abcdefghijklmnopqrstuvwxyz123456');
        expect(entry.approach!.length).to.be.lessThanOrEqual(1200);
        expect(entry.pitfalls).to.have.lengthOf(2);
        expect(entry.pitfalls![0]).to.include('[REDACTED]');
        expect(entry.pitfalls![1]!.length).to.be.lessThanOrEqual(240);
        expect(entry.fileAnchors![0]!.length).to.be.lessThanOrEqual(240);

        const onDisk = fs.readFileSync(store.getExperienceStoreFilePath(workspaceRoot), 'utf8');
        expect(onDisk).to.not.include('sk-abcdefghijklmnopqrstuvwxyz123456');
    });

    it('merges highly similar drafts instead of duplicating them', () => {
        const store = loadExperienceStoreModule();
        const first = store.appendExperiences(workspaceRoot, [{
            title: '事件链 namespace 规则',
            lesson: 'country_event 必须使用与文件匹配的 namespace，否则触发器解析失败。',
            pitfalls: ['namespace 与文件名不一致'],
            confidence: 'medium',
        }]);
        expect(first.appended).to.equal(1);
        const firstId = first.stored[0]!.id;

        const second = store.appendExperiences(workspaceRoot, [{
            title: '事件链 namespace 规则',
            lesson: 'country_event 必须使用与文件匹配的 namespace，否则触发器解析失败。',
            pitfalls: ['忘记在事件文件顶部声明 namespace'],
            fileAnchors: ['events/alpha.txt'],
            confidence: 'high',
        }]);

        expect(second.appended).to.equal(0);
        expect(second.merged).to.equal(1);
        const stored = readStore(store);
        expect(stored.entries).to.have.lengthOf(1);
        expect(stored.entries[0].id).to.equal(firstId);
        expect(stored.entries[0].confidence).to.equal('high');
        expect(stored.entries[0].pitfalls).to.have.lengthOf(2, 'merge unions accumulated pitfalls');
        expect(stored.entries[0].pitfalls).to.include('namespace 与文件名不一致');
        expect(stored.entries[0].pitfalls).to.include('忘记在事件文件顶部声明 namespace');
        expect(stored.entries[0].fileAnchors).to.deep.equal(['events/alpha.txt']);
    });

    it('evicts the least-used stalest entries beyond the 200-entry cap', () => {
        const store = loadExperienceStoreModule();
        const filePath = store.getExperienceStoreFilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const now = Date.now();
        const entries = Array.from({ length: 200 }, (_, index) => ({
            id: `exp_seed_${index}`,
            title: `seed experience ${index}`,
            lesson: `seed lesson ${index} about bananas`,
            createdAt: now - index * 1000,
            usageCount: index === 0 ? 50 : 0,
            confidence: 'medium',
        }));
        fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries }), 'utf8');

        const result = store.appendExperiences(workspaceRoot, [{
            title: 'fresh new lesson',
            lesson: 'a genuinely new reusable approach for scripted effects',
        }]);
        expect(result.appended).to.equal(1);

        const stored = readStore(store);
        expect(stored.entries).to.have.lengthOf(200);
        const ids = stored.entries.map((entry: any) => entry.id);
        expect(ids).to.include('exp_seed_0', 'high-usage entry survives eviction');
        expect(ids).to.include(result.stored[0]!.id);
        expect(ids).to.not.include('exp_seed_199', 'oldest zero-usage entry is evicted first');
    });

    it('ignores stores written with an unknown version', () => {
        const store = loadExperienceStoreModule();
        const filePath = store.getExperienceStoreFilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({
            version: 999,
            entries: [{ id: 'x', title: 'foreign', lesson: 'foreign lesson', createdAt: 1, usageCount: 0, confidence: 'high' }],
        }), 'utf8');

        const found = store.searchExperiences(workspaceRoot, { taskText: 'foreign' });
        expect(found.text).to.equal('');
        expect(found.entries).to.have.lengthOf(0);
    });

    it('drops invalid entries when reading untrusted store JSON', () => {
        const store = loadExperienceStoreModule();
        const filePath = store.getExperienceStoreFilePath(workspaceRoot);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({
            version: 1,
            entries: [
                null,
                'garbage',
                { id: 'no-title', lesson: 'missing title' },
                { id: 'ok', title: 'valid entry', lesson: 'valid lesson about namespaces', createdAt: Date.now(), usageCount: 0, confidence: 'bogus' },
            ],
        }), 'utf8');

        const found = store.searchExperiences(workspaceRoot, { taskText: 'namespaces', markUsed: false });
        expect(found.entries).to.have.lengthOf(1);
        expect(found.entries[0]!.id).to.equal('ok');
        expect(found.entries[0]!.confidence).to.equal('medium', 'unknown confidence falls back to medium');
    });
});

describe('ExperienceStore search', () => {
    let workspaceRoot: string;

    beforeEach(() => {
        fs.mkdirSync(TEMP_BASE, { recursive: true });
        workspaceRoot = fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-exp-'));
        vscodeStub.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    });

    afterEach(() => {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        vscodeStub.workspace.workspaceFolders = [];
        try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty */ }
    });

    function seed(store: ReturnType<typeof loadExperienceStoreModule>): void {
        store.appendExperiences(workspaceRoot, [
            {
                title: 'scripted effect 参数化做法',
                lesson: '把重复的触发器链抽成 scripted_effect 并用参数传入 scope。',
                fileAnchors: ['common/scripted_effects/00_helpers.txt'],
                domain: 'paradox',
                confidence: 'high',
            },
            {
                title: 'helper script 复用',
                lesson: '临时 Python 批处理放进 scratch 目录的 agent_helper.py 反复覆写。',
                domain: 'general',
                confidence: 'low',
            },
            {
                title: 'unrelated banana note',
                lesson: 'nothing to do with the current task at all',
                confidence: 'medium',
            },
        ]);
    }

    it('ranks keyword-relevant entries first and formats the bounded block', () => {
        const store = loadExperienceStoreModule();
        seed(store);
        const found = store.searchExperiences(workspaceRoot, {
            taskText: '重构触发器链到 scripted_effect',
            domain: 'paradox',
        });

        expect(found.text).to.include('<task-experience>');
        expect(found.text).to.include('scripted effect 参数化做法');
        expect(found.text).to.include('</task-experience>');
        expect(found.entries[0]!.title).to.equal('scripted effect 参数化做法');
        expect(found.entries.map(entry => entry.title)).to.not.include('unrelated banana note');
        // No Markdown H2 headings: memory prompt tests count ^## occurrences.
        expect(found.text.match(/^## /gm)).to.equal(null);
    });

    it('filters entries by the active runtime domain', () => {
        const store = loadExperienceStoreModule();
        seed(store);
        const general = store.searchExperiences(workspaceRoot, {
            taskText: 'agent_helper.py 批处理',
            domain: 'general',
        });
        expect(general.entries.map(entry => entry.title)).to.include('helper script 复用');
        expect(general.entries.map(entry => entry.title)).to.not.include('scripted effect 参数化做法');

        const unfiltered = store.searchExperiences(workspaceRoot, {
            taskText: 'agent_helper.py 批处理',
            domain: 'both',
        });
        expect(unfiltered.entries.map(entry => entry.title)).to.include('helper script 复用');
    });

    it('enforces the maxChars budget', () => {
        const store = loadExperienceStoreModule();
        seed(store);
        const found = store.searchExperiences(workspaceRoot, {
            taskText: 'scripted_effect helper banana',
            maxChars: 220,
            markUsed: false,
        });
        expect(found.entries.length).to.be.lessThanOrEqual(1);
        const inner = found.text.replace(/<\/?task-experience>/g, '');
        expect(inner.length).to.be.lessThan(600);
    });

    it('marks returned entries used with a batched stats rewrite', () => {
        const store = loadExperienceStoreModule();
        seed(store);
        const before = JSON.parse(fs.readFileSync(store.getExperienceStoreFilePath(workspaceRoot), 'utf8'));
        const usedBefore = before.entries.find((entry: any) => entry.title === 'scripted effect 参数化做法');
        expect(usedBefore.usageCount ?? 0).to.equal(0);

        store.searchExperiences(workspaceRoot, { taskText: 'scripted_effect 抽参数', domain: 'paradox' });

        const after = JSON.parse(fs.readFileSync(store.getExperienceStoreFilePath(workspaceRoot), 'utf8'));
        const usedAfter = after.entries.find((entry: any) => entry.title === 'scripted effect 参数化做法');
        expect(usedAfter.usageCount).to.equal(1);
        expect(usedAfter.lastUsedAt).to.be.a('number');
        const untouched = after.entries.find((entry: any) => entry.title === 'unrelated banana note');
        expect(untouched.usageCount ?? 0).to.equal(0);
    });

    it('stays read-only when markUsed is false', () => {
        const store = loadExperienceStoreModule();
        seed(store);
        const filePath = store.getExperienceStoreFilePath(workspaceRoot);
        const beforeContent = fs.readFileSync(filePath, 'utf8');
        store.searchExperiences(workspaceRoot, { taskText: 'scripted_effect', markUsed: false });
        expect(fs.readFileSync(filePath, 'utf8')).to.equal(beforeContent);
    });

    it('returns an empty result for a missing store or empty workspace root', () => {
        const store = loadExperienceStoreModule();
        expect(store.searchExperiences(workspaceRoot, { taskText: 'anything' }).text).to.equal('');
        expect(store.searchExperiences('', { taskText: 'anything' }).text).to.equal('');
        expect(store.appendExperiences('', [{ title: 'x', lesson: 'y' }]).appended).to.equal(0);
    });
});
