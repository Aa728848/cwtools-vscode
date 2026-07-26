import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
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
  /**
   * Cache lifecycle metadata (plan §7.4): monotonic per-host reload counter
   * plus a content hash of the rule files, so evidence consumers can detect
   * stale rule data. `generation` 0 means the memoization lifecycle is
   * unavailable (no fs access to compute a freshness signature).
   */
  rulesGeneration?: number;
  /** sha256 (16 hex chars) over the rule file contents; see computeRulesContentHash. */
  rulesContentHash?: string;
}

export interface QueryCwtSchemaArgs {
  target?: string;
  file?: string;
  directory?: string;
  name?: string;
  includeContent?: boolean;
  limit?: number;
}

export interface CwtSchemaMatch {
  ruleFile: string;
  relativeRuleFile: string;
  sourceRoot: string;
  score: number;
  matchedBy: string[];
  snippet?: string;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
}

export interface CwtSchemaEntitySummary {
  name: string;
  path?: string;
  nameField?: string;
  ruleFile: string;
  relativeRuleFile: string;
  sourceRoot: string;
  line: number;
  subtypes: string[];
  typeKeyFilters?: string[];
  schemaKeys: string[];
  graphRelatedTypes?: string[];
  shaderReferences?: Array<{
    argumentPath: string;
    referenceKind: 'shader_effect' | 'shader_file';
    dynamicValuePolicy: 'allow_expression' | 'literal_or_parameter';
    pathPrefix?: string;
    extension?: string;
  }>;
  matchedBy: string[];
  snippet?: string;
  truncated?: boolean;
}

export interface QueryCwtSchemaResult {
  status: 'ready' | 'not_found';
  target?: string;
  normalizedTarget?: string;
  name?: string;
  rulesRoots: string[];
  matches: CwtSchemaMatch[];
  entities: CwtSchemaEntitySummary[];
  entityCount: number;
  warnings?: string[];
  _hint?: string;
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
  /** Cache lifecycle metadata (plan §7.4); see QueryRulesResult. */
  rulesGeneration?: number;
  rulesContentHash?: string;
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
  /** Cache lifecycle metadata (plan §7.4); see QueryRulesResult. */
  rulesGeneration?: number;
  rulesContentHash?: string;
}

export interface RuleHardFacts {
  category: QueryRulesArgs['category'];
  supportedScopes?: string[];
  pushScope?: string;
  typeKeyFilter?: string;
  valueReferences?: CwtRuleValueReference[];
  syntax?: string;
  cwtSource?: {
    file: string;
    line: number;
  };
}

export interface CwtRuleValueReference {
  argumentPath: string;
  access: 'value' | 'value_set' | 'scope' | 'type';
  typeName: string;
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
  const { cache, meta } = await loadCwtRulesMemoized(host);
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
      rulesGeneration: meta.generation,
      rulesContentHash: meta.contentHash,
      warnings: [
        ...(rules.length === 0
          ? ['No CWT rule files were loaded for the active game/rules source; check rules configuration or reload CWTools before trusting empty results.']
          : []),
        'Phase 1 fallback: rules are parsed from CWT/log files. Add cwtools.ai.queryRules to make LSP the long-term semantic source.',
      ],
    },
};
}

