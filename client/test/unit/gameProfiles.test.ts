import { expect } from 'chai';
import {
    getProfileByLanguageId,
    getAllLanguageIds,
    getAllProfiles,
    getAllLocalisationDirectoryNames,
    getLocalisationDirectoryGlob,
    getRulesRemoteUrl,
    getCacheSettingKey,
    isPreviewAvailable,
    getGameExeList,
    getGameFolderMapping,
    getAlternativeSteamFolderNames,
    getGameIdForVanillaCacheFile,
    getVanillaCacheFileName,
} from '../../extension/gameProfiles';

describe('GameProfile Registry', () => {
    // ── Profile resolution ─────────────────────────────────────────────

    it('resolves Stellaris by language ID', () => {
        const profile = getProfileByLanguageId('stellaris');
        expect(profile.id).to.equal('stellaris');
        expect(profile.displayName).to.equal('Stellaris');
    });

    it('resolves every registered game by its language ID', () => {
        const ids = getAllLanguageIds();
        expect(ids.length).to.be.greaterThanOrEqual(9);
        for (const id of ids) {
            const profile = getProfileByLanguageId(id);
            expect(profile.id).to.equal(id);
        }
    });

    it('falls back to Stellaris for unknown language IDs', () => {
        const profile = getProfileByLanguageId('nonexistent-game');
        expect(profile.id).to.equal('stellaris');
    });

    it('uses an independent conservative profile for "paradox" language ID', () => {
        const profile = getProfileByLanguageId('paradox');
        expect(profile.id).to.equal('paradox');
        expect(profile.displayName).to.equal('Generic Paradox');
        expect(profile.localisation.fileExtensions).to.deep.equal(['yml']);
        expect(profile.folders.scriptDirs).to.include.members(['events', 'history', 'decisions', 'common']);
        expect(profile.previews.solarSystemPreview).to.be.false;
        expect(profile.rulesRemoteUrl).to.equal('');
    });

    // ── Profile data integrity ─────────────────────────────────────────

    it('all profiles have non-empty required fields', () => {
        for (const profile of getAllProfiles()) {
            expect(profile.id, `${profile.id}.id`).to.be.a('string').and.not.be.empty;
            expect(profile.displayName, `${profile.id}.displayName`).to.be.a('string').and.not.be.empty;
            expect(profile.languageId, `${profile.id}.languageId`).to.equal(profile.id);
            expect(profile.cacheSettingKey, `${profile.id}.cacheSettingKey`).to.include('stellarisLanguageServices.cache.');
            expect(profile.rulesRemoteUrl, `${profile.id}.rulesRemoteUrl`).to.match(/^https:\/\/github\.com\//);
            expect(profile.install.steamAppId, `${profile.id}.steamAppId`).to.be.a('string');
            expect(profile.install.exeName, `${profile.id}.exeName`).to.be.a('string').and.not.be.empty;
        }
    });

    it('all profiles have localisation configuration', () => {
        for (const profile of getAllProfiles()) {
            expect(profile.localisation.directories, `${profile.id}.loc.directories`).to.be.an('array').and.not.be.empty;
            expect(profile.localisation.fileExtensions, `${profile.id}.loc.fileExtensions`).to.be.an('array').and.not.be.empty;
            expect(profile.localisation.encoding, `${profile.id}.loc.encoding`).to.be.a('string');
            expect(profile.localisation.defaultLanguageTag, `${profile.id}.loc.defaultLanguageTag`).to.be.a('string');
        }
    });

    it('derives localisation directory names from all profiles', () => {
        const names = getAllLocalisationDirectoryNames();
        expect(names).to.include('localisation');
        expect(names).not.to.include('localisation_synced');
        expect(names).to.include('localization');
        expect(new Set(names).size).to.equal(names.length);
    });

    it('builds a localisation glob fragment from all profiles', () => {
        const glob = getLocalisationDirectoryGlob();
        expect(glob).to.include('localisation');
        expect(glob).to.include('localization');
    });

    it('derives localisation extensions and preserves CK2 CSV conventions', () => {
        const ck2 = getProfileByLanguageId('ck2');
        expect(ck2.localisation.fileExtensions).to.deep.equal(['csv']);
        expect(ck2.localisation.encoding).to.equal('windows-1252');
        for (const profile of getAllProfiles().filter(profile => profile.id !== 'ck2')) {
            expect(profile.localisation.fileExtensions, profile.id).to.deep.equal(['yml']);
        }
    });

    // ── Rules remote URL ───────────────────────────────────────────────

    it('getRulesRemoteUrl returns correct URL for Stellaris', () => {
        const url = getRulesRemoteUrl('stellaris');
        expect(url).to.include('stellaris-config');
    });

    it('getRulesRemoteUrl returns correct URL for HOI4', () => {
        const url = getRulesRemoteUrl('hoi4');
        expect(url).to.include('hoi4-config');
    });

    it('getRulesRemoteUrl returns empty for unknown language', () => {
        const url = getRulesRemoteUrl('unknown');
        expect(url).to.equal('');
    });

    // ── Cache setting key ──────────────────────────────────────────────

    it('getCacheSettingKey strips cwtools prefix', () => {
        expect(getCacheSettingKey('stellaris')).to.equal('cache.stellaris');
        expect(getCacheSettingKey('ck3')).to.equal('cache.ck3');
    });

    // ── Preview capability gating ──────────────────────────────────────

    it('Stellaris has all preview capabilities', () => {
        expect(isPreviewAvailable('stellaris', 'guiPreview')).to.be.true;
        expect(isPreviewAvailable('stellaris', 'solarSystemPreview')).to.be.true;
        expect(isPreviewAvailable('stellaris', 'eventChainPreview')).to.be.true;
        expect(isPreviewAvailable('stellaris', 'techTreePreview')).to.be.true;
        expect(isPreviewAvailable('stellaris', 'entityPreview')).to.be.true;
        expect(isPreviewAvailable('stellaris', 'staticGalaxyPreview')).to.be.true;
    });

    it('non-Stellaris games do not have Stellaris-only preview capabilities', () => {
        for (const id of ['hoi4', 'eu4', 'ck2', 'ck3', 'vic2', 'vic3', 'imperator', 'eu5']) {
            expect(isPreviewAvailable(id, 'solarSystemPreview'), `${id}.solarSystemPreview`).to.be.false;
            expect(isPreviewAvailable(id, 'entityPreview'), `${id}.entityPreview`).to.be.false;
            expect(isPreviewAvailable(id, 'staticGalaxyPreview'), `${id}.staticGalaxyPreview`).to.be.false;
        }
    });

    // ── Exe detection list ─────────────────────────────────────────────

    it('getGameExeList covers all profiles', () => {
        const exeList = getGameExeList();
        const ids = exeList.map(e => e.id);
        for (const langId of getAllLanguageIds()) {
            expect(ids, `exeList should contain ${langId}`).to.include(langId);
        }
    });

    // ── Folder mapping ─────────────────────────────────────────────────

    it('getGameFolderMapping includes primary Steam folder names', () => {
        const mapping = getGameFolderMapping();
        expect(mapping.has('Stellaris')).to.be.true;
        expect(mapping.get('Stellaris')!.languageId).to.equal('stellaris');
        expect(mapping.has('Hearts of Iron IV')).to.be.true;
        expect(mapping.get('Hearts of Iron IV')!.languageId).to.equal('hoi4');
    });

    it('getGameFolderMapping includes alternative folder names', () => {
        const mapping = getGameFolderMapping();
        expect(mapping.has('Victoria II')).to.be.true;
        expect(mapping.get('Victoria II')!.languageId).to.equal('vic2');
        expect(mapping.has('Imperator')).to.be.true;
        expect(mapping.get('Imperator')!.languageId).to.equal('imperator');
    });

    it('getGameFolderMapping propagates subdir for CK3', () => {
        const mapping = getGameFolderMapping();
        expect(mapping.get('Crusader Kings III')!.subdir).to.equal('game');
    });

    // ── Alternative folder names ───────────────────────────────────────

    it('getAlternativeSteamFolderNames returns alternatives for Victoria 2', () => {
        const alts = getAlternativeSteamFolderNames('Victoria 2');
        expect(alts).to.include('Victoria II');
    });

    it('getAlternativeSteamFolderNames returns primary for alternative queries', () => {
        const alts = getAlternativeSteamFolderNames('Victoria II');
        expect(alts).to.include('Victoria 2');
    });

    it('getAlternativeSteamFolderNames returns empty for no-alternative games', () => {
        const alts = getAlternativeSteamFolderNames('Stellaris');
        expect(alts).to.deep.equal([]);
    });

    it('getAlternativeSteamFolderNames returns empty for unknown folders', () => {
        const alts = getAlternativeSteamFolderNames('Unknown Game');
        expect(alts).to.deep.equal([]);
    });

    // ── Non-Stellaris profile minimal fixture ──────────────────────────

    it('HOI4 profile has correct basic properties', () => {
        const profile = getProfileByLanguageId('hoi4');
        expect(profile.displayName).to.equal('Hearts of Iron IV');
        expect(profile.rulesRemoteUrl).to.include('cwtools-hoi4-config');
        expect(profile.cacheSettingKey).to.equal('stellarisLanguageServices.cache.hoi4');
        expect(profile.ai.knowledgeKey).to.equal('hoi4');
        expect(profile.install.steamFolderName).to.equal('Hearts of Iron IV');
    });

    it('CK3 profile has modern localisation conventions', () => {
        const profile = getProfileByLanguageId('ck3');
        expect(profile.localisation.directories).to.deep.equal(['localization']);
        expect(profile.folders.steamSubdir).to.equal('game');
    });

    it('does not expose the retired localisation_synced directory from built-in or generic profiles', () => {
        for (const id of [...getAllLanguageIds(), 'paradox']) {
            const profile = getProfileByLanguageId(id);
            expect(profile.localisation.directories, id).not.to.include('localisation_synced');
        }
        expect(getProfileByLanguageId('stellaris').folders.deprecatedDirs).to.include('localisation_synced');
    });

    it('maps every serialized vanilla cache file back to its game', () => {
        const expected = new Map([
            ['stellaris', 'stl.cwb'], ['hoi4', 'hoi4.cwb'], ['eu4', 'eu4.cwb'],
            ['eu5', 'eu5.cwb'], ['ck2', 'ck2.cwb'], ['ck3', 'ck3.cwb'],
            ['imperator', 'ir.cwb'], ['vic2', 'vic2.cwb'], ['vic3', 'vic3.cwb'],
        ]);
        for (const [gameId, fileName] of expected) {
            expect(getVanillaCacheFileName(gameId)).to.equal(fileName);
            expect(getGameIdForVanillaCacheFile(fileName.toUpperCase())).to.equal(gameId);
        }
    });
});
