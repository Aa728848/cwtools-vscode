import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from '../tools/schema';

export interface RuleInfo {
  name: string;
  description: string;
  scopes: string[];
  syntax: string;
  category?: QueryRulesArgs['category'];
  sourceFile?: string;
  sourceLine?: number;
  hardFacts?: RuleHardFacts;
  semanticHints?: RuleSemanticHint[];
}

export interface QueryRulesArgs {
  category: 'trigger' | 'effect' | 'scope_change' | 'modifier';
  name?: string;
  scope?: string;
}

export interface QueryRulesResult {
  rules: RuleInfo[];
  totalCount: number;
  truncated: boolean;
  source: 'cwtools-node-rules';
  warnings?: string[];
}

export interface SearchRuleCapabilitiesArgs {
  intent?: string;
  category?: QueryRulesArgs['category'] | 'all';
  currentScope?: string;
  desiredPushScope?: string;
  limit?: number;
}

export interface RuleCapabilityCandidate {
  rule: RuleInfo;
  score: number;
  reasons: string[];
}

export interface SearchRuleCapabilitiesResult {
  status: 'ready';
  candidates: RuleCapabilityCandidate[];
  totalConsidered: number;
  source: 'cwtools-node-rules';
  warnings?: string[];
}

export interface ExplainScopeArgs {
  scope: string;
}

export interface ExplainScopeResult {
  status: 'ready' | 'not_found';
  scope: string;
  canonicalName?: string;
  aliases?: string[];
  isSubscopeOf?: string[];
  description?: string;
  source?: {
    file: string;
    line: number;
  };
  semanticHints?: RuleSemanticHint[];
  suggestions?: string[];
}

export interface RuleHardFacts {
  category: QueryRulesArgs['category'];
  supportedScopes?: string[];
  pushScope?: string;
  typeKeyFilter?: string;
  syntax?: string;
  cwtSource?: {
    file: string;
    line: number;
  };
}

export interface RuleSemanticHint {
  text: string;
  source: 'trigger_docs.log' | 'scopes.cwt' | 'cwt-comment' | 'modifiers.log';
  file?: string;
  line?: number;
  confidence: 'hint';
}

interface RuleDocInfo {
  description: string;
  syntax: string;
  scopes: string[];
  file: string;
  line: number;
}

interface ScopeInfo {
  name: string;
  aliases: string[];
  isSubscopeOf: string[];
  description?: string;
  file: string;
  line: number;
}

interface CwtRuleCache {
  triggers: RuleInfo[];
  effects: RuleInfo[];
  scopeChanges: RuleInfo[];
  modifiers: RuleInfo[];
  scopes: Map<string, ScopeInfo>;
}