export async function queryCwtSchemaWithHost(
  host: HostServices,
  args: QueryCwtSchemaArgs = {},
): Promise<SharedToolResult<QueryCwtSchemaResult>> {
  const target = String(args.target ?? args.file ?? args.directory ?? '').trim();
  const normalizedTarget = normalizeCwtSchemaTarget(host, target);
  const name = args.name?.trim();
  const limit = Math.max(1, Math.min(Number(args.limit ?? 5) || 5, 20));
  const roots = await resolveRulesConfigPaths(host);
  const candidates: Array<{
    file: string;
    root: string;
    relativeRuleFile: string;
    score: number;
    matchedBy: string[];
  }> = [];

  for (const root of roots) {
    const files = await findCwtSchemaFiles(host, root, 1000);
    for (const file of files) {
      let contentLower: string | undefined;
      if (name) {
        const read = await readRulesTextFile(host, file).catch(() => ({ exists: false, content: '', hasBom: false }));
        contentLower = read.exists ? read.content.toLowerCase() : undefined;
      }
      const relativeRuleFile = path.relative(root, file).replace(/\\/g, '/');
      const relNoExt = relativeRuleFile.replace(/\.cwt$/i, '');
      const scored = scoreCwtSchemaFile(relNoExt, normalizedTarget, name, contentLower);
      if (scored.score > 0) {
        candidates.push({
          file,
          root,
          relativeRuleFile,
          score: scored.score,
          matchedBy: scored.matchedBy,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.relativeRuleFile.localeCompare(b.relativeRuleFile));
  const seen = new Set<string>();
  const entityCandidates: CwtSchemaEntitySummary[] = [];
  const matches: CwtSchemaMatch[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.root}|${candidate.relativeRuleFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (matches.length >= limit) break;
    const excerpt = await buildCwtSchemaSnippet(host, candidate.file, name, !!args.includeContent);
    entityCandidates.push(...await extractCwtSchemaEntities(host, candidate.file, candidate.root, candidate.relativeRuleFile, normalizedTarget, name));
    matches.push({
      ruleFile: candidate.file,
      relativeRuleFile: candidate.relativeRuleFile,
      sourceRoot: candidate.root,
      score: candidate.score,
      matchedBy: candidate.matchedBy,
      ...excerpt,
    });
  }

  const entities = entityCandidates
    .sort((a, b) => scoreCwtSchemaEntity(b, normalizedTarget, name) - scoreCwtSchemaEntity(a, normalizedTarget, name)
      || a.relativeRuleFile.localeCompare(b.relativeRuleFile)
      || a.line - b.line)
    .slice(0, Math.min(50, Math.max(10, limit * 10)));
  const warnings: string[] = [];
  if (roots.length === 0) {
    warnings.push('No active CWT config roots were found. Check the rules configuration or reload CWTools.');
  }
  if (matches.length === 0) {
    warnings.push('No matching CWT schema file was found. This is not proof the construct is legal or illegal; retry with a broader target directory or inspect completion/diagnostics.');
  }
  if (matches.length > 0 && entities.length === 0) {
    warnings.push('Matched CWT files did not expose type[...] summaries. Use the returned snippets directly, then confirm with completions/diagnostics or a verified current-version example.');
  }

  return {
    ok: true,
    status: 'ready',
    source: 'cwtools-node-rules',
    data: {
      status: matches.length > 0 ? 'ready' : 'not_found',
      target: target || undefined,
      normalizedTarget: normalizedTarget || undefined,
      name,
      rulesRoots: roots,
      matches,
      entities,
      entityCount: entities.length,
      warnings,
      _hint: 'CWT schema is the primary legality source. Use entities for active type/path/subtype evidence, and use snippets for exact schema keys and comments. schemaKeys are CWT metadata keys, not necessarily direct game-script fields. If the schema is structural only, confirm intended usage with a verified vanilla archetype or mature project example before writing, then validate with completions/diagnostics.',
    },
  };
}

export async function searchRuleCapabilitiesWithHost(
  host: HostServices,
  args: SearchRuleCapabilitiesArgs = {},
): Promise<SharedToolResult<SearchRuleCapabilitiesResult>> {
  const { cache, meta } = await loadCwtRulesMemoized(host);
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
      rulesGeneration: meta.generation,
      rulesContentHash: meta.contentHash,
      warnings: [
        ...(rules.length === 0
          ? ['No CWT rule files were loaded for the active game/rules source; check rules configuration or reload CWTools before trusting empty results.']
          : []),
        'semanticHints are retrieval hints only; validate legality with hardFacts, completion, parse/diagnostics, or verified examples.',
      ],
    },
  };
}

export async function explainScopeWithHost(
  host: HostServices,
  args: ExplainScopeArgs,
): Promise<SharedToolResult<ExplainScopeResult>> {
  const { cache, meta } = await loadCwtRulesMemoized(host);
  const query = args.scope.trim();
  if (cache.scopes.size === 0) {
    return {
      ok: false,
      status: 'ready',
      source: 'cwtools-node-rules',
      data: {
        status: 'not_found',
        scope: query,
        suggestions: [],
        rulesGeneration: meta.generation,
        rulesContentHash: meta.contentHash,
      },
      error: {
        code: 'rules_source_empty',
        message: 'No scopes were loaded from scopes.cwt. Check the active CWT rules source or reload rules; this is not evidence that the scope is invalid.',
      },
    };
  }
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
        rulesGeneration: meta.generation,
        rulesContentHash: meta.contentHash,
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
      rulesGeneration: meta.generation,
      rulesContentHash: meta.contentHash,
    },
  };
}

