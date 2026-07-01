import { expect } from 'chai';
import * as path from 'path';

const vscodeStub = {
	env: { language: 'en' },
	workspace: {
		workspaceFolders: undefined,
		getConfiguration: () => ({ get: () => '' }),
	},
};

function loadSpecialPaths() {
	const moduleLoader = require('module') as { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
		if (request === 'vscode') return vscodeStub;
		return originalLoad.apply(this, [request, ...args]);
	};
	try {
		return require('../../extension/specialPaths') as typeof import('../../extension/specialPaths');
	} finally {
		moduleLoader._load = originalLoad;
	}
}

describe('special path helpers', () => {
	it('derives the Steam install folder from game-data subdirectories', () => {
		const { deriveGameInstallPath } = loadSpecialPaths();
		const gameRoot = path.join('D:\\SteamLibrary', 'steamapps', 'common', 'Crusader Kings III');
		expect(deriveGameInstallPath(path.join(gameRoot, 'game'), 'game')).to.equal(gameRoot);
		expect(deriveGameInstallPath(gameRoot, undefined)).to.equal(gameRoot);
	});

	it('builds Steam workshop paths from a library folder and app id', () => {
		const { steamWorkshopPathForLibrary } = loadSpecialPaths();
		expect(steamWorkshopPathForLibrary('D:\\SteamLibrary', '281990')).to.equal(path.join('D:\\SteamLibrary', 'steamapps', 'workshop', 'content', '281990'));
	});

	it('builds local Paradox user mod paths by platform', () => {
		const { paradoxUserModPath } = loadSpecialPaths();
		expect(paradoxUserModPath('Stellaris', 'win32', 'C:\\Users\\A')).to.equal(path.join('C:\\Users\\A', 'Documents', 'Paradox Interactive', 'Stellaris', 'mod'));
		expect(paradoxUserModPath('Stellaris', 'linux', '/home/a')).to.equal(path.join('/home/a', '.local', 'share', 'Paradox Interactive', 'Stellaris', 'mod'));
	});
});