export async function queryRulesWithHost(host: HostServices, args: QueryRulesArgs): Promise<SharedToolResult<QueryRulesResult>> {
  const cache = await loadCwtRules(host);
  let rules = args.category === 'trigger'
    ? cache.triggers
    : args.category === 'effect'
      ? cache.effects
      : args.category === 'modifier'
        ? cache.modifiers
        : cache.scopeChanges;

  if (args.name) {
    const needle = args.name.toLowerCase();
    const filtered = rules.filter(rule => rule.name.toLowerCase().includes(needle));
    if (filtered.length === 0 && rules.length > 0) {
      rules = rules
        .map(rule => ({ rule, score: levenshtein(needle, rule.name.toLowerCase()) }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 5)
        .map(item => ({
          ...item.rule,
          description: `[FUZZY SUGGESTION] ${item.rule.description}`,
        }));
    } else {
      rules = filtered;
    }
  }

  if (args.scope) {
    const scope = args.scope.toLowerCase();
    rules = rules.filter(rule =>
      rule.scopes.length === 0
      || rule.scopes.some(candidate => {
        const lower = candidate.toLowerCase();
        return lower === scope || lower === 'all' || lower === 'any';
      }),
    );
  }

  const truncated = rules.length > 80;
  return {
    ok: true,
    status: 'ready',
    source: 'cwtools-node-rules',
    data: {
      rules: rules.slice(0, 80),
      totalCount: rules.length,
      truncated,
      source: 'cwtools-node-rules',
      warnings: [
        'Phase 1 fallback: rules are parsed from CWT/log files. Add cwtools.ai.queryRules to make LSP the long-term semantic source.',
      ],
    },
};
}

export async function searchRuleCapabilitiesWithHost(
  host: HostServices,
  args: SearchRuleCapabilitiesArgs = {},
): Promise<SharedToolResult<SearchRuleCapabilitiesResult>> {
  const cache = await loadCwtRules(host);
  const categories = args.category && args.category !== 'all'
    ? [args.category]
    : ['trigger', 'effect', 'scope_change', 'modifier'] as const;
  const rules = categories.flatMap(category =>
    category === 'trigger' ? cache.triggers
      : category === 'effect' ? cache.effects
        : category === 'scope_change' ? cache.scopeChanges
          : cache.modifiers
  );
  const currentScope = args.currentScope?.trim().toLowerCase();
  const desiredPushScope = args.desiredPushScope?.trim().toLowerCase();
  const intentTokens = expandIntentTokens(args.intent ?? '');
  const candidates = rules
    .map(rule => scoreRuleCapability(rule, intentTokens, currentScope, desiredPushScope))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.rule.name.localeCompare(b.rule.name));
  const limit = Math.max(1, Math.min(Number(args.limit ?? 10) || 10, 50));
  return {
    ok: true,
    status: 'ready',
    source: 'cwtools-node-rules',
    data: {
      status: 'ready',
      candidates: candidates.slice(0, limit),
      totalConsidered: rules.length,
      source: 'cwtools-node-rules',
      warnings: [
        'semanticHints are retrieval hints only; validate legality with hardFacts, completion, parse/diagnostics, or verified examples.',
      ],
    },
  };
}

