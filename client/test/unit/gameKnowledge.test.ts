import { expect } from 'chai';
import { getGameKnowledge } from '../../extension/ai/gameKnowledge';

describe('game knowledge', () => {
    it('documents Stellaris optional scope operator restrictions', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('event_target:my_target? = { ... }');
        expect(knowledge).to.include('not part of the target key');
        expect(knowledge).to.include('prescripted_countries/');
        expect(knowledge).to.include('every_*');
        expect(knowledge).to.include('random_*');
        expect(knowledge).to.include('any_*');
        expect(knowledge).to.include('ordered_*');
        expect(knowledge).to.include('last_*');
        expect(knowledge).to.include('type = country');
        expect(knowledge).to.include('scope = <value>');
        expect(knowledge).to.include('trigger = { }');
        expect(knowledge).to.include('option = { }');
        expect(knowledge).to.include('immediate = { }');
    });

    it('documents Stellaris execution order and non-quantity inequality rules', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('top-to-bottom in textual order');
        expect(knowledge).to.include('save_event_target_as');
        expect(knowledge).to.include('must appear before the command that uses it');
        expect(knowledge).to.include('Treat `!=` like `>=`');
        expect(knowledge).to.include('numeric/amount/value comparisons only');
        expect(knowledge).to.include('not general inequality for IDs');
        expect(knowledge).to.include('NOT = { ... }');
        expect(knowledge).to.include('key != value');
    });

    it('uses active CWT rules for Stellaris override modes', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('query_override_modes');
        expect(knowledge).to.include('active CWT `priorities` rules');
        expect(knowledge).to.not.include('### Per-folder resolution');
        expect(knowledge).to.not.include('verified-against-the-table reference');
    });
});
