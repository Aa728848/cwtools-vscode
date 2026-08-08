import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EvidenceLedger } from '../../extension/ai/evidence/evidenceLedger';
import type { EvidenceGateDecision } from '../../extension/ai/evidence/evidenceTypes';

function makeDecision(overrides: Partial<EvidenceGateDecision> = {}): EvidenceGateDecision {
    return {
        version: 1,
        decisionId: 'eg_test',
        tool: 'write_file',
        target: 'events/test.txt',
        mode: 'enforce',
        phase: 'pre_write',
        verdict: 'allow',
        claims: [{
            kind: 'symbol_exists',
            claim: "effect 'add_opinion_modifier' exists",
            status: 'verified',
            blocking: true,
            sources: [{
                tool: 'lsp.queryDefinitionByName',
                target: 'add_opinion_modifier',
                gameProfile: 'stellaris',
                revision: 'idx:123',
                observedAt: new Date(0).toISOString(),
            }],
        }],
        missingEvidence: [],
        evaluatedAt: new Date(0).toISOString(),
        durationMs: 10,
        ...overrides,
    };
}

describe('EvidenceLedger', () => {
    let root: string;
    let ledger: EvidenceLedger;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-evidence-ledger-'));
        ledger = new EvidenceLedger({ root });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('misses on an empty ledger', () => {
        expect(ledger.lookup('key-1', 'rev-1')).to.equal(undefined);
    });

    it('roundtrips a verified allow decision at the same evidence revision', async () => {
        const decision = makeDecision();
        await ledger.store('key-1', decision, 'rev-1');
        const hit = ledger.lookup('key-1', 'rev-1');
        expect(hit).to.not.equal(undefined);
        expect(hit!.verdict).to.equal('allow');
        expect(hit!.claims[0]!.status).to.equal('verified');
        // A newer evidence revision must not reuse the old decision.
        expect(ledger.lookup('key-1', 'rev-2')).to.equal(undefined);
    });

    it('persists across instances (survives a fresh ledger object)', async () => {
        const decision = makeDecision();
        await ledger.store('key-1', decision, 'rev-1');
        const second = new EvidenceLedger({ root });
        const hit = second.lookup('key-1', 'rev-1');
        expect(hit).to.not.equal(undefined);
        expect(hit!.decisionId).to.equal('eg_test');
    });

    it('never stores block verdicts or degraded allow decisions', async () => {
        await ledger.store('key-block', makeDecision({ verdict: 'block' }), 'rev-1');
        await ledger.store('key-degraded', makeDecision({ degraded: true }), 'rev-1');
        await ledger.store('key-unverified', makeDecision({
            claims: [{
                kind: 'symbol_exists',
                claim: 'x',
                status: 'unknown',
                blocking: true,
                sources: [],
            }],
        }), 'rev-1');
        expect(ledger.lookup('key-block', 'rev-1')).to.equal(undefined);
        expect(ledger.lookup('key-degraded', 'rev-1')).to.equal(undefined);
        expect(ledger.lookup('key-unverified', 'rev-1')).to.equal(undefined);
    });

    it('clearAll drops persisted decisions', async () => {
        await ledger.store('key-1', makeDecision(), 'rev-1');
        await ledger.clearAll();
        expect(ledger.lookup('key-1', 'rev-1')).to.equal(undefined);
        // A fresh instance sees the cleared file too.
        const second = new EvidenceLedger({ root });
        expect(second.lookup('key-1', 'rev-1')).to.equal(undefined);
    });

    it('bounds entries to maxEntries, evicting the oldest first', async () => {
        const bounded = new EvidenceLedger({ root, maxEntries: 3 });
        for (let i = 0; i < 5; i++) {
            await bounded.store(`key-${i}`, makeDecision(), 'rev-1');
        }
        expect(bounded.lookup('key-0', 'rev-1')).to.equal(undefined);
        expect(bounded.lookup('key-1', 'rev-1')).to.equal(undefined);
        // The two newest entries survive.
        expect(bounded.lookup('key-3', 'rev-1')).to.not.equal(undefined);
        expect(bounded.lookup('key-4', 'rev-1')).to.not.equal(undefined);
    });
});
