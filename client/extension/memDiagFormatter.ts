export interface MemDiagLogEntry {
	category?: string;
	message: string;
	timestamp?: string;
}

interface ParsedField {
	key: string;
	value: string;
}

interface ParsedGroup {
	name: string;
	fields: ParsedField[];
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
	Memory: '内存 / Memory',
	Cache: '缓存 / Cache',
	Performance: '性能 / Performance',
	Lint: '校验 / Lint',
	Refresh: '刷新 / Refresh',
	Localisation: '本地化 / Localisation',
	Completion: '补全 / Completion',
	Hover: '悬停 / Hover',
	Lifecycle: '生命周期 / Lifecycle',
};

const OPERATION_LABELS: Readonly<Record<string, string>> = {
	PrepareUpdateFileInteractive: '准备交互更新 / PrepareUpdateFileInteractive',
	CommitUpdateFileInteractive: '提交交互更新 / CommitUpdateFileInteractive',
	RefreshIncrementalTypes: '增量刷新类型 / RefreshIncrementalTypes',
	RemoveScriptedTypes: '移除脚本类型 / RemoveScriptedTypes',
	GotoDefinition: '转到定义 / GotoDefinition',
	ValidateFiles: '批量校验文件 / ValidateFiles',
	ValidateFile: '校验文件 / ValidateFile',
	RefreshCaches: '刷新缓存 / RefreshCaches',
	AnalyzePass: '分析周期 / AnalyzePass',
	PerfCounters: '性能计数 / PerfCounters',
	UpdateFile: '更新文件 / UpdateFile',
	LocErrors: '本地化诊断 / LocErrors',
	Completion: '补全 / Completion',
	Hover: '悬停 / Hover',
};

const DESCRIPTION_LABELS: Readonly<Record<string, string>> = {
	'skipped': '已跳过 / skipped',
	'skipped (definitions unchanged)': '已跳过（定义未变化）/ skipped (definitions unchanged)',
	'semantic-noop': '全局语义未变化 / semantic no-op',
	'incremental keys/files': '增量影响的 key/文件 / incrementally affected keys/files',
	'dynamic batch': '动态引用批次 / dynamic reference batch',
	'ttl-hit': 'TTL 缓存命中 / TTL cache hit',
	'immediate fallback': '立即回退 / immediate fallback',
	'lock-timeout fallback': '锁等待超时回退 / lock-timeout fallback',
	'staged result superseded; retrying after quiet period': 'staged 结果已过期，静默期后重试 / staged result superseded; retrying after quiet period',
};

const GROUP_LABELS: Readonly<Record<string, string>> = {
	mem: '内存 / Memory',
	diag: '诊断 / Diagnostics',
	caches: '缓存 / Caches',
};

const FIELD_LABELS: Readonly<Record<string, string>> = {
	file: '文件 / File',
	path: '路径 / Path',
	line: '行 / Line',
	char: '列 / Character',
	mode: '模式 / Mode',
	shallow: '浅层校验 / Shallow validation',
	items: '结果数 / Items',
	staleItems: '旧缓存结果数 / Stale cache items',
	elapsed: '耗时 / Elapsed',
	elapsedMs: '耗时 / Elapsed',
	wait: '等待写锁 / Write-lock wait',
	hold: '持有写锁 / Write-lock hold',
	committed: '已提交 / Committed',
	allocDeltaMB: '本次分配 / Allocated by operation',
	cycleAllocMB: '本周期分配 / Allocated this cycle',
	strings: '字符串池 / Interned strings',
	ints: '整数池 / Interned integers',
	heap: '托管堆 / Managed heap',
	alloc: '累计分配 / Total allocated',
	working: '工作集 / Working set',
	private: '专用内存 / Private memory',
	fragmented: '堆碎片 / Fragmented heap',
	gc0: '第 0 代 GC / Gen 0 GC',
	gc1: '第 1 代 GC / Gen 1 GC',
	gc2: '第 2 代 GC / Gen 2 GC',
	files: '文件 / Files',
	fresh: '最新 / Fresh',
	pending: '待校验 / Pending',
	stale: '过期 / Stale',
	errors: '错误 / Errors',
	warnings: '警告 / Warnings',
	semantic: '语义 / Semantic',
	codeLens: 'CodeLens 缓存 / CodeLens cache',
	inlay: '嵌入提示缓存 / Inlay cache',
	locFiles: '本地化文件缓存 / Localisation files',
	locKeys: '本地化 key / Localisation keys',
	completionTTL: '补全 TTL 缓存 / Completion TTL cache',
	typeRefs: '类型引用缓存 / Type references',
	groupedTypeFiles: '类型文件分组 / Grouped type files',
	cacheWriteKeys: '缓存写入记录 / Cache write records',
	locErrors: '本地化错误 / Localisation errors',
	cachedLocKeys: '缓存的本地化 key / Cached localisation keys',
	affected: '受影响 / Affected',
	diagnostics: '诊断数 / Diagnostics',
	keys: 'Key 数 / Keys',
	refs: '引用文件 / Referencing files',
	patches: '增量补丁 / Incremental patches',
	semanticChanged: '全局语义变化 / Global semantic changed',
	staged: '使用 staged 刷新 / Staged refresh',
	force: '强制刷新 / Forced refresh',
	skipLimit: '达到跳过上限 / Skip limit reached',
	skip: '连续跳过次数 / Consecutive skips',
	quiet: '已进入静默期 / Quiet period reached',
	cooldown: '冷却完成 / Cooldown elapsed',
	delayedLocUpdate: '等待本地化更新 / Localisation update pending',
	doRefresh: '本轮执行全局刷新 / Global refresh in this pass',
	last: '最近操作 / Last operation',
	lint: '校验次数 / Lint count',
	refresh: '全局刷新次数 / Refresh count',
	refreshLoc: '本地化刷新次数 / Localisation refresh count',
	completion: '补全次数 / Completion count',
};

