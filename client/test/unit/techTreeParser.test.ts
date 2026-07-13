import { expect } from 'chai';
import { applyTechLocalisation, parseTechFile } from '../../extension/techTreeParser';

const TECHNOLOGY = `tech_test_field = {
	area = physics
	tier = 2
	category = { field_manipulation }
	cost = 1000
	weight = 10
}`;

describe('technology tree localisation', () => {
	it('resolves the technology category without replacing its script key', () => {
		const graph = parseTechFile(TECHNOLOGY, '/common/technology/test.txt');
		const localisation = new Map([
			['tech_test_field', '全局能量管理'],
			['tech_test_field_desc', '管理全局能量。'],
			['field_manipulation', '力场操控'],
		]);

		applyTechLocalisation(graph.nodes, key => localisation.get(key));

		expect(graph.nodes).to.have.lengthOf(1);
		expect(graph.nodes[0]).to.include({
			title: '全局能量管理',
			description: '管理全局能量。',
			category: 'field_manipulation',
			categoryLabel: '力场操控',
		});
	});

	it('keeps the raw category as the display fallback when localisation is missing', () => {
		const graph = parseTechFile(TECHNOLOGY, '/common/technology/test.txt');

		applyTechLocalisation(graph.nodes, () => undefined);

		expect(graph.nodes[0]!.category).to.equal('field_manipulation');
		expect(graph.nodes[0]!.categoryLabel).to.equal(undefined);
	});
});
