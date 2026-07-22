import { expect } from 'chai';
import { getGameKnowledge } from '../../extension/ai/gameKnowledge';

describe('game knowledge', () => {
    it('keeps mutable game facts out of the prompt and routes them to active evidence', () => {
        const knowledge = getGameKnowledge('stellaris');

        expect(knowledge).to.include('Stellaris PDXScript modding');
        expect(knowledge).to.include('intentionally contains no game-version rule tables');
        expect(knowledge).to.include('query_rules');
        expect(knowledge).to.include('query_scope');
        expect(knowledge).to.include('query_cwt_schema');
        expect(knowledge).to.include('query_types');
        expect(knowledge).to.include('parse_pdx_fragment');
        expect(knowledge).to.include('query_override_modes');
        expect(knowledge).to.include('active game profile');
        expect(knowledge).to.include('source/revision');

        for (const fixedFact of [
            'save_event_target_as',
            'country_event',
            'planet_event',
            'common/ship_sizes',
            'tech_lasers_1',
            'trait_robot',
            'LIOS',
            'FIOS',
            'l_simp_chinese',
            'key = value',
            '!=',
        ]) {
            expect(knowledge, fixedFact).to.not.include(fixedFact);
        }
    });

    it('uses the same evidence policy for every profile instead of per-game fact copies', () => {
        const stellaris = getGameKnowledge('stellaris');
        const hoi4 = getGameKnowledge('hoi4');
        const generic = getGameKnowledge('unknown-profile');
        const body = (value: string) => value.slice(value.indexOf('\n') + 1);

        expect(stellaris).to.include('Stellaris PDXScript modding');
        expect(hoi4).to.include('Hearts of Iron IV PDXScript modding');
        expect(generic).to.include('Generic Paradox PDXScript modding');
        expect(body(stellaris)).to.equal(body(hoi4));
        expect(body(hoi4)).to.equal(body(generic));
    });
});
