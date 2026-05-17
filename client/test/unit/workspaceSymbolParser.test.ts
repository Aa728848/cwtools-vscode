import { expect } from 'chai';
import {
    addSymbolsToIndex,
    parseWorkspaceSymbols,
    queryWorkspaceSymbolIndex,
    removeFileFromSymbolIndex,
    type WorkspaceSymbolEntry,
} from '../../extension/indexing/workspaceSymbolParser';

describe('Workspace Symbol Parser (indexing)', () => {
    it('parses event IDs and namespaces from event files', () => {
        const entries = parseWorkspaceSymbols([
            'namespace = kuat',
            'country_event = {',
            '    id = kuat.100',
            '    title = kuat.100.title',
            '}',
        ].join('\n'), '/mod/events/kuat_events.txt');

        expect(entries.map(entry => entry.name)).to.include('kuat');
        const event = entries.find(entry => entry.name === 'kuat.100');
        expect(event).to.deep.include({
            kind: 'event',
            line: 3,
            source: 'script',
            container: 'country_event',
        });
    });

    it('infers common scripted trigger and technology symbols', () => {
        const trigger = parseWorkspaceSymbols('kuat_is_force_user = {\n}', '/mod/common/scripted_triggers/kuat.txt');
        const tech = parseWorkspaceSymbols('tech_kuat_reactor = {\n}', '/mod/common/technology/kuat.txt');

        expect(trigger[0]).to.deep.include({ name: 'kuat_is_force_user', kind: 'scripted_trigger' });
        expect(tech[0]).to.deep.include({ name: 'tech_kuat_reactor', kind: 'technology' });
    });

    it('parses named sprite and sound assets', () => {
        const entries = parseWorkspaceSymbols([
            'spriteTypes = {',
            '    spriteType = {',
            '        name = "GFX_evt_kuat_echo"',
            '        texturefile = "gfx/event_pictures/kuat.dds"',
            '    }',
            '}',
            'sound = {',
            '    name = kuat_force_echo',
            '}',
        ].join('\n'), '/mod/interface/kuat.gfx');

        expect(entries.find(entry => entry.name === 'GFX_evt_kuat_echo')).to.deep.include({
            kind: 'sprite',
            source: 'asset',
            container: 'spriteType',
        });
        expect(entries.find(entry => entry.name === 'kuat_force_echo')).to.deep.include({
            kind: 'sound',
            source: 'asset',
            container: 'sound',
        });
    });

    it('queries indexed symbols by prefix, kind, source, and directory', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'kuat.100', kind: 'event', source: 'script', file: '/mod/events/kuat.txt', line: 1 },
            { name: 'tech_kuat_reactor', kind: 'technology', source: 'script', file: '/mod/common/technology/kuat.txt', line: 2 },
            { name: 'GFX_evt_kuat_echo', kind: 'sprite', source: 'asset', file: '/mod/interface/kuat.gfx', line: 3 },
        ]);

        expect(queryWorkspaceSymbolIndex(index, { name: 'kuat', prefix: true })).to.have.lengthOf(1);
        expect(queryWorkspaceSymbolIndex(index, { kind: 'sprite', source: 'asset' })[0]!.name).to.equal('GFX_evt_kuat_echo');
        expect(queryWorkspaceSymbolIndex(index, { directory: 'common/technology' })[0]!.name).to.equal('tech_kuat_reactor');
    });

    it('removes stale symbols for a deleted file', () => {
        const index = new Map<string, WorkspaceSymbolEntry[]>();
        addSymbolsToIndex(index, [
            { name: 'kuat.100', kind: 'event', source: 'script', file: '/mod/events/kuat.txt', line: 1 },
            { name: 'kuat.101', kind: 'event', source: 'script', file: '/mod/events/other.txt', line: 1 },
        ]);

        removeFileFromSymbolIndex(index, '/mod/events/kuat.txt');

        expect(index.has('kuat.100')).to.equal(false);
        expect(index.has('kuat.101')).to.equal(true);
    });
});