function normalizeCwtSchemaTarget(host: HostServices, value: string): string {
  let normalized = value.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (path.isAbsolute(value)) {
    const relative = path.relative(host.workspaceRoot, value).replace(/\\/g, '/');
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      normalized = relative;
    }
  }
  normalized = normalized.replace(/^file:\/\/\/?/i, '').replace(/^\/+/, '');
  const knownRoots = ['common', 'events', 'interface', 'gfx', 'sound', 'map', 'music', 'localisation', 'localization', 'history', 'decisions'];
  const lower = normalized.toLowerCase();
  for (const root of knownRoots) {
    const marker = `${root}/`;
    const idx = lower.indexOf(marker);
    if (idx >= 0) {
      normalized = normalized.slice(idx);
      break;
    }
  }
  const hadKnownExt = /\.(txt|gui|gfx|asset|entity|cwt|shader)$/i.test(normalized);
  normalized = normalized.replace(/\.(txt|gui|gfx|asset|entity|cwt|shader)$/i, '');
  if (hadKnownExt) {
    normalized = normalized.split('/').slice(0, -1).join('/');
  }
  return normalized.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

async function findCwtSchemaFiles(host: HostServices, root: string, maxFiles: number): Promise<string[]> {
  if (host.rules?.listCwtFiles) {
    return (await host.rules.listCwtFiles(root, { limit: maxFiles })).slice(0, maxFiles);
  }
  const rootRelative = workspaceRelativePath(host.workspaceRoot, root);
  if (!rootRelative) return [];
  const results: string[] = [];
  const ignoredDirs = new Set(['.git', 'node_modules', 'logs']);
  const walk = async (relativeDir: string, depth: number): Promise<void> => {
    if (results.length >= maxFiles || depth > 8) return;
    let entries: Awaited<ReturnType<HostServices['filesystem']['list']>>;
    try {
      entries = await host.filesystem.list(relativeDir === '.' ? '' : relativeDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      const childRelative = relativeDir === '.' ? entry.name : `${relativeDir}/${entry.name}`;
      const fullPath = path.join(host.workspaceRoot, childRelative);
      if (entry.type === 'directory') {
        if (!ignoredDirs.has(entry.name)) await walk(childRelative, depth + 1);
      } else if (entry.type === 'file' && entry.name.toLowerCase().endsWith('.cwt')) {
        results.push(fullPath);
      }
    }
  };
  await walk(rootRelative, 0);
  return results;
}

function workspaceRelativePath(workspaceRoot: string, fullPath: string): string | undefined {
  const relative = path.relative(workspaceRoot, fullPath);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.replace(/\\/g, '/');
}

function scoreCwtSchemaFile(
  relativeNoExt: string,
  normalizedTarget: string,
  name: string | undefined,
  contentLower: string | undefined,
): { score: number; matchedBy: string[] } {
  const rel = relativeNoExt.toLowerCase().replace(/\\/g, '/');
  const base = rel.split('/').pop() ?? rel;
  const targetParts = normalizedTarget.split('/').filter(Boolean);
  const targetLast = targetParts[targetParts.length - 1] ?? '';
  const matchedBy: string[] = [];
  let score = 0;

  if (normalizedTarget) {
    if (rel === normalizedTarget) {
      score += 100;
      matchedBy.push('exact-cwt-path');
    }
    if (rel.endsWith(`/${normalizedTarget}`)) {
      score += 90;
      matchedBy.push('suffix-cwt-path');
    }
    if (normalizedTarget.startsWith(`${rel}/`)) {
      score += 80;
      matchedBy.push('target-under-cwt-path');
    }
    if (rel.includes(normalizedTarget)) {
      score += 50;
      matchedBy.push('contains-cwt-path');
    }
    if (targetLast) {
      const normalizedBase = normalizeCwtNameSegment(base);
      const normalizedTargetLast = normalizeCwtNameSegment(targetLast);
      if (normalizedBase === normalizedTargetLast) {
        score += 45;
        matchedBy.push('entity-family-name');
      } else if (normalizedBase.includes(normalizedTargetLast) || normalizedTargetLast.includes(normalizedBase)) {
        score += 25;
        matchedBy.push('near-entity-family-name');
      } else if (levenshtein(normalizedBase, normalizedTargetLast) <= 3) {
        score += 15;
        matchedBy.push('fuzzy-entity-family-name');
      }
    }
  }

  if (name?.trim()) {
    const needle = name.trim().toLowerCase();
    if (contentLower?.includes(needle)) {
      score += 35;
      matchedBy.push('name-in-cwt-content');
    }
    if (base.includes(needle)) {
      score += 20;
      matchedBy.push('name-in-cwt-file');
    }
  }

  return { score, matchedBy };
}

function normalizeCwtNameSegment(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/_consolidated$/i, '')
    .replace(/ies$/i, 'y')
    .replace(/s$/i, '');
}