export async function explainScopeWithHost(
  host: HostServices,
  args: ExplainScopeArgs,
): Promise<SharedToolResult<ExplainScopeResult>> {
  const cache = await loadCwtRules(host);
  const query = args.scope.trim();
  const scope = cache.scopes.get(query.toLowerCase());
  if (!scope) {
    const suggestions = Array.from(new Set(Array.from(cache.scopes.values()).map(item => item.name)))
      .filter(name => name.toLowerCase().includes(query.toLowerCase()) || levenshtein(query.toLowerCase(), name.toLowerCase()) <= 3)
      .slice(0, 10);
    return {
      ok: false,
      status: 'ready',
      source: 'cwtools-node-rules',
      data: {
        status: 'not_found',
        scope: query,
        suggestions,
      },
      error: {
        code: 'scope_not_found',
        message: `Scope '${query}' was not found in scopes.cwt.`,
      },
    };
  }

  const hints: RuleSemanticHint[] = [];
  const detail = [
    scope.description,
    scope.aliases.length ? `aliases: ${scope.aliases.join(', ')}` : '',
    scope.isSubscopeOf.length ? `is_subscope_of: ${scope.isSubscopeOf.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  if (detail) {
    hints.push({
      text: `Scope ${scope.name}: ${detail}`,
      source: 'scopes.cwt',
      file: scope.file,
      line: scope.line,
      confidence: 'hint',
    });
  }

  return {
    ok: true,
    status: 'ready',
    source: 'cwtools-node-rules',
    data: {
      status: 'ready',
      scope: query,
      canonicalName: scope.name,
      aliases: scope.aliases,
      isSubscopeOf: scope.isSubscopeOf,
      description: scope.description,
      source: { file: scope.file, line: scope.line },
      semanticHints: hints,
    },
  };
}

async function loadCwtRules(host: HostServices): Promise<CwtRuleCache> {
  const configPaths = await resolveRulesConfigPaths(host);

  for (const configPath of configPaths) {
    const triggerDocs = await readRulesTextFile(host, path.join(configPath, 'logs', 'trigger_docs.log')).catch(() => ({ exists: false, content: '', hasBom: false }));
    const docs = triggerDocs.exists
      ? parseDocsLog(triggerDocs.content, path.join(configPath, 'logs', 'trigger_docs.log'))
      : new Map<string, RuleDocInfo>();

    const scopesRead = await readRulesTextFile(host, path.join(configPath, 'scopes.cwt')).catch(() => ({ exists: false, content: '', hasBom: false }));
    const scopes = scopesRead.exists
      ? parseScopesFile(scopesRead.content, path.join(configPath, 'scopes.cwt'))
      : new Map<string, ScopeInfo>();

    const triggers = await readRuleFiles(host, configPath, ['triggers.cwt', 'trigger.cwt', path.join('generated', 'triggers.generated.cwt')], 'trigger', docs, scopes);
    const effects = await readRuleFiles(host, configPath, ['effects.cwt', 'effect.cwt', path.join('generated', 'effects.generated.cwt')], 'effect', docs, scopes);
    const scopeChanges = await readRuleFiles(host, configPath, ['scope_changes.cwt', path.join('generated', 'scope_changes.generated.cwt')], 'scope_change', docs, scopes);
    const modifiers = await readModifiersLog(host, path.join(configPath, 'logs', 'modifiers.log'));
    if (triggers.length > 0 || effects.length > 0 || scopeChanges.length > 0 || modifiers.length > 0) {
      return { triggers, effects, scopeChanges, modifiers, scopes };
    }
  }

  return { triggers: [], effects: [], scopeChanges: [], modifiers: [], scopes: new Map<string, ScopeInfo>() };
}

async function resolveRulesConfigPaths(host: HostServices): Promise<string[]> {
  const gameId = normalizeGameId(host.rules?.gameId) ?? await readProjectGameId(host);
  const explicitDirs = host.rules?.configDirs ?? [];
  const paths: string[] = [];
  const add = (candidate: string | undefined) => {
    if (!candidate?.trim()) return;
    const normalized = path.resolve(candidate);
    if (!paths.some(existing => samePath(existing, normalized))) paths.push(normalized);
  };
  const addConfigDirOrRoot = (candidate: string | undefined) => {
    if (!candidate?.trim()) return;
    add(candidate);
    add(path.join(candidate, 'config'));
  };

  for (const candidate of explicitDirs) addConfigDirOrRoot(candidate);

  const games = gameId ? [gameId] : ['stellaris'];
  for (const game of games) {
    addConfigDirOrRoot(path.join(host.workspaceRoot, '.cwtools', game));
    addConfigDirOrRoot(path.join(host.workspaceRoot, 'release', 'rules', game));
    addConfigDirOrRoot(path.join(host.workspaceRoot, 'submodules', `cwtools-${game}-config`));
    if (game === 'stellaris') add(path.join(host.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'));
  }

  return paths;
}

async function readProjectGameId(host: HostServices): Promise<string | undefined> {
  const fromProfileHost = await host.projectProfile?.readProfile().catch(() => null);
  const profile = fromProfileHost ?? await readProjectProfileFile(host);
  if (!profile || typeof profile !== 'object') return undefined;
  const game = (profile as { game?: unknown }).game;
  if (!game || typeof game !== 'object') return undefined;
  return normalizeGameId((game as { id?: unknown }).id);
}

async function readProjectProfileFile(host: HostServices): Promise<unknown | null> {
  const profilePath = path.join(host.workspaceRoot, '.cwtools-ai', 'project', 'profile.json');
  const read = await host.filesystem.readTextFile(profilePath).catch(() => ({ exists: false, content: '', hasBom: false }));
  if (!read.exists) return null;
  try {
    return JSON.parse(read.content) as unknown;
  } catch {
    return null;
  }
}

function normalizeGameId(gameId: unknown): string | undefined {
  if (typeof gameId !== 'string') return undefined;
  const normalized = gameId.trim().toLowerCase();
  return normalized || undefined;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readRulesTextFile(host: HostServices, filePath: string): Promise<{ content: string; hasBom?: boolean; exists: boolean }> {
  if (host.rules?.readTextFile) return host.rules.readTextFile(filePath);
  return host.filesystem.readTextFile(filePath);
}

async function readRuleFiles(
  host: HostServices,
  configPath: string,
  relativeFiles: string[],
  category: QueryRulesArgs['category'],
  docs: Map<string, RuleDocInfo>,
  scopes: Map<string, ScopeInfo>,
): Promise<RuleInfo[]> {
  const rules: RuleInfo[] = [];
  for (const relativeFile of relativeFiles) {
    rules.push(...await readRulesFile(host, path.join(configPath, relativeFile), category, docs, scopes));
  }
  return rules;
}

async function readRulesFile(
  host: HostServices,
  filePath: string,
  category: QueryRulesArgs['category'],
  docs: Map<string, RuleDocInfo>,
  scopes: Map<string, ScopeInfo>,
): Promise<RuleInfo[]> {
  const read = await readRulesTextFile(host, filePath).catch(() => ({ exists: false, content: '', hasBom: false }));
  if (!read.exists) return [];
  return parseCwtFile(read.content, filePath, category, docs, scopes);
}

async function readModifiersLog(host: HostServices, filePath: string): Promise<RuleInfo[]> {
  const read = await readRulesTextFile(host, filePath).catch(() => ({ exists: false, content: '', hasBom: false }));
  if (!read.exists) return [];
  const results: RuleInfo[] = [];
  for (const line of read.content.split(/\r?\n/)) {
    const match = line.trim().match(/^- ([\w.-]+), Category: (.*)/);
    if (match?.[1]) {
      results.push({
        name: match[1],
        description: `Categories: ${match[2] ?? ''}`,
        scopes: [],
        syntax: match[1],
        category: 'modifier',
        sourceFile: filePath,
        hardFacts: {
          category: 'modifier',
          syntax: match[1],
          cwtSource: { file: filePath, line: results.length + 1 },
        },
        semanticHints: [{
          text: `Categories: ${match[2] ?? ''}`,
          source: 'modifiers.log',
          file: filePath,
          confidence: 'hint',
        }],
      });
    }
  }
  return results;
}

function parseDocsLog(content: string, filePath: string): Map<string, RuleDocInfo> {
  const docs = new Map<string, RuleDocInfo>();
  let current: { name: string; description: string; syntaxLines: string[]; line: number } | undefined;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const nameMatch = line.match(/^([\w.-]+)\s*-/);
    if (nameMatch?.[1]) {
      current = {
        name: nameMatch[1],
        description: line.slice(nameMatch[0].length).trim(),
        syntaxLines: [],
        line: i + 1,
      };
      continue;
    }
    const scopeMatch = line.match(/^Supported Scopes:\s*(.*)/);
    if (scopeMatch?.[1] && current) {
      docs.set(current.name, {
        description: current.description,
        syntax: current.syntaxLines.join('\n').trim(),
        scopes: splitWords(scopeMatch[1]).filter(scope => scope !== 'none'),
        file: filePath,
        line: current.line,
      });
      current = undefined;
      continue;
    }
    if (current) {
      if (line.trim().length > 0) current.syntaxLines.push(line);
    }
  }
  return docs;
}

function parseScopesFile(content: string, filePath: string): Map<string, ScopeInfo> {
  const scopes = new Map<string, ScopeInfo>();
  let pendingDescription = '';
  let current: ScopeInfo | undefined;
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    const commentMatch = line.match(/^#+\s*(.+)$/);
    if (commentMatch?.[1] && !line.startsWith('## ')) {
      pendingDescription = commentMatch[1].trim();
      continue;
    }

    const scopeMatch = line.match(/^([A-Za-z][\w.-]*)\s*=\s*\{\s*$/);
    if (scopeMatch?.[1]) {
      current = {
        name: scopeMatch[1],
        aliases: [],
        isSubscopeOf: [],
        description: pendingDescription || undefined,
        file: filePath,
        line: i + 1,
      };
      pendingDescription = '';
      continue;
    }

    if (current) {
      const aliasesMatch = line.match(/^aliases\s*=\s*\{([^}]*)\}/);
      if (aliasesMatch?.[1]) current.aliases = splitWords(aliasesMatch[1]);
      const subscopeMatch = line.match(/^is_subscope_of\s*=\s*\{([^}]*)\}/);
      if (subscopeMatch?.[1]) current.isSubscopeOf = splitWords(subscopeMatch[1]);
      if (line === '}') {
        if (current.name !== 'types') {
          scopes.set(current.name.toLowerCase(), current);
          for (const alias of current.aliases) scopes.set(alias.toLowerCase(), current);
        }
        current = undefined;
      }
    }
  }
  return scopes;
}

function parseCwtFile(
  content: string,
  filePath: string,
  category: QueryRulesArgs['category'],
  docs: Map<string, RuleDocInfo>,
  scopes: Map<string, ScopeInfo>,
): RuleInfo[] {
  const results: RuleInfo[] = [];
  let currentScopes: string[] = [];
  let currentSupportedScopes: string[] = [];
  let currentPushScope: string | undefined;
  let currentTypeKeyFilter: string | undefined;
  let currentDesc = '';
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const line = rawLine.trim();
    const directiveMatch = line.match(/^##\s*([A-Za-z_]+)\s*=\s*(.*)$/);
    const directive = directiveMatch?.[1]?.toLowerCase();
    const directiveValue = directiveMatch?.[2]?.trim() ?? '';
    if (directive === 'scope') {
      currentScopes = splitRuleValueList(directiveValue);
      continue;
    }
    if (directive === 'supported_scopes') {
      currentSupportedScopes = splitRuleValueList(directiveValue);
      continue;
    }
    if (directive === 'push_scope') {
      currentPushScope = stripRuleValueBraces(directiveValue).split(/\s+/)[0];
      continue;
    }
    if (directive === 'type_key_filter') {
      currentTypeKeyFilter = stripRuleValueBraces(directiveValue).split(/\s+/)[0];
      continue;
    }

    const scopeMatch = line.match(/^##\s*scope\s*=\s*\{?\s*([^}]*)\}?\s*$/i);
    if (scopeMatch?.[1]) {
      currentScopes = splitWords(scopeMatch[1]);
      continue;
    }
    if (line.startsWith('###')) {
      currentDesc = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (line.startsWith('## ') && !line.startsWith('## scope')) {
      const comment = line.slice(3).trim();
      if (comment && !/^(cardinality|replace_scope)/i.test(comment)) currentDesc = comment;
      continue;
    }
    const nameMatch = line.match(/^alias\[(?:trigger|effect):([\w.-]+)\]\s*=\s*(.*)/);
    if (nameMatch?.[1]) {
      const name = nameMatch[1];
      const doc = docs.get(name);
      const cwtBlockText = collectCwtBlockText(lines, i);
      const scopesForRule = doc?.scopes.length
        ? doc.scopes
        : currentSupportedScopes.length
          ? currentSupportedScopes
          : currentScopes;
      const syntax = doc?.syntax || normalizeInlineSyntax(name, nameMatch[2] ?? '');
      const description = doc?.description || currentDesc;
      const semanticHints = buildSemanticHints({
        description,
        doc,
        cwtDescription: currentDesc,
        scopes,
        relatedScopeNames: [
          ...scopesForRule,
          ...(currentPushScope ? [currentPushScope] : []),
          ...extractScopeNamesFromSyntax(syntax),
          ...extractScopeNamesFromSyntax(cwtBlockText),
        ],
        cwtFile: filePath,
        cwtLine: i + 1,
      });
      results.push({
        name,
        description,
        scopes: scopesForRule,
        syntax,
        category,
        sourceFile: filePath,
        sourceLine: i + 1,
        hardFacts: {
          category,
          supportedScopes: scopesForRule,
          pushScope: currentPushScope,
          typeKeyFilter: currentTypeKeyFilter,
          syntax,
          cwtSource: { file: filePath, line: i + 1 },
        },
        semanticHints,
      });
      currentScopes = [];
      currentSupportedScopes = [];
      currentPushScope = undefined;
      currentTypeKeyFilter = undefined;
      currentDesc = '';
    }
  }
  return results;
}

function buildSemanticHints(args: {
  description: string;
  doc?: RuleDocInfo;
  cwtDescription: string;
  scopes: Map<string, ScopeInfo>;
  relatedScopeNames: string[];
  cwtFile: string;
  cwtLine: number;
}): RuleSemanticHint[] {
  const hints: RuleSemanticHint[] = [];
  const seen = new Set<string>();
  const add = (hint: RuleSemanticHint) => {
    const key = `${hint.source}:${hint.text}`;
    if (seen.has(key) || !hint.text.trim()) return;
    seen.add(key);
    hints.push(hint);
  };

  if (args.doc?.description) {
    add({
      text: args.doc.description,
      source: 'trigger_docs.log',
      file: args.doc.file,
      line: args.doc.line,
      confidence: 'hint',
    });
  }
  if (args.cwtDescription && args.cwtDescription !== args.doc?.description) {
    add({
      text: args.cwtDescription,
      source: 'cwt-comment',
      file: args.cwtFile,
      line: args.cwtLine,
      confidence: 'hint',
    });
  }

  for (const scopeName of args.relatedScopeNames) {
    const scope = args.scopes.get(scopeName.toLowerCase());
    if (!scope) continue;
    const details = [
      scope.description,
      scope.aliases.length ? `aliases: ${scope.aliases.join(', ')}` : '',
      scope.isSubscopeOf.length ? `is_subscope_of: ${scope.isSubscopeOf.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    if (!details) continue;
    add({
      text: `Scope ${scope.name}: ${details}`,
      source: 'scopes.cwt',
      file: scope.file,
      line: scope.line,
      confidence: 'hint',
    });
  }

  return hints.slice(0, 8);
}

function scoreRuleCapability(
  rule: RuleInfo,
  intentTokens: string[],
  currentScope?: string,
  desiredPushScope?: string,
): RuleCapabilityCandidate {
  let score = 0;
  const reasons: string[] = [];
  const supportedScopes = rule.hardFacts?.supportedScopes ?? rule.scopes;
  const pushScope = rule.hardFacts?.pushScope?.toLowerCase();
  const searchable = [
    rule.name,
    rule.description,
    rule.syntax,
    ...(rule.semanticHints ?? []).map(hint => hint.text),
  ].join(' ').toLowerCase();
  const ruleName = rule.name.toLowerCase();

  if (currentScope) {
    const matchesScope = supportedScopes.some(scope => {
      const lower = scope.toLowerCase();
      return lower === currentScope || lower === 'all' || lower === 'any';
    });
    if (matchesScope) {
      score += 60;
      reasons.push(`supported in current scope '${currentScope}'`);
    } else if (supportedScopes.length > 0) {
      score -= 20;
    }
  }

  if (desiredPushScope) {
    if (pushScope === desiredPushScope) {
      score += 120;
      reasons.push(`pushes scope to '${desiredPushScope}'`);
    } else if (searchable.includes(desiredPushScope)) {
      score += 15;
      reasons.push(`mentions '${desiredPushScope}'`);
    } else if (rule.category === 'scope_change') {
      score -= 10;
    }
  }

  for (const token of intentTokens) {
    if (token.length <= 1) continue;
    if (ruleName.includes(token)) {
      score += 25;
      reasons.push(`name matches '${token}'`);
    } else if (searchable.includes(token)) {
      score += 8;
    }
  }

  const wantsEvery = intentTokens.some(token => token === 'iterate' || token === 'every' || token === 'all');
  if (wantsEvery) {
    if (ruleName.startsWith('every_')) {
      score += 45;
      reasons.push('matches every/all iteration intent');
    } else if (/^(any|count|random|ordered)_/.test(ruleName)) {
      score -= 15;
    }
  }
  if (
    wantsEvery
    && currentScope === 'fleet'
    && desiredPushScope === 'ship'
    && ruleName.includes('_owned_ship')
    && !intentTokens.includes('controlled')
  ) {
    score += 8;
    reasons.push('preferred default fleet-to-ship iterator variant');
  }
  if (intentTokens.includes('random') && ruleName.startsWith('random_')) {
    score += 20;
    reasons.push('matches random selection intent');
  }
  if (intentTokens.includes('event') && ruleName.endsWith('_event')) {
    score += 20;
    reasons.push('matches event firing intent');
  }
  if (rule.semanticHints?.some(hint => hint.source === 'trigger_docs.log')) {
    score += 3;
  }

  return {
    rule,
    score,
    reasons: Array.from(new Set(reasons)).slice(0, 8),
  };
}

function expandIntentTokens(intent: string): string[] {
  const lower = intent.toLowerCase();
  const direct = lower
    .split(/[^a-z0-9_.:-]+/i)
    .map(token => token.trim())
    .filter(Boolean);
  const synonyms: Array<[RegExp, string[]]> = [
    [/舰队|艦隊/g, ['fleet']],
    [/舰船|艦船|飞船|飛船|船只|船\b/g, ['ship']],
    [/国家|國家|帝国|帝國/g, ['country']],
    [/行星|星球/g, ['planet']],
    [/殖民地/g, ['colony']],
    [/航母|载体|載體|承载|承載/g, ['carrier']],
    [/事件/g, ['event']],
    [/遍历|遍歷|每个|每個|所有/g, ['iterate', 'every']],
    [/随机|隨機/g, ['random']],
    [/作用域|范围|範圍/g, ['scope']],
    [/触发器|觸發器/g, ['trigger']],
    [/效果|效应|效應/g, ['effect']],
  ];
  const expanded = [...direct];
  for (const [pattern, tokens] of synonyms) {
    pattern.lastIndex = 0;
    if (pattern.test(intent)) expanded.push(...tokens);
  }
  return Array.from(new Set(expanded));
}

function extractScopeNamesFromSyntax(syntax: string): string[] {
  const results: string[] = [];
  for (const match of syntax.matchAll(/<event\.([A-Za-z][\w.-]*)>/g)) {
    if (match[1]) results.push(match[1]);
  }
  return results;
}

function collectCwtBlockText(lines: string[], startIndex: number): string {
  const collected: string[] = [];
  let depth = 0;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    collected.push(line);
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (i > startIndex && depth <= 0) break;
  }
  return collected.join('\n');
}

function normalizeInlineSyntax(name: string, raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{') return `${name} = { ... }`;
  return `${name} = ${trimmed}`;
}

function splitRuleValueList(value: string): string[] {
  return splitWords(stripRuleValueBraces(value));
}

function stripRuleValueBraces(value: string): string {
  return value.replace(/^\{\s*/, '').replace(/\s*\}$/, '').trim();
}

function splitWords(value: string): string[] {
  return value.split(/\s+/).map(part => part.trim()).filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0]![j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i]![j] = b.charAt(i - 1) === a.charAt(j - 1)
        ? matrix[i - 1]![j - 1]!
        : Math.min(matrix[i - 1]![j - 1]! + 1, matrix[i]![j - 1]! + 1, matrix[i - 1]![j]! + 1);
    }
  }
  return matrix[b.length]![a.length]!;
}
