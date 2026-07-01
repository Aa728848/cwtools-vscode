import * as vs from 'vscode';

export interface InspectionDiagnosticInput {
	relativePath: string;
	line: number;
	character: number;
	severity: vs.DiagnosticSeverity;
	message: string;
	source?: string;
	code?: string;
}

const SEVERITY_ORDER = [
	vs.DiagnosticSeverity.Error,
	vs.DiagnosticSeverity.Warning,
	vs.DiagnosticSeverity.Information,
	vs.DiagnosticSeverity.Hint,
];

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function severityLabel(severity: vs.DiagnosticSeverity): string {
	switch (severity) {
		case vs.DiagnosticSeverity.Error:
			return localize('Error', '错误');
		case vs.DiagnosticSeverity.Warning:
			return localize('Warning', '警告');
		case vs.DiagnosticSeverity.Information:
			return localize('Info', '信息');
		case vs.DiagnosticSeverity.Hint:
			return localize('Hint', '提示');
	}
}

function diagnosticCodeText(code: unknown): string | undefined {
	if (code === undefined || code === null) return undefined;
	if (typeof code === 'string' || typeof code === 'number') return String(code);
	if (typeof code === 'object' && 'value' in code) {
		const value = (code as { value?: unknown }).value;
		return value === undefined || value === null ? undefined : String(value);
	}
	return String(code);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function addCount(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedCounts(map: Map<string, number>): Array<[string, number]> {
	return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function buildInspectionOverviewMarkdown(diagnostics: InspectionDiagnosticInput[], generatedAt = new Date()): string {
	const countsBySeverity = new Map<vs.DiagnosticSeverity, number>();
	const countsBySource = new Map<string, number>();
	const countsByCode = new Map<string, number>();

	for (const diagnostic of diagnostics) {
		countsBySeverity.set(diagnostic.severity, (countsBySeverity.get(diagnostic.severity) ?? 0) + 1);
		addCount(countsBySource, diagnostic.source || localize('Unknown', '未知'));
		if (diagnostic.code) addCount(countsByCode, diagnostic.code);
	}

	const lines: string[] = [
		`# ${localize('CWTools Inspection Overview', 'CWTools 检查概览')}`,
		'',
		`${localize('Generated', '生成时间')}: ${generatedAt.toLocaleString()}`,
		'',
		`## ${localize('Summary', '摘要')}`,
		'',
		`- ${localize('Total diagnostics', '诊断总数')}: ${diagnostics.length}`,
	];

	for (const severity of SEVERITY_ORDER) {
		lines.push(`- ${severityLabel(severity)}: ${countsBySeverity.get(severity) ?? 0}`);
	}

	if (diagnostics.length === 0) {
		lines.push('', localize('No diagnostics are currently reported by VS Code.', '当前 VS Code 没有报告诊断。'));
		return lines.join('\n');
	}

	lines.push('', `## ${localize('By Source', '按来源')}`, '', '| Source | Count |', '| --- | ---: |');
	for (const [source, count] of sortedCounts(countsBySource)) {
		lines.push(`| ${source.replace(/\|/g, '\\|')} | ${count} |`);
	}

	const topCodes = sortedCounts(countsByCode).slice(0, 20);
	if (topCodes.length > 0) {
		lines.push('', `## ${localize('Top Codes', '主要代码')}`, '', '| Code | Count |', '| --- | ---: |');
		for (const [code, count] of topCodes) {
			lines.push(`| \`${code.replace(/`/g, '\\`')}\` | ${count} |`);
		}
	}

	const byFile = new Map<string, InspectionDiagnosticInput[]>();
	for (const diagnostic of diagnostics) {
		const list = byFile.get(diagnostic.relativePath) ?? [];
		list.push(diagnostic);
		byFile.set(diagnostic.relativePath, list);
	}

	lines.push('', `## ${localize('Diagnostics', '诊断')}`);
	for (const [relativePath, fileDiagnostics] of Array.from(byFile.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
		fileDiagnostics.sort((a, b) =>
			SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
			|| a.line - b.line
			|| a.character - b.character
		);
		lines.push('', `### ${relativePath}`);
		for (const diagnostic of fileDiagnostics) {
			const code = diagnostic.code ? ` \`${diagnostic.code}\`` : '';
			const source = diagnostic.source ? ` ${diagnostic.source}` : '';
			lines.push(`- ${severityLabel(diagnostic.severity)}${code}${source} (${diagnostic.line}:${diagnostic.character}) - ${oneLine(diagnostic.message)}`);
		}
	}

	return lines.join('\n');
}

function collectDiagnostics(): InspectionDiagnosticInput[] {
	const groups = vs.languages.getDiagnostics();
	const items: InspectionDiagnosticInput[] = [];
	for (const [uri, diagnostics] of groups) {
		if (uri.scheme !== 'file') continue;
		for (const diagnostic of diagnostics) {
			items.push({
				relativePath: vs.workspace.asRelativePath(uri),
				line: diagnostic.range.start.line + 1,
				character: diagnostic.range.start.character + 1,
				severity: diagnostic.severity,
				message: diagnostic.message,
				source: diagnostic.source,
				code: diagnosticCodeText(diagnostic.code),
			});
		}
	}
	items.sort((a, b) =>
		SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		|| a.relativePath.localeCompare(b.relativePath)
		|| a.line - b.line
		|| a.character - b.character
	);
	return items;
}

export function registerInspectionOverviewCommand(context: vs.ExtensionContext): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.diagnostics.openInspectionOverview', async () => {
			const content = buildInspectionOverviewMarkdown(collectDiagnostics());
			const document = await vs.workspace.openTextDocument({ language: 'markdown', content });
			await vs.window.showTextDocument(document, { preview: false });
		}),
	);
}