async function buildCwtSchemaSnippet(
  host: HostServices,
  filePath: string,
  name: string | undefined,
  includeContent: boolean,
): Promise<{
  snippet?: string;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
}> {
  const read = await readRulesTextFile(host, filePath).catch(error => ({
    content: `Error reading CWT schema: ${error instanceof Error ? error.message : String(error)}`,
    hasBom: false,
    exists: false,
  }));
  if (!read.exists) return { snippet: 'CWT schema file was not readable.', truncated: false };
  if (read.content.length > 1_000_000) {
    return { snippet: '[CWT file is larger than 1MB; narrow the query with name/target.]', truncated: true };
  }
  const lines = read.content.split(/\r?\n/);
  const maxLines = includeContent ? 220 : 90;
  let start = 0;
  if (name?.trim()) {
    const needle = name.trim().toLowerCase();
    const hit = lines.findIndex(line => line.toLowerCase().includes(needle));
    if (hit >= 0) start = Math.max(0, hit - 25);
  }
  const endExclusive = Math.min(lines.length, start + maxLines);
  return {
    snippet: lines
      .slice(start, endExclusive)
      .map((line, index) => `${start + index + 1} | ${line}`)
      .join('\n'),
    startLine: start + 1,
    endLine: endExclusive,
    truncated: endExclusive < lines.length,
  };
}

async function extractCwtSchemaEntities(
  host: HostServices,
  filePath: string,
  sourceRoot: string,
  relativeRuleFile: string,
  normalizedTarget: string,
  name: string | undefined,
): Promise<CwtSchemaEntitySummary[]> {
  const read = await readRulesTextFile(host, filePath).catch(() => ({ exists: false, content: '', hasBom: false }));
  if (!read.exists || read.content.length > 1_000_000) return [];
  const lines = read.content.split(/\r?\n/);
  const summaries: CwtSchemaEntitySummary[] = [];
  const needle = name?.trim().toLowerCase();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const typeMatch = line.match(/^\s*type\[([^\]]+)\]\s*=\s*\{/i);
    if (!typeMatch) continue;
    const typeName = typeMatch[1];
    if (!typeName) continue;
    const end = findCwtBlockEnd(lines, index);
    const blockLines = lines.slice(index, end + 1);
    const schemaBlock = findCwtSchemaBlock(lines, typeName.trim());
    const summary = summarizeCwtTypeBlock({
      name: typeName.trim(),
      filePath,
      sourceRoot,
      relativeRuleFile,
      startLine: index + 1,
      block: blockLines.join('\n'),
      blockLines,
      schemaBlock,
    });
    if (cwtEntityMatches(summary, normalizedTarget, needle)) summaries.push(summary);
    index = end;
  }
  return summaries;
}

function findCwtBlockEnd(lines: string[], startIndex: number): number {
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length; index++) {
    const line = (lines[index] ?? '').replace(/#.*$/, '');
    for (const char of line) {
      if (char === '{') {
        depth++;
        opened = true;
      } else if (char === '}') {
        depth--;
      }
    }
    if (opened && depth <= 0) return index;
  }
  return Math.min(lines.length - 1, startIndex + 120);
}

