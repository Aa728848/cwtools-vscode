import { expect } from 'chai';
import { queryInterfaceKnowledge } from '../../extension/ai/interfaceKnowledge';

describe('Stellaris Interface knowledge', () => {
    it('always returns crash-risk preservation rules with source revision metadata', () => {
        const result = queryInterfaceKnowledge({
            topic: 'buttons_and_effects',
            elementType: 'effectButtonType',
        });
        const source = result.source as Record<string, unknown>;
        const critical = result.criticalSafetyRules as Array<Record<string, unknown>>;

        expect(result.status).to.equal('ready');
        expect(result.scope).to.equal('stellaris_interface');
        expect(source.revisionId).to.equal(106757);
        expect(source.license).to.equal('CC BY-SA 3.0');
        expect(critical.map(entry => entry.id)).to.include.members([
            'preserve_engine_bound_controls',
            'custom_window_contract',
        ]);
        expect(result.instruction).to.include('Never delete');
    });

    it('ranks button and effect relationships for effectButtonType queries', () => {
        const result = queryInterfaceKnowledge({
            topic: 'buttons_and_effects',
            query: 'button action effect',
            elementType: 'effectButtonType',
            limit: 1,
        });
        const entries = result.entries as Array<Record<string, unknown>>;

        expect(entries).to.have.length(1);
        expect(entries[0]?.id).to.equal('button_effect_relationship');
        expect(entries[0]?.summary).to.include('/common/button_effects/');
    });

    it('bounds malformed limits and falls back to all topics', () => {
        const result = queryInterfaceKnowledge({ topic: 'not-a-topic', limit: 999 });
        const entries = result.entries as Array<Record<string, unknown>>;

        expect(result.topic).to.equal('all');
        expect(entries.length).to.be.at.most(10);
    });
});
