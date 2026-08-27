import { expect } from 'chai';

const vscodeStub = {
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: <T>(_k: string, d?: T): T | undefined => d }) },
    commands: { executeCommand: async () => undefined },
    window: {
        createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, clear: () => undefined, dispose: () => undefined }),
    },
    Uri: { file: (p: string) => ({ fsPath: p }) },
};

function loadModules() {
    const loader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = loader._load;
    loader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            schema: require('../../extension/ai/orchestrator/blackboardSchema') as typeof import('../../extension/ai/orchestrator/blackboardSchema'),
            blackboard: require('../../extension/ai/orchestrator/blackboard') as typeof import('../../extension/ai/orchestrator/blackboard'),
            agentTools: require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools'),
        };
    } finally {
        loader._load = originalLoad;
    }
}

const { schema, blackboard, agentTools } = loadModules();
const { validateBlackboardWrite, BLACKBOARD_KEY_PREFIXES } = schema;
const { Blackboard } = blackboard;
const { AgentToolExecutor } = agentTools;

describe('validateBlackboardWrite', () => {
    it('accepts free_text with arbitrary values', () => {
        expect(validateBlackboardWrite('free_text', 'any:key', '')).to.equal(undefined);
        expect(validateBlackboardWrite('free_text', 'any:key', '{"a":1}')).to.equal(undefined);
    });

    it('rejects non-string values and empty keys', () => {
        expect(validateBlackboardWrite('free_text', '', 'x')).to.include('key');
        expect(validateBlackboardWrite('free_text', 'k', 'x'.repeat(600 * 1024))).to.include('exceeds');
    });

    it('enforces the write_intent prefix and non-empty bounded values', () => {
        expect(validateBlackboardWrite('write_intent', `${BLACKBOARD_KEY_PREFIXES.intent}common/a.txt`, 'common/a.txt')).to.equal(undefined);
        expect(validateBlackboardWrite('write_intent', 'common/a.txt', 'common/a.txt')).to.include('prefix');
        expect(validateBlackboardWrite('write_intent', `${BLACKBOARD_KEY_PREFIXES.intent}x`, '')).to.include('non-empty');
        expect(validateBlackboardWrite('write_intent', `${BLACKBOARD_KEY_PREFIXES.intent}x`, 'p'.repeat(5000))).to.include('exceeds');
    });

    it('enforces entity_registry/entity_relation prefixes and accepts both value shapes', () => {
        // Contract-layer shape (JSON) and conflict-detector shape (plain id).
        expect(validateBlackboardWrite('entity_registry', `${BLACKBOARD_KEY_PREFIXES.entity}event:evt.1`, JSON.stringify({ nodeId: 'n1', contract: { kind: 'event', id: 'evt.1', operation: 'define' } }))).to.equal(undefined);
        expect(validateBlackboardWrite('entity_registry', `${BLACKBOARD_KEY_PREFIXES.entity}evt.1`, 'evt.1')).to.equal(undefined);
        expect(validateBlackboardWrite('entity_registry', 'evt.1', 'evt.1')).to.include('prefix');
        expect(validateBlackboardWrite('entity_relation', `${BLACKBOARD_KEY_PREFIXES.relation}n1:event:evt.1:define`, JSON.stringify({ nodeId: 'n1', contract: {} }))).to.equal(undefined);
        expect(validateBlackboardWrite('entity_relation', `${BLACKBOARD_KEY_PREFIXES.entity}x`, '{}')).to.include('prefix');
    });

    it('requires JSON and the quality-gate prefix for acceptance_evidence', () => {
        expect(validateBlackboardWrite('acceptance_evidence', `${BLACKBOARD_KEY_PREFIXES.qualityGate}final`, JSON.stringify({ passed: true }))).to.equal(undefined);
        expect(validateBlackboardWrite('acceptance_evidence', `${BLACKBOARD_KEY_PREFIXES.qualityGate}final`, 'not json')).to.include('JSON');
        expect(validateBlackboardWrite('acceptance_evidence', 'other:key', '{}')).to.include('prefix');
    });

    it('requires JSON for snapshot/scope/diagnostic entries', () => {
        for (const type of ['file_snapshot', 'scope_info', 'diag_result'] as const) {
            expect(validateBlackboardWrite(type, `k:${type}`, '{}')).to.equal(undefined);
            expect(validateBlackboardWrite(type, `k:${type}`, 'plain text')).to.include('JSON');
        }
    });

    it('rejects unknown types', () => {
        expect(validateBlackboardWrite('free_text' as never, 'k', 'v')).to.equal(undefined);
    });
});

