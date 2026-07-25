import { expect } from 'chai';
import { parseWorkshopContentAppId, getGameIdForWorkshopAppId } from '../../extension/workshopDetection';

describe('workshop detection', () => {
	describe('parseWorkshopContentAppId', () => {
		it('parses a Windows-style workshop content path', () => {
			expect(parseWorkshopContentAppId('D:\\SteamLibrary\\steamapps\\workshop\\content\\281990\\1234567')).to.equal('281990');
		});

		it('parses a POSIX workshop content path', () => {
			expect(parseWorkshopContentAppId('/home/user/.steam/steam/steamapps/workshop/content/394360/999')).to.equal('394360');
		});

		it('matches segment names case-insensitively', () => {
			expect(parseWorkshopContentAppId('/Steam/steamapps/Workshop/Content/236850/42')).to.equal('236850');
		});

		it('returns undefined for non-workshop paths', () => {
			expect(parseWorkshopContentAppId('D:\\Steam\\steamapps\\common\\Stellaris')).to.equal(undefined);
			expect(parseWorkshopContentAppId('/home/user/Documents/Paradox Interactive/Stellaris/mod/mymod')).to.equal(undefined);
		});

		it('returns undefined when the content segment is not numeric', () => {
			expect(parseWorkshopContentAppId('/steam/workshop/content/appname/123')).to.equal(undefined);
		});

		it('returns undefined when workshop/content are not adjacent', () => {
			expect(parseWorkshopContentAppId('/workshop/downloads/content/281990')).to.equal(undefined);
		});
	});

	describe('getGameIdForWorkshopAppId', () => {
		it('maps known app ids to game language ids', () => {
			expect(getGameIdForWorkshopAppId('281990')).to.equal('stellaris');
			expect(getGameIdForWorkshopAppId('394360')).to.equal('hoi4');
			expect(getGameIdForWorkshopAppId('236850')).to.equal('eu4');
		});

		it('returns undefined for unregistered app ids', () => {
			expect(getGameIdForWorkshopAppId('12345')).to.equal(undefined);
		});

		it('never matches the placeholder app id 0', () => {
			expect(getGameIdForWorkshopAppId('0')).to.equal(undefined);
		});
	});
});
