import { expect } from 'chai';

const vscodeStub = {
	env: { language: 'en' },
};

function loadRelatedResources() {
	const moduleLoader = require('module') as { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
		if (request === 'vscode') return vscodeStub;
		return originalLoad.apply(this, [request, ...args]);
	};
	try {
		return require('../../extension/relatedResources') as typeof import('../../extension/relatedResources');
	} finally {
		moduleLoader._load = originalLoad;
	}
}

describe('related resource token extraction', () => {
	it('uses selected text before the cursor word', () => {
		const { extractRelatedResourceToken } = loadRelatedResources();
		const selection = { active: {}, selectedText: '"my_event.1.title"' };
		const document = {
			getText: (range: any) => range?.selectedText ?? '',
			getWordRangeAtPosition: () => ({ token: 'fallback' }),
		};

		expect(extractRelatedResourceToken(document as any, selection as any)).to.equal('my_event.1.title');
	});

	it('falls back to the identifier at the cursor', () => {
		const { extractRelatedResourceToken } = loadRelatedResources();
		const wordRange = { token: 'tech_alpha_lasers' };
		const selection = { active: {}, selectedText: '' };
		const document = {
			getText: (range: any) => range?.selectedText ?? range?.token ?? '',
			getWordRangeAtPosition: () => wordRange,
		};

		expect(extractRelatedResourceToken(document as any, selection as any)).to.equal('tech_alpha_lasers');
	});
});

describe('related localisation lookup', () => {
	it('orders exact localisation matches by configured language', async () => {
		const { queryRelatedLocalisations } = loadRelatedResources();
		const entries = [
			{ key: 'ship_name', value: 'Ship', file: '/loc/en.yml', line: 2, language: 'l_english' },
			{ key: 'ship_name', value: 'ZH Ship', file: '/loc/zh.yml', line: 2, language: 'l_simp_chinese' },
			{ key: 'ship_name_long', value: 'ZH Long Ship', file: '/loc/zh.yml', line: 3, language: 'l_simp_chinese' },
		];
		const indexService = {
			queryLocalisationAsync: async (query: any) => entries.filter(entry => {
				if (query.prefix) return entry.key.startsWith(query.key);
				return entry.key === query.key;
			}),
		};

		const results = await queryRelatedLocalisations(indexService as any, 'ship_name', [
			'l_simp_chinese',
			'l_english',
		]);

		expect(results.map(entry => `${entry.key}:${entry.language}`)).to.deep.equal([
			'ship_name:l_simp_chinese',
			'ship_name:l_english',
			'ship_name_long:l_simp_chinese',
		]);
	});

	it('keeps exact matches before prefix-only matches', async () => {
		const { queryRelatedLocalisations } = loadRelatedResources();
		const entries = [
			{ key: 'ship_name', value: 'Ship', file: '/loc/en.yml', line: 2, language: 'l_english' },
			{ key: 'ship_name_long', value: 'ZH Long Ship', file: '/loc/zh.yml', line: 3, language: 'l_simp_chinese' },
		];
		const indexService = {
			queryLocalisationAsync: async (query: any) => entries.filter(entry => {
				if (query.prefix) return entry.key.startsWith(query.key);
				return entry.key === query.key;
			}),
		};

		const results = await queryRelatedLocalisations(indexService as any, 'ship_name', [
			'l_simp_chinese',
			'l_english',
		]);

		expect(results[0]!.key).to.equal('ship_name');
		expect(results[0]!.language).to.equal('l_english');
	});
});
