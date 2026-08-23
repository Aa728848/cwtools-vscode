import { expect } from 'chai';
import {
    MAX_SCOPE_BRIDGE_CANDIDATES,
    solveScopeBridge,
    type ScopeBridgeCandidate,
} from '../../extension/ai/tools/scopeBridge';

describe('solveScopeBridge', () => {
    it('uses bounded BFS and returns all shortest paths in deterministic order', () => {
        const candidates: ScopeBridgeCandidate[] = [
            { name: 'z_direct', supportedScopes: ['country'], pushScope: 'planet', evidence: 'rules:z' },
            { name: 'to_fleet', supportedScopes: ['country'], pushScope: 'fleet', evidence: 'rules:fleet' },
            { name: 'from_fleet', supportedScopes: ['fleet'], pushScope: 'planet', evidence: 'rules:planet' },
            { name: 'a_direct', supportedScopes: ['country'], pushScope: 'planet', evidence: ['rules:a', 'rules:a'] },
        ];

        const forward = solveScopeBridge({ fromScope: 'COUNTRY', toScope: 'planet', candidates });
        const reversed = solveScopeBridge({ fromScope: 'country', toScope: 'PLANET', candidates: [...candidates].reverse() });

        expect(forward).to.deep.equal(reversed);
        expect(forward.paths.map(path => path.steps.map(step => step.name))).to.deep.equal([
            ['a_direct'],
            ['z_direct'],
        ]);
        expect(forward.paths.map(path => path.rank)).to.deep.equal([1, 2]);
        expect(forward.confidence).to.equal(1);
        expect(forward.evidence).to.deep.equal(['rules:a']);
    });

    it('finds multi-hop bridges but does not search beyond four hops', () => {
        const candidates: ScopeBridgeCandidate[] = [
            { name: 'one', supportedScopes: ['country'], pushScope: 'fleet', evidence: 'e1' },
            { name: 'two', supportedScopes: ['fleet'], pushScope: 'ship', evidence: 'e2' },
            { name: 'three', supportedScopes: ['ship'], pushScope: 'system', evidence: 'e3' },
            { name: 'four', supportedScopes: ['system'], pushScope: 'planet', evidence: 'e4' },
            { name: 'five', supportedScopes: ['planet'], pushScope: 'pop', evidence: 'e5' },
        ];

        const fourHops = solveScopeBridge({ fromScope: 'country', toScope: 'planet', candidates });
        expect(fourHops.paths[0]!.steps.map(step => step.name)).to.deep.equal(['one', 'two', 'three', 'four']);
        expect(fourHops.confidence).to.equal(0.7);
        expect(fourHops.evidence).to.deep.equal(['e1', 'e2', 'e3', 'e4']);

        expect(solveScopeBridge({ fromScope: 'country', toScope: 'pop', candidates }).paths).to.deep.equal([]);
    });

    it('supports union scopes and any with lower confidence', () => {
        const union = solveScopeBridge({
            fromScope: 'union(country|planet)',
            toScope: 'ship',
            candidates: [
                { name: 'owners_ships', supportedScopes: ['planet'], pushScope: 'ship', evidence: 'completion:owners_ships' },
            ],
        });
        expect(union.paths[0]!.steps[0]!.fromScopes).to.deep.equal(['country', 'planet']);
        expect(union.confidence).to.equal(0.95);

        const any = solveScopeBridge({
            fromScope: 'country',
            toScope: 'planet',
            candidates: [
                { name: 'context_target', supportedScopes: ['any'], pushScope: 'planet', evidence: 'rule:any' },
            ],
        });
        expect(any.paths).to.have.length(1);
        expect(any.confidence).to.equal(0.85);
    });

    it('rejects unknown, incomplete, and evidence-free edges', () => {
        const result = solveScopeBridge({
            fromScope: 'country',
            toScope: 'planet',
            candidates: [
                { name: 'unknown_output', supportedScopes: ['country'], pushScope: 'unknown', evidence: 'rules:x' },
                { name: 'unknown_input', supportedScopes: ['country', 'unknown'], pushScope: 'planet', evidence: 'rules:y' },
                { name: 'no_evidence', supportedScopes: ['country'], pushScope: 'planet' },
                { name: 'blank_evidence', supportedScopes: ['country'], pushScope: 'planet', evidence: ['  '] },
                { name: 'no_output', supportedScopes: ['country'], evidence: 'rules:z' },
            ],
        });

        expect(result).to.deep.equal({ paths: [], confidence: 0, evidence: [] });
    });

    it('considers at most 200 deterministically sorted candidates', () => {
        const candidates: ScopeBridgeCandidate[] = Array.from(
            { length: MAX_SCOPE_BRIDGE_CANDIDATES },
            (_, index) => ({
                name: `a_decoy_${String(index).padStart(3, '0')}`,
                supportedScopes: ['fleet'],
                pushScope: 'ship',
                evidence: `decoy:${index}`,
            }),
        );
        candidates.unshift({
            name: 'z_over_limit',
            supportedScopes: ['country'],
            pushScope: 'planet',
            evidence: 'rules:late',
        });

        expect(solveScopeBridge({ fromScope: 'country', toScope: 'planet', candidates }).paths).to.deep.equal([]);
    });
});
