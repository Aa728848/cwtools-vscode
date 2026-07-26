import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

interface ConfigurationCategory {
	title?: string;
	order?: number;
	properties?: Record<string, unknown>;
}

describe('extension settings categories', () => {
	it('groups every setting once in an ordered, localized category', () => {
		const manifestPath = path.resolve(__dirname, '../../../release/package.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
			contributes?: { configuration?: ConfigurationCategory[] };
		};
		const categories = manifest.contributes?.configuration;

		expect(categories).to.be.an('array').with.length.greaterThan(1);
		const titles = categories?.map(category => category.title) ?? [];
		const orders = categories?.map(category => category.order) ?? [];
		const settingKeys = categories?.flatMap(category => Object.keys(category.properties ?? {})) ?? [];

		expect(titles.every(title => /^%configuration\.category\.[^%]+%$/.test(title ?? ''))).to.equal(true);
		expect(orders).to.deep.equal([...orders].sort((left, right) => (left ?? 0) - (right ?? 0)));
		expect(new Set(settingKeys).size).to.equal(settingKeys.length);
		expect(settingKeys).to.include('stellarisLanguageServices.editor.codeLens.enabled');
		expect(settingKeys).to.include('stellarisLanguageServices.ai.performance.modelCallBudget');

		for (const filename of ['package.nls.json', 'package.nls.zh-cn.json', 'package.nls.zh.json']) {
			const messages = JSON.parse(fs.readFileSync(path.resolve(path.dirname(manifestPath), filename), 'utf8')) as Record<string, unknown>;
			for (const title of titles) {
				const key = title?.slice(1, -1) ?? '';
				expect(messages[key], `${filename} should localize ${key}`).to.be.a('string').and.not.equal('');
			}
		}
	});
});