describe('Blackboard write schema gate', () => {
    it('rejects malformed entries without storing them', () => {
        const bb = new Blackboard();
        const result = bb.write('__intent:common/a.txt', 'common/a.txt', 'write_intent', 'agent-1');
        expect(result.success).to.equal(true);
        // Wrong key prefix for the type: rejected.
        const bad = bb.write('common/a.txt', 'common/a.txt', 'write_intent', 'agent-1');
        expect(bad.success).to.equal(false);
        expect(bad.conflict).to.include('schema validation failed');
        expect(bb.read('common/a.txt')).to.equal(undefined);
        // The valid entry survived.
        expect(bb.read('__intent:common/a.txt')?.authorAgentId).to.equal('agent-1');
    });

    it('still allows every existing production write shape', () => {
        const bb = new Blackboard();
        // parallelExecutor handoff (free_text JSON under __handoff:)
        expect(bb.write(`${BLACKBOARD_KEY_PREFIXES.handoff}n1`, JSON.stringify({ summary: 's' }), 'free_text', 'n1').success).to.equal(true);
        // parallelExecutor entity contract registry
        expect(bb.write(`${BLACKBOARD_KEY_PREFIXES.entity}event:evt.1`, JSON.stringify({ nodeId: 'n1', contract: { kind: 'event', id: 'evt.1', operation: 'define' } }), 'entity_registry', 'n1').success).to.equal(true);
        // conflictDetector entity registration (plain id value)
        expect(bb.write(`${BLACKBOARD_KEY_PREFIXES.entity}evt.1`, 'evt.1', 'entity_registry', 'n2').success).to.equal(true);
        // conflictDetector write intent
        expect(bb.write(`${BLACKBOARD_KEY_PREFIXES.intent}common/a.txt`, 'common/a.txt', 'write_intent', 'n2').success).to.equal(true);
        // orchestrator clarification (free_text)
        expect(bb.write(`${BLACKBOARD_KEY_PREFIXES.clarification}n1`, 'Need more input.', 'free_text', 'n1').success).to.equal(true);
        // quality gate evidence
        expect(bb.write(`${BLACKBOARD_KEY_PREFIXES.qualityGate}final`, JSON.stringify({ passed: true }), 'acceptance_evidence', '__quality_gate__').success).to.equal(true);
        // set_memory mapping
        expect(bb.setFreeText('memory:key', 'value')).to.equal(undefined);
    });
});

describe('query_blackboard structured parsing', () => {
    it('returns parsed JSON and flags non-JSON values', async () => {
        const executor = new AgentToolExecutor({} as any, process.cwd());
        executor.blackboard.write('domain:general:topic:session:cfg', JSON.stringify({ a: 1 }), 'free_text', 'test');
        executor.blackboard.write('domain:general:topic:session:note', 'plain text', 'free_text', 'test');
        const ctx = { runnerOptions: { mode: 'orchestrator', domain: 'general' } } as any;

        const raw = await executor.execute('query_blackboard', { key: 'cfg' }, ctx) as any;
        expect(raw.entry.value).to.equal('{"a":1}');
        expect(raw.entry.parsed).to.equal(undefined);

        const parsed = await executor.execute('query_blackboard', { key: 'cfg', structured: true }, ctx) as any;
        expect(parsed.entry.parsed).to.deep.equal({ a: 1 });

        const nonJson = await executor.execute('query_blackboard', { key: 'note', structured: true }, ctx) as any;
        expect(nonJson.entry.parseError).to.equal(true);
        expect(nonJson.entry.value).to.equal('plain text');

        const byType = await executor.execute('query_blackboard', { type: 'free_text', structured: true }, ctx) as any;
        expect(byType.entries.length).to.be.greaterThan(0);
        expect(byType.entries.some((entry: any) => entry.key === 'cfg' && entry.parsed?.a === 1)).to.equal(true);
    });
});
