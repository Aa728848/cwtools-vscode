import { expect } from 'chai';

const vscodeStub = {
	env: { language: 'en' },
};

function loadLocalisationAiCommands() {
	const moduleLoader = require('module') as { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
		if (request === 'vscode') return vscodeStub;
		return originalLoad.apply(this, [request, ...args]);
	};
	try {
		return require('../../extension/localisationAiCommands') as typeof import('../../extension/localisationAiCommands');
	} finally {
		moduleLoader._load = originalLoad;
	}
}

describe('localisation AI command prompts', () => {
	it('builds translation prompts that preserve Stellaris localisation invariants', () => {
		const { buildLocalisationAiPrompt } = loadLocalisationAiCommands();
		const prompt = buildLocalisationAiPrompt('translate', {
			relativePath: 'localisation/replace_l_english.yml',
			startLine: 3,
			endLine: 4,
			text: 'my_key:0 "Energy: £energy£ $VALUE$"',
			languageId: 'stellaris',
		}, 'Simplified Chinese');

		expect(prompt).to.contain('Simplified Chinese');
		expect(prompt).to.contain('localisation/replace_l_english.yml:3-4');
		expect(prompt).to.contain('this extension\'s own CWTools/Stellaris rules');
		expect(prompt).to.contain('£energy£');
		expect(prompt).to.contain('$KEY$');
	});

	it('builds polish prompts without asking for translation', () => {
		const { buildLocalisationAiPrompt } = loadLocalisationAiCommands();
		const prompt = buildLocalisationAiPrompt('polish', {
			relativePath: 'localisation/mod_l_simp_chinese.yml',
			startLine: 10,
			endLine: 10,
			text: 'my_key:0 "Some text"',
			languageId: 'stellaris',
		});

		expect(prompt).to.contain('Polish the selected Stellaris localisation text');
		expect(prompt).to.not.contain('Translate the selected');
		expect(prompt).to.contain('write path');
	});
});
