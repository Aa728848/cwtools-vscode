import { expect } from 'chai';
import { getGameKnowledge } from '../../extension/ai/gameKnowledge';

describe('game knowledge', () => {
    it('defers Stellaris scope facts to active evidence', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('Do not rely on static prompt knowledge for scopes');
        expect(knowledge).to.include('optional scope syntax');
        expect(knowledge).to.include('dynamic game-version facts');
        expect(knowledge).to.include('query_scope');
        expect(knowledge).to.include('query_rules(category="scope_change")');
        expect(knowledge).to.include('query_cwt_schema');
        expect(knowledge).to.include('get_completion_at');
        expect(knowledge).to.include('active CWT/LSP evidence');
        expect(knowledge).to.not.include('event_target:my_target? = { ... }');
        expect(knowledge).to.not.include('not part of the target key');
        expect(knowledge).to.not.include('prescripted_countries/');
        expect(knowledge).to.not.include('every_*');
        expect(knowledge).to.not.include('random_*');
        expect(knowledge).to.not.include('any_*');
        expect(knowledge).to.not.include('ordered_*');
        expect(knowledge).to.not.include('last_*');
        expect(knowledge).to.not.include('type = country');
        expect(knowledge).to.not.include('scope = <value>');
        expect(knowledge).to.not.include('trigger = { }');
        expect(knowledge).to.not.include('option = { }');
        expect(knowledge).to.not.include('immediate = { }');
    });

    it('documents Stellaris execution order and non-quantity inequality rules', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('top-to-bottom in textual order');
        expect(knowledge).to.include('must appear before the command that uses them');
        expect(knowledge).to.not.include('save_event_target_as');
        expect(knowledge).to.include('Treat `!=` like `>=`');
        expect(knowledge).to.include('numeric/amount/value comparisons only');
        expect(knowledge).to.include('not general inequality for IDs');
        expect(knowledge).to.include('NOT = { ... }');
        expect(knowledge).to.include('key != value');
    });

    it('uses active CWT rules for Stellaris override modes', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('query_override_modes');
        expect(knowledge).to.include('active CWT');
        expect(knowledge).to.include('modeInfo');
        expect(knowledge).to.include('matchedModeInfo');
        expect(knowledge).to.include('override_modes_info');
        // The per-mode meaning table is no longer hard-coded in the prompt;
        // it is sourced from the CWT `override_modes_info` block via the tool.
        expect(knowledge).to.not.include('### Per-folder resolution');
        expect(knowledge).to.not.include('verified-against-the-table reference');
        expect(knowledge).to.not.include('| **LIOS** | Last In, Only Served |');
        expect(knowledge).to.not.include('| **FIOS** | First In, Only Served |');
    });
});