function summarizeCwtTypeBlock(args: {
  name: string;
  filePath: string;
  sourceRoot: string;
  relativeRuleFile: string;
  startLine: number;
  block: string;
  blockLines: string[];
  schemaBlock?: string;
}): CwtSchemaEntitySummary {
  const pathMatch = args.block.match(/^\s*path\s*=\s*"([^"]+)"/mi)
    ?? args.block.match(/^\s*path\s*=\s*([^\s#]+)/mi);
  const nameFieldMatch = args.block.match(/^\s*name_field\s*=\s*"?([^\s#"]+)"?/mi);
  const graphRelatedMatch = args.block.match(/^\s*graph_related_types\s*=\s*\{([^}]+)\}/mi);
  const schemaKeys: string[] = [];
  for (const line of args.blockLines) {
    const keyMatch = line.match(/^\s*([A-Za-z_][\w.-]*)\s*=/);
    if (!keyMatch) continue;
    const key = keyMatch[1];
    if (!key) continue;
    if (!schemaKeys.includes(key)) schemaKeys.push(key);
    if (schemaKeys.length >= 30) break;
  }
  const subtypes = Array.from(args.block.matchAll(/\bsubtype\[([^\]]+)\]/gi))
    .map(match => match[1]?.trim() ?? '')
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .slice(0, 40);
  const typeKeyFilters = Array.from(args.block.matchAll(/^\s*##\s*type_key_filter\s*=\s*([^\s#}]+)/gmi))
    .map(match => match[1]?.replace(/^"|"$/g, '').trim() ?? '')
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
    .slice(0, 80);
  const graphRelatedText = graphRelatedMatch?.[1];
  const graphRelatedTypes = graphRelatedText
    ? graphRelatedText
      .split(/\s+/)
      .map(value => value.replace(/^"|"$/g, '').trim())
      .filter(Boolean)
      .slice(0, 40)
    : undefined;
  const snippetLines = args.blockLines.slice(0, 36);
  return {
    name: args.name,
    path: pathMatch?.[1]?.trim(),
    nameField: nameFieldMatch?.[1]?.trim(),
    ruleFile: args.filePath,
    relativeRuleFile: args.relativeRuleFile,
    sourceRoot: args.sourceRoot,
    line: args.startLine,
    subtypes,
    typeKeyFilters,
    schemaKeys,
    graphRelatedTypes,
    shaderReferences: extractCwtShaderReferences(args.schemaBlock ?? ''),
    matchedBy: [],
    snippet: snippetLines.map((line, index) => `${args.startLine + index} | ${line}`).join('\n'),
    truncated: snippetLines.length < args.blockLines.length,
  };
}

function findCwtSchemaBlock(lines: string[], typeName: string): string | undefined {
  const escaped = typeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=\\s*\\{`, 'i');
  for (let index = 0; index < lines.length; index++) {
    if (!pattern.test(lines[index] ?? '')) continue;
    return lines.slice(index, findCwtBlockEnd(lines, index) + 1).join('\n');
  }
  return undefined;
}

function extractCwtShaderReferences(schemaBlock: string): NonNullable<CwtSchemaEntitySummary['shaderReferences']> {
  const references: NonNullable<CwtSchemaEntitySummary['shaderReferences']> = [];
  const seen = new Set<string>();
  const stack: Array<{ key: string; depth: number }> = [];
  let depth = 0;
  const lines = schemaBlock.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = stripCwtLineComment(lines[index] ?? '');
    let leadingClose = 0;
    while (leadingClose < line.length && /\s/.test(line[leadingClose]!)) leadingClose++;
    while (line[leadingClose] === '}') {
      depth = Math.max(0, depth - 1);
      leadingClose++;
      while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();
      while (leadingClose < line.length && /\s/.test(line[leadingClose]!)) leadingClose++;
    }
    const assignment = line.slice(leadingClose).match(/^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/);
    const key = assignment?.[1];
    const rhs = assignment?.[2]?.trim();
    if (index > 0 && key && rhs) {
      const argumentPath = [...stack.map(item => item.key), key].join('.').toLowerCase();
      const add = (reference: NonNullable<CwtSchemaEntitySummary['shaderReferences']>[number]) => {
        const identity = `${reference.argumentPath}|${reference.referenceKind}`;
        if (!seen.has(identity)) {
          seen.add(identity);
          references.push(reference);
        }
      };
      if (/^\$shader_effect\b/i.test(rhs)) {
        add({ argumentPath, referenceKind: 'shader_effect', dynamicValuePolicy: 'allow_expression' });
      } else {
        const filepath = rhs.match(/^filepath\[\s*([^,\]]*)\s*,\s*(\.shader)\s*\]/i);
        if (filepath) {
          add({
            argumentPath,
            referenceKind: 'shader_file',
            dynamicValuePolicy: 'literal_or_parameter',
            pathPrefix: filepath[1]?.trim().replace(/\\/g, '/'),
            extension: filepath[2]!.toLowerCase(),
          });
        }
      }
    }
    let opens = 0;
    let closes = 0;
    let quoted = false;
    for (const char of line.slice(leadingClose)) {
      if (char === '"') quoted = !quoted;
      else if (!quoted && char === '{') opens++;
      else if (!quoted && char === '}') closes++;
    }
    if (index > 0 && key && rhs?.startsWith('{') && opens > closes) {
      stack.push({ key: key.toLowerCase(), depth: depth + 1 });
    }
    depth += opens - closes;
    while (stack.length > 0 && stack[stack.length - 1]!.depth > depth) stack.pop();
  }
  return references;
}

function stripCwtLineComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (escaped) escaped = false;
    else if (char === '\\' && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === '#' && !quoted) return line.slice(0, index);
  }
  return line;
}

function cwtEntityMatches(summary: CwtSchemaEntitySummary, normalizedTarget: string, needle: string | undefined): boolean {
  const matchedBy: string[] = [];
  const haystack = [
    summary.name,
    summary.path ?? '',
    summary.nameField ?? '',
    summary.relativeRuleFile,
    ...summary.subtypes,
    ...(summary.typeKeyFilters ?? []),
    ...summary.schemaKeys,
    ...(summary.graphRelatedTypes ?? []),
    ...(summary.shaderReferences ?? []).flatMap(reference => [reference.argumentPath, reference.referenceKind]),
  ].join('\n').toLowerCase().replace(/\\/g, '/');

  if (!normalizedTarget && !needle) matchedBy.push('listed-from-matched-cwt-file');
  if (normalizedTarget) {
    const targetLast = normalizedTarget.split('/').filter(Boolean).pop() ?? normalizedTarget;
    const summaryPath = summary.path?.toLowerCase().replace(/\\/g, '/');
    const relativeNoExt = summary.relativeRuleFile.toLowerCase().replace(/\\/g, '/').replace(/\.cwt$/i, '');
    if (summaryPath === normalizedTarget) matchedBy.push('exact-entity-path');
    else if (summaryPath?.includes(normalizedTarget)) matchedBy.push('target-in-entity-path');
    else if (relativeNoExt === normalizedTarget) matchedBy.push('exact-cwt-path');
    else if (targetLast && haystack.includes(targetLast.toLowerCase())) matchedBy.push('target-token-in-entity');
  }
  if (needle && haystack.includes(needle)) matchedBy.push('name-in-entity-summary');

  summary.matchedBy = matchedBy;
  return matchedBy.length > 0;
}

function scoreCwtSchemaEntity(summary: CwtSchemaEntitySummary, normalizedTarget: string, name: string | undefined): number {
  let score = 0;
  if (summary.matchedBy.includes('exact-entity-path')) score += 100;
  if (summary.matchedBy.includes('target-in-entity-path')) score += 80;
  if (summary.matchedBy.includes('exact-cwt-path')) score += 70;
  if (summary.matchedBy.includes('target-token-in-entity')) score += 45;
  if (summary.matchedBy.includes('name-in-entity-summary')) score += 35;
  if (summary.matchedBy.includes('listed-from-matched-cwt-file')) score += 10;
  const normalizedPath = summary.path?.toLowerCase().replace(/\\/g, '/') ?? '';
  if (normalizedTarget && normalizedPath === normalizedTarget) score += 20;
  if (name && summary.name.toLowerCase() === name.toLowerCase()) score += 20;
  return score;
}

// ─── Parsed-rules memoization (plan §7.4) ───────────────────────────────────
//
// loadCwtRules used to re-read and re-parse every rule file on each query.
// The memo keeps one parsed CwtRuleCache per host identity, invalidated by an
// mtime/size signature over a bounded candidate file set (12 files per config
// root). `generation` is a per-host monotonic reload counter; `contentHash` is
// sha256 (16 hex chars) over the length-prefixed concatenation of every
// candidate rule file's content — the same algorithm the extension-side
// LspToolHandler uses, so both ends describe rule revisions with the same
// hash semantics. The cache is process-local and bounded
// (CWT_RULES_MEMO_MAX_ENTRIES).

const CWT_RULE_FILE_CANDIDATES: readonly string[] = [
  'scopes.cwt',
  path.join('logs', 'trigger_docs.log'),
  path.join('logs', 'modifiers.log'),
  'triggers.cwt',
  'trigger.cwt',
  path.join('generated', 'triggers.generated.cwt'),
  'effects.cwt',
  'effect.cwt',
  path.join('generated', 'effects.generated.cwt'),
  'modifier.cwt',
  'scope_changes.cwt',
  path.join('generated', 'scope_changes.generated.cwt'),
];

const CWT_RULES_MEMO_MAX_ENTRIES = 8;
/**
 * When no candidate rule file exists on disk, the mtime signature cannot
 * observe changes (e.g. a fully virtual rules host), so such entries are
 * re-validated at most once per this interval.
 */
const CWT_RULES_MEMO_REFRESH_MS = 30_000;

interface CwtRulesMemoEntry {
  signature: string;
  sawDiskFiles: boolean;
  generation: number;
  contentHash: string;
  cache: CwtRuleCache;
  computedAt: number;
}

export interface CwtRulesCacheMeta {
  generation: number;
  contentHash: string;
}

const cwtRulesMemo = new Map<string, CwtRulesMemoEntry>();

function computeRulesSignature(configPaths: string[]): { signature: string; sawDiskFiles: boolean } {
  const parts: string[] = [];
  let sawDiskFiles = false;
  for (const configPath of configPaths) {
    for (const file of CWT_RULE_FILE_CANDIDATES) {
      const fullPath = path.join(configPath, file);
      try {
        const stat = fs.statSync(fullPath);
        parts.push(`${fullPath}:${stat.mtimeMs}:${stat.size}`);
        sawDiskFiles = true;
      } catch {
        parts.push(`${fullPath}:missing`);
      }
    }
  }
  return { signature: parts.join('|'), sawDiskFiles };
}

/**
 * sha256 (truncated to 16 hex chars) over the length-prefixed concatenation
 * of every existing candidate rule file's content, read through the host so
 * the hash reflects exactly what was parsed. The extension-side
 * LspToolHandler uses the same length-prefixed algorithm over its fs reads,
 * so both ends share rule-revision hash semantics (plan §7.4).
 */
async function computeRulesContentHash(host: HostServices, configPaths: string[]): Promise<string> {
  const hash = crypto.createHash('sha256');
  for (const configPath of configPaths) {
    for (const file of CWT_RULE_FILE_CANDIDATES) {
      const read = await readRulesTextFile(host, path.join(configPath, file)).catch(() => ({ exists: false, content: '', hasBom: false }));
      if (!read.exists) continue;
      hash.update(`${read.content.length}:`);
      hash.update(read.content);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function cwtRulesHostKey(host: HostServices): string {
  return [host.workspaceRoot, host.rules?.gameId ?? '', (host.rules?.configDirs ?? []).join(';')].join('|');
}

async function loadCwtRulesMemoized(host: HostServices): Promise<{ cache: CwtRuleCache; meta: CwtRulesCacheMeta }> {
  const configPaths = await resolveRulesConfigPaths(host);
  const hostKey = cwtRulesHostKey(host);
  const { signature, sawDiskFiles } = computeRulesSignature(configPaths);
  const memo = cwtRulesMemo.get(hostKey);
  if (memo && memo.signature === signature && (memo.sawDiskFiles || host.now() - memo.computedAt < CWT_RULES_MEMO_REFRESH_MS)) {
    return { cache: memo.cache, meta: { generation: memo.generation, contentHash: memo.contentHash } };
  }
  const cache = await loadCwtRulesFromPaths(host, configPaths);
  const entry: CwtRulesMemoEntry = {
    signature,
    sawDiskFiles,
    generation: (memo?.generation ?? 0) + 1,
    // Computed after the reload; re-reads the bounded candidate set through
    // the host, which is acceptable because reloads are rare.
    contentHash: await computeRulesContentHash(host, configPaths),
    cache,
    computedAt: host.now(),
  };
  cwtRulesMemo.set(hostKey, entry);
  // Bounded: insertion-order eviction once the cap is exceeded.
  while (cwtRulesMemo.size > CWT_RULES_MEMO_MAX_ENTRIES) {
    const oldest = cwtRulesMemo.keys().next().value;
    if (oldest === undefined) break;
    cwtRulesMemo.delete(oldest);
  }
  return { cache, meta: { generation: entry.generation, contentHash: entry.contentHash } };
}

async function loadCwtRulesFromPaths(host: HostServices, configPaths: string[]): Promise<CwtRuleCache> {
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
    const modifierAliases = await readRuleFiles(host, configPath, ['modifier.cwt'], 'modifier', docs, scopes);
    const modifierLog = await readModifiersLog(host, path.join(configPath, 'logs', 'modifiers.log'));
    const modifiers = [...modifierAliases];
    const modifierNames = new Set(modifiers.map(rule => rule.name.toLowerCase()));
    for (const rule of modifierLog) {
      if (!modifierNames.has(rule.name.toLowerCase())) modifiers.push(rule);
    }
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
  let profilePath = path.join(host.workspaceRoot, '.cwtools', 'project', 'profile.json');
  let read = await host.filesystem.readTextFile(profilePath).catch(() => ({ exists: false, content: '', hasBom: false }));
  if (!read.exists) {
    const legacyPath = path.join(host.workspaceRoot, '.cwtools-ai', 'project', 'profile.json');
    read = await host.filesystem.readTextFile(legacyPath).catch(() => ({ exists: false, content: '', hasBom: false }));
  }
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
    const nameMatch = line.match(/^alias\[(?:trigger|effect|modifier):([^\]]+)\]\s*=\s*(.*)/);
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
          valueReferences: extractCwtValueReferences(cwtBlockText),
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
    if ((i === startIndex && depth === 0) || (i > startIndex && depth <= 0)) break;
  }
  return collected.join('\n');
}

function extractCwtValueReferences(blockText: string): CwtRuleValueReference[] {
  const references: CwtRuleValueReference[] = [];
  const seen = new Set<string>();
  const add = (argumentPath: string, access: CwtRuleValueReference['access'], typeName: string) => {
    const normalizedType = typeName.trim().toLowerCase();
    if (!normalizedType || references.length >= 32) return;
    const key = `${argumentPath.toLowerCase()}|${access}|${normalizedType}`;
    if (seen.has(key)) return;
    seen.add(key);
    references.push({ argumentPath, access, typeName: normalizedType });
  };
  for (const rawLine of blockText.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '');
    const assignment = line.match(/^\s*(alias\[(?:trigger|effect|modifier):[^\]]+\]|[A-Za-z_][\w.-]*)\s*=\s*(.*)$/i);
    if (!assignment?.[1] || assignment[2] === undefined) continue;
    const argumentPath = assignment[1].toLowerCase().startsWith('alias[') ? '$value' : assignment[1];
    const rhs = assignment[2].trim();
    const typed = rhs.match(/^(value_set|value|scope)\[([^\]]+)\]/i);
    if (typed?.[1] && typed[2]) {
      add(argumentPath, typed[1].toLowerCase() as CwtRuleValueReference['access'], typed[2]);
      continue;
    }
    const entityType = rhs.match(/^<([^>]+)>/);
    if (entityType?.[1]) add(argumentPath, 'type', entityType[1]);
  }
  return references;
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
