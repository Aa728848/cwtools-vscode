import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import {
    aggregateDirectorySuggestions,
    isUriPathWithin,
    LatestDirectoryRequest,
    relativeUriPathWithin,
    validateRelativeDirectoryPath,
    VanillaDirectoryCache,
} from '../../extension/directoryCompletions';
import { getAllLanguageIds, getProfileByLanguageId } from '../../extension/gameProfiles';
import { parsePdxSemanticCatalog } from '../../shared/pdxSemanticCatalog';

describe('Paradox directory completions', () => {
    it('extracts only the direct child of the selected parent', () => {
        const suggestions = aggregateDirectorySuggestions({
            parentRelativePath: 'common',
            gameId: 'stellaris',
            cwtPaths: [
                { path: 'common/technologies', entityTypes: ['technology'] },
                { path: 'common/technologies/categories', entityTypes: ['category'] },
                { path: 'events', entityTypes: ['event'] },
            ],
            profile: getProfileByLanguageId('stellaris'),
            vanillaChildNames: [],
            existingEntries: [],
            caseInsensitive: false,
        });
        expect(suggestions.map(item => item.relativePath)).to.deep.equal(['common/technologies']);
        expect(suggestions[0]?.entityTypes).to.deep.equal(['category', 'technology']);
    });

    it('merges CWT, profile and vanilla evidence with authoritative confidence', () => {
        const suggestions = aggregateDirectorySuggestions({
            parentRelativePath: '',
            gameId: 'stellaris',
            cwtPaths: [{ path: 'common', entityTypes: ['technology'] }],
            profile: getProfileByLanguageId('stellaris'),
            vanillaChildNames: ['common'],
            existingEntries: [],
            caseInsensitive: false,
        });
        const common = suggestions.find(item => item.segment === 'common');
        expect(common).to.deep.include({
            relativePath: 'common',
            sources: ['cwt', 'profile', 'vanilla'],
            confidence: 'authoritative',
        });
        expect(common?.entityTypes).to.deep.equal(['technology']);
    });

    it('removes existing directories and same-name files', () => {
        const suggestions = aggregateDirectorySuggestions({
            parentRelativePath: '',
            gameId: 'hoi4',
            cwtPaths: [
                { path: 'common', entityTypes: ['idea'] },
                { path: 'events', entityTypes: ['event'] },
            ],
            profile: getProfileByLanguageId('hoi4'),
            vanillaChildNames: ['history'],
            existingEntries: [
                { name: 'common', type: 'directory' },
                { name: 'events', type: 'file' },
            ],
            caseInsensitive: false,
        });
        expect(suggestions.map(item => item.segment)).not.to.include.members(['common', 'events']);
        expect(suggestions.map(item => item.segment)).to.include('history');
    });

    it('folds path and existence case only for case-insensitive file systems', () => {
        const base = {
            parentRelativePath: 'Common',
            gameId: 'paradox',
            cwtPaths: [{ path: 'common/Traits', entityTypes: ['trait'] }],
            profile: undefined,
            vanillaChildNames: [],
            existingEntries: [{ name: 'traits', type: 'directory' as const }],
        };
        expect(aggregateDirectorySuggestions({ ...base, caseInsensitive: true })).to.deep.equal([]);
        expect(aggregateDirectorySuggestions({ ...base, caseInsensitive: false })).to.deep.equal([]);
        const caseSensitive = aggregateDirectorySuggestions({
            ...base,
            parentRelativePath: 'common',
            existingEntries: [{ name: 'traits', type: 'directory' }],
            caseInsensitive: false,
        });
        expect(caseSensitive.map(item => item.segment)).to.deep.equal(['Traits']);
    });

    it('never suggests localisation_synced for built-in games or fallback sources', () => {
        for (const gameId of getAllLanguageIds()) {
            const suggestions = aggregateDirectorySuggestions({
                parentRelativePath: '',
                gameId,
                cwtPaths: [{ path: 'localisation_synced', entityTypes: ['localisation'] }],
                profile: getProfileByLanguageId(gameId),
                vanillaChildNames: ['localisation_synced'],
                existingEntries: [],
                caseInsensitive: false,
            });
            expect(suggestions.map(item => item.segment), gameId).not.to.include('localisation_synced');
        }
        const genericFallback = aggregateDirectorySuggestions({
            parentRelativePath: '',
            gameId: 'paradox',
            cwtPaths: [],
            profile: getProfileByLanguageId('paradox'),
            vanillaChildNames: ['localisation_synced'],
            existingEntries: [],
            caseInsensitive: false,
        });
        expect(genericFallback.map(item => item.segment)).not.to.include('localisation_synced');
    });

    it('allows localisation_synced for Generic only when active custom CWT declares it', () => {
        const suggestions = aggregateDirectorySuggestions({
            parentRelativePath: '',
            gameId: 'paradox',
            cwtPaths: [{ path: 'localisation_synced', entityTypes: ['custom_localisation'] }],
            profile: getProfileByLanguageId('paradox'),
            vanillaChildNames: ['localisation_synced'],
            existingEntries: [],
            caseInsensitive: false,
        });
        const retired = suggestions.find(item => item.segment === 'localisation_synced');
        expect(retired).to.not.equal(undefined);
        expect(retired?.sources).to.deep.equal(['cwt']);
    });

    it('covers every registered game and Generic with CWT/profile/vanilla/project merging', () => {
        const expectedLocalisation: Record<string, string> = {
            stellaris: 'localisation',
            hoi4: 'localisation',
            eu4: 'localisation',
            eu5: 'localization',
            ck2: 'localisation',
            ck3: 'localization',
            imperator: 'localization',
            vic2: 'localisation',
            vic3: 'localization',
            paradox: 'localisation',
        };
        for (const gameId of [...getAllLanguageIds(), 'paradox']) {
            const entityFolder = `${gameId}_entities`;
            const suggestions = aggregateDirectorySuggestions({
                parentRelativePath: '',
                gameId,
                cwtPaths: [{ path: `common/${entityFolder}`, entityTypes: [`${gameId}_entity`] }],
                profile: getProfileByLanguageId(gameId),
                vanillaChildNames: [`${gameId}_vanilla_only`],
                existingEntries: [{ name: 'events', type: 'directory' }],
                caseInsensitive: false,
            });
            const names = suggestions.map(item => item.segment);
            expect(names, `${gameId} CWT parent`).to.include('common');
            expect(names, `${gameId} profile localisation`).to.include(expectedLocalisation[gameId]);
            expect(names, `${gameId} vanilla`).to.include(`${gameId}_vanilla_only`);
            expect(names, `${gameId} existing`).not.to.include('events');
            expect(names, `${gameId} retired localisation`).not.to.include('localisation_synced');

            const nested = aggregateDirectorySuggestions({
                parentRelativePath: 'common',
                gameId,
                cwtPaths: [{ path: `common/${entityFolder}`, entityTypes: [`${gameId}_entity`] }],
                profile: getProfileByLanguageId(gameId),
                vanillaChildNames: [`${gameId}_observed_child`],
                existingEntries: [],
                caseInsensitive: false,
            });
            expect(nested.map(item => item.segment)).to.include.members([entityFolder, `${gameId}_observed_child`]);
        }
    });

    it('validates single and multi-segment relative paths and rejects traversal', () => {
        expect(validateRelativeDirectoryPath('common/new_types', false)).to.deep.equal({
            ok: true,
            path: 'common/new_types',
            segments: ['common', 'new_types'],
        });
        for (const invalid of ['', '.', '..', '../events', 'common//events', '/events', '\\events', 'file:events', 'common/\0events']) {
            expect(validateRelativeDirectoryPath(invalid, false).ok, invalid).to.equal(false);
        }
        for (const invalid of ['CON', 'bad:name', 'trailing.']) {
            expect(validateRelativeDirectoryPath(invalid, true).ok, invalid).to.equal(false);
        }
    });

    it('enforces URI scheme, authority and segment boundaries for virtual workspaces', () => {
        const root = { scheme: 'vscode-remote', authority: 'ssh-remote+dev', path: '/workspace/mod' };
        expect(isUriPathWithin(root, { ...root, path: '/workspace/mod/common' }, false)).to.equal(true);
        expect(relativeUriPathWithin(root, { ...root, path: '/workspace/mod/common/traits' }, false))
            .to.equal('common/traits');
        expect(isUriPathWithin(root, { ...root, path: '/workspace/mod-other' }, false)).to.equal(false);
        expect(isUriPathWithin(root, { ...root, authority: 'ssh-remote+other' }, false)).to.equal(false);
        expect(isUriPathWithin(root, { ...root, scheme: 'file' }, false)).to.equal(false);
        expect(isUriPathWithin(
            { scheme: 'file', authority: '', path: '/C:/Mods/Test' },
            { scheme: 'file', authority: '', path: '/c:/mods/test/common' },
            true,
        )).to.equal(true);
    });

    it('bounds and expires the vanilla LRU cache and honors cancellation', async () => {
        let now = 100;
        let loads = 0;
        const cache = new VanillaDirectoryCache(2, 10, () => now);
        const active = { isCancellationRequested: false };
        const load = async (value: string) => {
            loads += 1;
            return [value];
        };
        expect(await cache.get('a', active, () => load('A'))).to.deep.equal(['A']);
        expect(await cache.get('a', active, () => load('unused'))).to.deep.equal(['A']);
        expect(loads).to.equal(1);
        await cache.get('b', active, () => load('B'));
        await cache.get('c', active, () => load('C'));
        expect(cache.size).to.equal(2);
        now += 11;
        expect(await cache.get('b', active, () => load('B2'))).to.deep.equal(['B2']);
        expect(await cache.get('cancelled', { isCancellationRequested: true }, () => load('no'))).to.deep.equal([]);
        expect(cache.size).to.equal(2);
        cache.dispose();
        expect(cache.size).to.equal(0);
    });

    it('uses a monotonic generation for latest-wins UI refresh', () => {
        const latest = new LatestDirectoryRequest();
        const first = latest.begin();
        const second = latest.begin();
        expect(latest.isCurrent(first)).to.equal(false);
        expect(latest.isCurrent(second)).to.equal(true);
        latest.cancel();
        expect(latest.isCurrent(second)).to.equal(false);
    });

    it('keeps cached-profile aggregation bounded with 10,000 CWT paths', () => {
        const cwtPaths = Array.from({ length: 10_000 }, (_, index) => ({
            path: `common/generated_${index}`,
            entityTypes: [`type_${index}`],
        }));
        const timings: number[] = [];
        for (let run = 0; run < 20; run++) {
            const start = performance.now();
            const suggestions = aggregateDirectorySuggestions({
                parentRelativePath: '',
                gameId: 'stellaris',
                cwtPaths,
                profile: getProfileByLanguageId('stellaris'),
                vanillaChildNames: [],
                existingEntries: [],
                caseInsensitive: false,
            });
            timings.push(performance.now() - start);
            expect(suggestions.some(item => item.segment === 'common')).to.equal(true);
        }
        timings.sort((left, right) => left - right);
        const p95 = timings[Math.ceil(timings.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
        expect(p95).to.be.lessThan(50);
    });
});

describe('semantic directory catalog protocol', () => {
    it('parses, normalizes, merges and deterministically sorts the complete directory field', () => {
        const parsed = parsePdxSemanticCatalog({
            ok: true,
            status: 'ready',
            rules: [],
            definitionTypes: [],
            directoryCatalogVersion: 1,
            directoryPaths: [
                { path: 'game\\common\\traits/', entityTypes: ['Trait', 'trait'] },
                { path: 'common/traits', entityTypes: ['character_trait'] },
                { path: 'events', entityTypes: ['event'] },
                { path: '../outside', entityTypes: ['bad'] },
                { path: 'file://outside', entityTypes: ['bad'] },
                { path: 'common/<dynamic>', entityTypes: ['bad'] },
                { path: '', entityTypes: ['bad'] },
            ],
            directoryPathsTruncated: false,
            warnings: [],
        });
        expect(parsed?.directoryCatalogVersion).to.equal(1);
        expect(parsed?.directoryPaths).to.deep.equal([
            { path: 'common/traits', entityTypes: ['character_trait', 'trait'] },
            { path: 'events', entityTypes: ['event'] },
        ]);
        expect(parsed?.directoryPathsTruncated).to.equal(false);
    });

    it('does not apply the 4,000 TypeDef presentation limit to directory paths', () => {
        const directoryPaths = Array.from({ length: 10_000 }, (_, index) => ({
            path: `common/generated_${String(index).padStart(5, '0')}`,
            entityTypes: [`type_${index}`],
        }));
        const parsed = parsePdxSemanticCatalog({
            ok: true,
            rules: [],
            definitionTypes: [],
            directoryCatalogVersion: 1,
            directoryPaths,
            directoryPathsTruncated: false,
            warnings: [],
        });
        expect(parsed?.directoryPaths).to.have.length(10_000);
        expect(parsed?.directoryPaths?.[9_999]?.path).to.equal('common/generated_09999');
    });

    it('keeps old semantic catalog fixtures compatible', () => {
        const parsed = parsePdxSemanticCatalog({
            ok: true,
            rules: [],
            definitionTypes: [{ name: 'event', paths: ['events'], typeKeyFilters: [] }],
            warnings: [],
        });
        expect(parsed?.definitionTypes).to.have.length(1);
        expect(parsed?.directoryPaths).to.deep.equal([]);
        expect(parsed?.directoryCatalogVersion).to.equal(undefined);
    });
});

describe('Paradox directory command contributions', () => {
    it('contributes the command to Explorer and localizes English and Chinese titles', () => {
        const releaseRoot = path.resolve(__dirname, '../../../release');
        const manifest = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'package.json'), 'utf8')) as {
            contributes?: {
                commands?: Array<{ command?: string }>;
                menus?: { 'explorer/context'?: Array<{ command?: string; when?: string }> };
            };
        };
        expect(manifest.contributes?.commands?.some(item => item.command === 'cwtools.createGameDirectory')).to.equal(true);
        const menu = manifest.contributes?.menus?.['explorer/context']
            ?.find(item => item.command === 'cwtools.createGameDirectory');
        expect(menu?.when).to.equal('explorerResourceIsFolder');
        for (const fileName of ['package.nls.json', 'package.nls.zh.json', 'package.nls.zh-cn.json']) {
            const messages = JSON.parse(fs.readFileSync(path.join(releaseRoot, fileName), 'utf8')) as Record<string, unknown>;
            expect(messages['commands.stellarisLanguageServices.createGameDirectory.title'], fileName)
                .to.be.a('string').and.not.empty;
        }
    });
});
