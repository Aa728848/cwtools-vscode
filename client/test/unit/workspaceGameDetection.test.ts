import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inferGameIdFromWorkspace, hasWorkspaceModDescriptor } from '../../extension/workspaceGameDetection';

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-gamedetect-'));
}

function touch(root: string, relative: string, content = ''): void {
	const target = path.join(root, ...relative.split('/'));
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content);
}

describe('workspace game detection', () => {
	let root: string;
	let configuredGame: string;
	const cleanup: string[] = [];

	beforeEach(() => {
		root = makeTempDir();
		configuredGame = makeTempDir();
		fs.mkdirSync(path.join(configuredGame, 'common'), { recursive: true });
		cleanup.push(root, configuredGame);
	});

	afterEach(() => {
		while (cleanup.length) {
			fs.rmSync(cleanup.pop()!, { recursive: true, force: true });
		}
	});

	it('does not guess the single configured game when scoring is inconclusive', () => {
		// Regression: a generic mod used to be labelled as the one game the user
		// happened to have configured, which then wrote wrong-language settings
		// into the project.
		touch(root, 'descriptor.mod', 'name="My Cool Mod"\nsupported_version="3.*"');
		const result = inferGameIdFromWorkspace(root, id => (id === 'eu4' ? configuredGame : undefined));
		expect(result).to.equal(undefined);
	});

	it('detects the game from distinctive marker directories', () => {
		fs.mkdirSync(path.join(root, 'common', 'ship_sizes'), { recursive: true });
		fs.mkdirSync(path.join(root, 'common', 'planet_classes'), { recursive: true });
		const result = inferGameIdFromWorkspace(root, () => undefined);
		expect(result).to.equal('stellaris');
	});

	it('detects the game from descriptor text', () => {
		touch(root, 'descriptor.mod', 'name="My Stellaris Mod"');
		const result = inferGameIdFromWorkspace(root, () => undefined);
		expect(result).to.equal('stellaris');
	});

	it('returns undefined for shared markers that only tie below the threshold', () => {
		// common/governments exists in Stellaris, EU4, EU5 and Imperator.
		fs.mkdirSync(path.join(root, 'common', 'governments'), { recursive: true });
		const result = inferGameIdFromWorkspace(root, () => undefined);
		expect(result).to.equal(undefined);
	});

	it('returns undefined for non-Paradox workspaces', () => {
		touch(root, 'README.md', 'hello');
		expect(inferGameIdFromWorkspace(root, () => undefined)).to.equal(undefined);
	});

	it('returns undefined for CWT rules workspaces', () => {
		for (let i = 0; i < 6; i++) {
			touch(root, `rules/rule${i}.cwt`, '### rule');
		}
		fs.mkdirSync(path.join(root, 'common', 'ship_sizes'), { recursive: true });
		fs.mkdirSync(path.join(root, 'common', 'planet_classes'), { recursive: true });
		expect(inferGameIdFromWorkspace(root, () => undefined)).to.equal(undefined);
	});

	it('identifies a workspace overlapping the configured vanilla path', () => {
		const result = inferGameIdFromWorkspace(configuredGame, id => (id === 'stellaris' ? configuredGame : undefined));
		expect(result).to.equal('stellaris');
	});

	it('detects mod descriptors by .mod files and metadata.json', () => {
		expect(hasWorkspaceModDescriptor(root)).to.equal(false);
		touch(root, 'descriptor.mod');
		expect(hasWorkspaceModDescriptor(root)).to.equal(true);
	});
});
