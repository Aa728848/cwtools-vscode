import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    addMissingCwtScopeContracts,
    compareScopeContracts,
    extractScopeContractsFromText,
    loadScopeAliases,
    parseCwtScopeContracts,
} from './scope-contracts';

const aliases = new Map([
    ['ship', 'ship'],
    ['planet', 'planet'],
    ['country', 'country'],
    ['fleet', 'fleet'],
    ['colony', 'colony'],
    ['system', 'system'],
]);

describe('Stellaris scope contracts', () => {
    it('extracts THIS/ROOT and the ordered FROM chain from adjacent comments', () => {
        const contracts = extractScopeContractsFromText(`
# A country has surveyed a planet.
# Root = Planet
# From = Country
# FromFrom = Fleet of the science ship, if any
on_planet_surveyed = {
    events = { test.1 }
}
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contracts).to.have.length(1);
        expect(contracts[0]!.scope).to.deep.equal({ this: 'planet', root: 'planet', from: ['country', 'fleet'] });
        expect(contracts[0]!.confidence).to.equal('high');
    });

    it('treats Scope as THIS and ROOT', () => {
        const [contract] = extractScopeContractsFromText(`
# Scope = Ship
# From = Planet
on_survey_planet = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'ship', root: 'ship', from: ['planet'] });
    });

    it('treats ROOT/This as both entry fields', () => {
        const [contract] = extractScopeContractsFromText(`
# ROOT/This = Country
can_trade = { }
`, 'game_rules/00_rules.txt', 'game_rules', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'country', root: 'country', from: [] });
    });

    it('defaults an omitted THIS to ROOT for game rules', () => {
        const [contract] = extractScopeContractsFromText(`
# Root = fleet, potential attacker
# From = planet, potential target
can_orbital_bombard = { }
`, 'game_rules/00_rules.txt', 'game_rules', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'fleet', root: 'fleet', from: ['planet'] });
    });

    it('maps a supported planet-or-fleet description to its union scope', () => {
        const [contract] = extractScopeContractsFromText(`
# This = target planet or triggering fleet
# From = Country
on_ship_destroyed = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.confidence).to.equal('high');
        expect(contract!.scope.this).to.equal('planet_fleet');
        expect(contract!.unresolved).to.deep.equal([]);
    });

    it('maps a planet-or-ship description to the Carrier union scope', () => {
        const [contract] = extractScopeContractsFromText(`
# This/Root = planet or ship
on_colony_host_changed = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.confidence).to.equal('high');
        expect(contract!.scope).to.deep.equal({ this: 'carrier', root: 'carrier', from: [] });
        expect(contract!.unresolved).to.deep.equal([]);
    });

    it('maps a supported leading polymorphic description to its union scope', () => {
        const [contract] = extractScopeContractsFromText(`
# This = starbase, megastructure or planet
can_repair = { }
`, 'game_rules/00_rules.txt', 'game_rules', new Map([
            ...aliases,
            ['starbase', 'starbase'],
            ['megastructure', 'megastructure'],
        ]));

        expect(contract!.confidence).to.equal('high');
        expect(contract!.scope.this).to.equal('repairable_orbital');
        expect(contract!.unresolved).to.deep.equal([]);
    });

    it('treats comma-separated This, root as both entry fields', () => {
        const [contract] = extractScopeContractsFromText(`
# This, root = Country
can_modify = { }
`, 'game_rules/00_rules.txt', 'game_rules', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'country', root: 'country', from: [] });
    });

    it('normalizes Stellaris owner roles to country scope', () => {
        const [contract] = extractScopeContractsFromText(`
# This = PopGroup
# From = Planet Owner
on_ethics_tick = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', new Map([...aliases, ['popgroup', 'pop_group']]));

        expect(contract!.scope).to.deep.equal({ this: 'pop_group', root: 'pop_group', from: ['country'] });
    });

    it('does not collapse an explicit object-or-owner alternative to country', () => {
        const [contract] = extractScopeContractsFromText(`
# This = planet or planet owner
on_target_selected = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.confidence).to.equal('medium');
        expect(contract!.scope.this).to.equal(undefined);
    });

    it('extracts multiple assignments from one comment line', () => {
        const [contract] = extractScopeContractsFromText(`
# This = owner country, From = fleet
on_fleet_changed = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'country', root: 'country', from: ['fleet'] });
    });

    it('extracts assignments embedded after prose and strips sentence punctuation', () => {
        const [contract] = extractScopeContractsFromText(`
# Arkship lure spawned. THIS = target system, FROM = arkship fleet.
on_lure_spawned = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'system', root: 'system', from: ['fleet'] });
        expect(contract!.unresolved).to.deep.equal([]);
    });

    it('preserves an omitted FROM level with Any before FROMFROM', () => {
        const [contract] = extractScopeContractsFromText(`
# This = Country
# FromFrom = Fleet
on_deep_scope = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'country', root: 'country', from: ['any', 'fleet'] });
        expect(contract!.confidence).to.equal('high');
    });

    it('prefers an explicit type label over role words in its description', () => {
        const [contract] = extractScopeContractsFromText(`
# THIS = System: system whose controller changed
# FROM = Country: new controller
on_controller_changed = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'system', root: 'system', from: ['country'] });
    });

    it('ignores an empty heading assignment when later comments define the contract', () => {
        const [contract] = extractScopeContractsFromText(`
# Scope:
# This/Root = Planet
# From = Fleet
on_destroyed = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'planet', root: 'planet', from: ['fleet'] });
        expect(contract!.confidence).to.equal('high');
    });

    it('normalizes an unambiguous adjective around a known scope', () => {
        const [contract] = extractScopeContractsFromText(`
# This = allied country
# From = current colony
on_relation_changed = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'country', root: 'country', from: ['colony'] });
        expect(contract!.confidence).to.equal('high');
    });

    it('parses existing CWT replace_scope metadata and reports mismatches', () => {
        const cwt = `
## type_key_filter = on_survey_planet
## replace_scope = { this = country root = country from = planet }
subtype[on_survey_planet] = { }
`;
        const parsed = parseCwtScopeContracts(cwt, 'common/on_actions.cwt', 'on_actions');
        const [expected] = extractScopeContractsFromText(`
# Scope = Ship
# From = Planet
on_survey_planet = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);
        const actual = new Map([['on_actions:on_survey_planet', parsed[0]!]]);
        const findings = compareScopeContracts([expected!], actual);

        expect(findings).to.have.length(1);
        expect(findings[0]!.status).to.equal('mismatch');
        expect(findings[0]!.differences).to.include('this: expected ship, got country');
    });

    it('adds only missing high-confidence annotations', () => {
        const contracts = extractScopeContractsFromText(`
# Scope = Ship
# From = Planet
on_survey_planet = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);
        const result = addMissingCwtScopeContracts(`
## type_key_filter = on_survey_planet
subtype[on_survey_planet] = { }
`, 'on_actions', contracts);

        expect(result.added).to.deep.equal(['on_survey_planet']);
        expect(result.content).to.contain('## replace_scope = { this = ship root = ship from = planet }');
    });

    it('augments missing fields without replacing a conflicting scope', () => {
        const [contract] = extractScopeContractsFromText(`
# This = Colony
# Root = Country
can_build = { }
`, 'game_rules/00_rules.txt', 'game_rules', aliases);
        const partial = addMissingCwtScopeContracts(`
## type_key_filter = can_build
## replace_scope = { root = country }
subtype[can_build] = { }
`, 'game_rules', [contract!]);
        expect(partial.content).to.contain('## replace_scope = { this = colony root = country }');

        const conflicting = addMissingCwtScopeContracts(`
## type_key_filter = can_build
## replace_scope = { this = planet root = country }
subtype[can_build] = { }
`, 'game_rules', [contract!]);
        expect(conflicting.added).to.deep.equal([]);
        expect(conflicting.content).to.contain('this = planet');
    });

    it('replaces a conflicting contract only with explicit authorization', () => {
        const [contract] = extractScopeContractsFromText(`
# This = Country
can_build = { }
`, 'game_rules/00_rules.txt', 'game_rules', aliases);
        const result = addMissingCwtScopeContracts(`
## type_key_filter = can_build
## replace_scope = { this = planet root = planet }
subtype[can_build] = { }
`, 'game_rules', [contract!], { replaceConflicts: true });

        expect(result.added).to.deep.equal(['can_build']);
        expect(result.content).to.contain('## replace_scope = { this = country root = country }');
    });

    it('maps vanilla pop and star comments to pop_group and planet', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-contracts-'));
        const scopesFile = path.join(dir, 'scopes.cwt');
        fs.writeFileSync(scopesFile, `
Pop = {
    aliases = { pop }
}
"Pop Group" = {
    aliases = { pop_group }
}
Star = {
    aliases = { star }
}
Planet = {
    aliases = { planet }
}
`);
        const loaded = loadScopeAliases(scopesFile);
        expect(loaded.get('pop')).to.equal('pop_group');
        expect(loaded.get('star')).to.equal('planet');

        const [popRule] = extractScopeContractsFromText(`
#this/root = pop
can_fill_drone_job = { }
`, 'game_rules/00_rules.txt', 'game_rules', loaded);
        expect(popRule!.scope).to.deep.equal({ this: 'pop_group', root: 'pop_group', from: [] });

        const [starRule] = extractScopeContractsFromText(`
# root/this = star
can_initiate_storm_on_planet = { }
`, 'game_rules/00_rules.txt', 'game_rules', loaded);
        expect(starRule!.scope).to.deep.equal({ this: 'planet', root: 'planet', from: [] });
    });

    it('resolves the opponent role to the country scope', () => {
        const [contract] = extractScopeContractsFromText(`
#An army has been killed in ground combat
# This = owner
# From = army
# FromFrom = opponent
# FromFromFrom = colony
on_army_killed_in_combat = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', new Map([...aliases, ['army', 'army']]));

        expect(contract!.scope).to.deep.equal({ this: 'country', root: 'country', from: ['army', 'country', 'colony'] });
        expect(contract!.confidence).to.equal('high');
    });

    it('applies the on_ship_built comment errata instead of reporting a mismatch', () => {
        const [contract] = extractScopeContractsFromText(`
# Scope: Ship Event
#A ship has been built
# Root = Ship
# From = Planet
on_ship_built = { }
`, 'on_actions/00_on_actions.txt', 'on_actions', aliases);

        expect(contract!.scope).to.deep.equal({ this: 'ship', root: 'ship', from: ['starbase'] });
        expect(contract!.evidence.some(line => line.includes('errata'))).to.equal(true);

        const parsed = parseCwtScopeContracts(`
## type_key_filter = on_ship_built
## replace_scope = { this = ship root = ship from = starbase }
subtype[on_ship_built] = { }
`, 'common/on_actions.cwt', 'on_actions');
        const findings = compareScopeContracts([contract!], new Map([['on_actions:on_ship_built', parsed[0]!]]));
        expect(findings).to.deep.equal([]);
    });
});
