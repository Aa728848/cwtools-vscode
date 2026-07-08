import { expect } from 'chai';

const vscodeStub = {
	env: { language: 'en' },
	workspace: {
		asRelativePath: (value: unknown) => String(value),
	},
	window: {},
	commands: {},
	ProgressLocation: { Notification: 15 },
	ViewColumn: { Beside: 2 },
};

function loadTranslationPreview() {
	const moduleLoader = require('module') as { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
		if (request === 'vscode') return vscodeStub;
		return originalLoad.apply(this, [request, ...args]);
	};
	try {
		return require('../../extension/translationPreview') as typeof import('../../extension/translationPreview');
	} finally {
		moduleLoader._load = originalLoad;
	}
}

describe('translation preview helpers', () => {
	it('protects and restores Paradox localisation tokens', () => {
		const { protectPdxTokens, restorePdxTokens } = loadTranslationPreview();
		const source = '§Y$PLANET|Y$§! changed ownership. [Root.GetName] gains £energy£.\\n';
		const protectedText = protectPdxTokens(source);

		expect(protectedText.text).to.contain('__CWTP_');
		expect(protectedText.text).to.not.contain('$PLANET|Y$');
		expect(protectedText.text).to.not.contain('[Root.GetName]');
		expect(protectedText.text).to.not.contain('£energy£');

		const translated = protectedText.text.replace('changed ownership', 'changed hands');
		const restored = restorePdxTokens(translated, protectedText.tokens);

		expect(restored.ok).to.equal(true);
		expect(restored.text).to.equal('§Y$PLANET|Y$§! changed hands. [Root.GetName] gains £energy£.\\n');
	});

	it('reports missing placeholders instead of returning a safe result', () => {
		const { protectPdxTokens, restorePdxTokens } = loadTranslationPreview();
		const protectedText = protectPdxTokens('$COUNTRY$ has a new ruler.');
		const broken = protectedText.text.replace('__CWTP_0__', 'the country');
		const restored = restorePdxTokens(broken, protectedText.tokens);

		expect(restored.ok).to.equal(false);
		expect(restored.missing).to.deep.equal(['__CWTP_0__']);
	});

	it('builds a translation-only prompt that preserves protected placeholders', () => {
		const { buildTranslationMessages } = loadTranslationPreview();
		const messages = buildTranslationMessages({
			relativePath: 'events/test.txt',
			startLine: 3,
			endLine: 5,
			languageId: 'stellaris',
			text: '# Test',
		}, '# __CWTP_0__ changed ownership.', 'Simplified Chinese');

		const system = String(messages[0]?.content ?? '');
		const user = String(messages[1]?.content ?? '');
		expect(system).to.contain('Return only the translated text');
		expect(system).to.contain('Preserve placeholders like __CWTP_0__ exactly');
		expect(system).to.contain('Do not reconstruct, copy, or add the code');
		expect(system).to.not.contain('Apply the change');
		expect(system).to.not.contain('write back');
		expect(user).to.contain('events/test.txt:3-5');
		expect(user).to.contain('Selected comments:');
		expect(user).to.contain('# __CWTP_0__ changed ownership.');
	});

	it('extracts only comments from selected code', () => {
		const { extractSelectedComments } = loadTranslationPreview();
		const source = [
			'@foo_time = 30       # 进入星系后要求离开的时间。',
			'@bar_delay = 180    # 天灾前兆每次警告通知的间隔。',
			'desc = "not # comment" # 这才是注释',
			"single = 'still not # comment' # final comment",
			'# Full line comment',
		].join('\n');

		expect(extractSelectedComments(source)).to.equal([
			'# 进入星系后要求离开的时间。',
			'# 天灾前兆每次警告通知的间隔。',
			'# 这才是注释',
			'# final comment',
			'# Full line comment',
		].join('\n'));
	});

	it('ignores selections without # comments', () => {
		const { extractSelectedComments } = loadTranslationPreview();
		expect(extractSelectedComments('name = "not # comment"\nvalue = 42')).to.equal('');
	});

	it('strips a simple markdown code fence from AI output', () => {
		const { stripMarkdownFence } = loadTranslationPreview();
		expect(stripMarkdownFence('```text\ntranslated\n```')).to.equal('translated');
		expect(stripMarkdownFence('translated')).to.equal('translated');
	});
});
