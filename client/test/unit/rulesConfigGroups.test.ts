import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let configValues: Record<string, string> = {};
let workspaceRoot: string | undefined;

const vscodeStub = {
	env: { language: 'en' },
	ConfigurationTarget: {
		Global: 1,
		Workspace: 2,
	},
	workspace: {
		get workspaceFolders() {
			return workspaceRoot ? [{ uri: { fsPath: workspaceRoot } }] : undefined;
		},
		getConfiguration: () => ({
			get: (key: string, fallback: string) => configValues[key] ?? fallback,
		}),
	},
};

function loadRulesConfigGroups() {
	const modulePath = require.resolve('../../extension/rulesConfigGroups');
	delete require.cache[modulePath];

	const moduleLoader = require('module') as { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
		if (request === 'vscode') return vscodeStub;
		return originalLoad.apply(this, [request, ...args]);
	};
	try {
		return require('../../extension/rulesConfigGroups') as typeof import('../../extension/rulesConfigGroups');
	} finally {
		moduleLoader._load = originalLoad;
	}
}

function writeRuleFile(folder: string): void {
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, 'rules.cwt'), '# test\n');
}

describe('rules config groups', () => {
	let tempDir: string;
	let cacheDir: string;
	let bundledRulesPath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-rules-groups-'));
		workspaceRoot = path.join(tempDir, 'workspace');
		cacheDir = path.join(tempDir, 'cache');
		bundledRulesPath = path.join(tempDir, 'bundled');

		writeRuleFile(path.join(workspaceRoot!, '.cwtools'));
		writeRuleFile(path.join(cacheDir, 'stellaris'));
		writeRuleFile(bundledRulesPath);
		configValues = {};
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		workspaceRoot = undefined;
		configValues = {};
	});

	it('uses cached remote rules for latest even when workspace .cwtools exists', () => {
		configValues = {
			rules_version: 'latest',
			rules_folder: '',
			rules_remote_url: '',
		};
		const { getRuleGroups } = loadRulesConfigGroups();
		const groups = getRuleGroups({
			languageId: 'stellaris',
			cacheDir,
			bundledRulesPath,
			defaultRemoteRulesUrl: 'https://example.test/default-rules',
			remoteRulesUrl: 'https://example.test/default-rules',
		});

		expect(groups.find(group => group.id === 'remote')!.active).to.equal(true);
		expect((groups as Array<{ id: string }>).some(group => group.id === 'workspace')).to.equal(false);
		expect(groups.find(group => group.id === 'manual')!.active).to.equal(false);
	});

	it('does not treat workspace .cwtools as a special rules source', () => {
		configValues = {
			rules_version: 'manual',
			rules_folder: path.join(workspaceRoot!, '.cwtools'),
		};
		const { getRuleGroups } = loadRulesConfigGroups();
		const groups = getRuleGroups({
			languageId: 'stellaris',
			cacheDir,
			bundledRulesPath,
			defaultRemoteRulesUrl: 'https://example.test/default-rules',
			remoteRulesUrl: 'https://example.test/default-rules',
		});

		expect(groups.find(group => group.id === 'manual')!.active).to.equal(true);
		expect((groups as Array<{ id: string }>).some(group => group.id === 'workspace')).to.equal(false);
		expect(groups.find(group => group.id === 'remote')!.active).to.equal(false);
	});

	it('uses a custom local folder only when manual is selected', () => {
		const manualFolder = path.join(tempDir, 'manual-rules');
		writeRuleFile(manualFolder);
		configValues = {
			rules_version: 'manual',
			rules_folder: manualFolder,
		};
		const { getRuleGroups } = loadRulesConfigGroups();
		const groups = getRuleGroups({
			languageId: 'stellaris',
			cacheDir,
			bundledRulesPath,
			defaultRemoteRulesUrl: 'https://example.test/default-rules',
			remoteRulesUrl: 'https://example.test/custom-rules',
		});

		expect(groups.find(group => group.id === 'manual')!.active).to.equal(true);
		expect(groups.find(group => group.id === 'remote')!.active).to.equal(false);
		expect(groups.find(group => group.id === 'fallback')!.active).to.equal(false);
	});

	it('does not activate bundled fallback just because remote cache is unavailable', () => {
		fs.rmSync(path.join(cacheDir, 'stellaris'), { recursive: true, force: true });
		configValues = {
			rules_version: 'latest',
			rules_folder: '',
		};
		const { getRuleGroups } = loadRulesConfigGroups();
		const groups = getRuleGroups({
			languageId: 'stellaris',
			cacheDir,
			bundledRulesPath,
			defaultRemoteRulesUrl: 'https://example.test/default-rules',
			remoteRulesUrl: 'https://example.test/default-rules',
		});

		expect(groups.find(group => group.id === 'remote')!.active).to.equal(false);
		expect(groups.find(group => group.id === 'fallback')!.active).to.equal(false);
	});
});
