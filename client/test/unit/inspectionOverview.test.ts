import { expect } from 'chai';

const vscodeStub = {
	env: { language: 'en' },
	DiagnosticSeverity: {
		Error: 0,
		Warning: 1,
		Information: 2,
		Hint: 3,
	},
};

function loadInspectionOverview() {
	const moduleLoader = require('module') as { _load: (...args: any[]) => any };
	const originalLoad = moduleLoader._load;
	moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
		if (request === 'vscode') return vscodeStub;
		return originalLoad.apply(this, [request, ...args]);
	};
	try {
		return require('../../extension/inspectionOverview') as typeof import('../../extension/inspectionOverview');
	} finally {
		moduleLoader._load = originalLoad;
	}
}

describe('inspection overview markdown', () => {
	it('summarizes diagnostics by severity, source, code, and file', () => {
		const { buildInspectionOverviewMarkdown } = loadInspectionOverview();
		const markdown = buildInspectionOverviewMarkdown([
			{
				relativePath: 'common/foo.txt',
				line: 4,
				character: 2,
				severity: vscodeStub.DiagnosticSeverity.Error,
				message: 'Unknown effect',
				source: 'CWTools',
				code: 'unknown_effect',
			},
			{
				relativePath: 'localisation/foo_l_english.yml',
				line: 1,
				character: 1,
				severity: vscodeStub.DiagnosticSeverity.Warning,
				message: 'CSV row drift',
				source: 'Paradox CSV',
				code: 'paradoxCsv.columnCount',
			},
		], new Date('2026-01-02T03:04:05Z'));

		expect(markdown).to.contain('Total diagnostics: 2');
		expect(markdown).to.contain('Error: 1');
		expect(markdown).to.contain('| CWTools | 1 |');
		expect(markdown).to.contain('`unknown_effect`');
		expect(markdown).to.contain('### common/foo.txt');
	});
});