const MB_FIELDS = new Set(['allocDeltaMB', 'cycleAllocMB', 'heap', 'alloc', 'working', 'private', 'fragmented']);
const MILLISECOND_FIELDS = new Set(['elapsedMs']);
const PATH_FIELDS = new Set(['file', 'path']);

function cleanText(value: string): string {
	return value.replace(/[\r\n]+/g, ' ').trim();
}

function parseFields(input: string): { lead: string; fields: ParsedField[] } {
	const matches = Array.from(input.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9]*)=/g));
	const firstMatch = matches[0];
	if (!firstMatch) return { lead: input.trim(), fields: [] };

	const fields: ParsedField[] = [];
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		if (!match) continue;
		const key = match[1];
		if (!key) continue;
		const valueStart = (match.index ?? 0) + match[0].length;
		const valueEnd = matches[index + 1]?.index ?? input.length;
		fields.push({ key, value: input.slice(valueStart, valueEnd).trim() });
	}
	return { lead: input.slice(0, firstMatch.index ?? 0).trim(), fields };
}

function parseMessage(message: string): { lead: string; fields: ParsedField[]; groups: ParsedGroup[] } {
	const groups: ParsedGroup[] = [];
	const withoutGroups = message.replace(/\b(mem|diag|caches)\[([^\]\r\n]*)\]/g, (_whole, name: string, body: string) => {
		groups.push({ name, fields: parseFields(body).fields });
		return ' ';
	});
	const parsed = parseFields(withoutGroups);
	return { ...parsed, groups };
}

function operationTitle(lead: string): string {
	const operation = Object.keys(OPERATION_LABELS)
		.sort((left, right) => right.length - left.length)
		.find(candidate => lead === candidate || lead.startsWith(`${candidate} `));
	if (!operation) return lead || '事件 / Event';
	const description = lead.slice(operation.length).trim();
	const translatedDescription = DESCRIPTION_LABELS[description] ?? description;
	const operationLabel = OPERATION_LABELS[operation] ?? operation;
	return description
		? `${operationLabel} · ${translatedDescription}`
		: operationLabel;
}

function displayValue(field: ParsedField): string {
	if (field.value === 'True' || field.value === 'true') return '是 / true';
	if (field.value === 'False' || field.value === 'false') return '否 / false';
	if (field.key === 'mode' && field.value === 'interactive') return '交互 / interactive';
	if (field.key === 'mode' && field.value === 'full') return '完整 / full';
	if (MB_FIELDS.has(field.key) && /^-?\d+(?:\.\d+)?$/.test(field.value)) return `${field.value} MB`;
	if (MILLISECOND_FIELDS.has(field.key) && /^\d+(?:\.\d+)?$/.test(field.value)) return `${field.value} ms`;
	return field.value;
}

function displayField(field: ParsedField): string {
	const label = FIELD_LABELS[field.key] ?? field.key;
	if (PATH_FIELDS.has(field.key)) return `${label} [${field.key}]: ${field.value}`;
	return `${label}: ${displayValue(field)} [${field.key}=${field.value}]`;
}

function appendFieldLines(lines: string[], label: string, fields: ParsedField[]): void {
	const pathFields = fields.filter(field => PATH_FIELDS.has(field.key));
	const compactFields = fields.filter(field => !PATH_FIELDS.has(field.key));
	for (const field of pathFields) lines.push(`  ${displayField(field)}`);
	for (let index = 0; index < compactFields.length; index += 4) {
		const prefix = index === 0 ? `  ${label}: ` : '  ↳ ';
		lines.push(prefix + compactFields.slice(index, index + 4).map(displayField).join(' | '));
	}
}

/**
 * Convert one compact language-server monitor event into a bilingual, grouped block.
 * Stable operation and field names remain present for search and lightweight parsing.
 */
export function formatMemDiagEntry(entry: MemDiagLogEntry, fallbackTimestamp: string): string[] {
	const message = cleanText(entry.message);
	const timestamp = cleanText(entry.timestamp ?? fallbackTimestamp);
	const category = cleanText(entry.category ?? '');
	const parsed = parseMessage(message);
	const categoryLabel = (CATEGORY_LABELS[category] ?? category) || '诊断 / Diagnostics';
	const lines = [`[${timestamp}] [${categoryLabel}] ${operationTitle(parsed.lead)}`];

	appendFieldLines(lines, '详情 / Details', parsed.fields);
	for (const group of parsed.groups) {
		appendFieldLines(lines, GROUP_LABELS[group.name] ?? group.name, group.fields);
	}
	lines.push('');
	return lines;
}
