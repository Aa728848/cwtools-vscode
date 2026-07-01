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

