import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from '../tools/schema';

export interface RuleInfo {
  name: string;
  description: string;
  scopes: string[];
  syntax: string;
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

export async function queryRulesWithHost(host: HostServices, args: QueryRulesArgs): Promise<SharedToolResult<QueryRulesResult>> {
  const cache = await loadCwtRules(host);
  let rules = args.category === 'trigger'
    ? cache.triggers
    : args.category === 'effect'
      ? cache.effects
      : args.category === 'modifier'
        ? cache.modifiers
        : [...cache.triggers, ...cache.effects, ...cache.modifiers];

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

async function loadCwtRules(host: HostServices): Promise<{ triggers: RuleInfo[]; effects: RuleInfo[]; modifiers: RuleInfo[] }> {
  const configPaths = [
    path.join(host.workspaceRoot, 'submodules', 'cwtools-stellaris-config', 'config'),
    path.join(host.workspaceRoot, 'release', 'rules', 'stellaris', 'config'),
  ];

  for (const configPath of configPaths) {
    const scopeMap = new Map<string, string[]>();
    const triggerDocs = await host.filesystem.readTextFile(path.join(configPath, 'logs', 'trigger_docs.log')).catch(() => ({ exists: false, content: '', hasBom: false }));
    if (triggerDocs.exists) parseDocsLog(triggerDocs.content, scopeMap);

    const triggers = await readRulesFile(host, path.join(configPath, 'triggers.cwt'), scopeMap);
    const effects = await readRulesFile(host, path.join(configPath, 'effects.cwt'), scopeMap);
    const modifiers = await readModifiersLog(host, path.join(configPath, 'logs', 'modifiers.log'));
    if (triggers.length > 0 || effects.length > 0 || modifiers.length > 0) {
      return { triggers, effects, modifiers };
    }
  }

  return { triggers: [], effects: [], modifiers: [] };
}

async function readRulesFile(host: HostServices, filePath: string, scopeMap: Map<string, string[]>): Promise<RuleInfo[]> {
  const read = await host.filesystem.readTextFile(filePath).catch(() => ({ exists: false, content: '', hasBom: false }));
  if (!read.exists) return [];
  return parseCwtFile(read.content, scopeMap);
}

async function readModifiersLog(host: HostServices, filePath: string): Promise<RuleInfo[]> {
  const read = await host.filesystem.readTextFile(filePath).catch(() => ({ exists: false, content: '', hasBom: false }));
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
      });
    }
  }
  return results;
}

function parseDocsLog(content: string, scopeMap: Map<string, string[]>): void {
  let currentName = '';
  for (const line of content.split(/\r?\n/)) {
    const nameMatch = line.match(/^([\w.-]+)\s*-/);
    if (nameMatch?.[1]) {
      currentName = nameMatch[1];
      continue;
    }
    const scopeMatch = line.match(/^Supported Scopes:\s*(.*)/);
    if (scopeMatch?.[1] && currentName) {
      scopeMap.set(currentName, scopeMatch[1].split(/\s+/).filter(scope => scope && scope !== 'none'));
      currentName = '';
    }
  }
}

function parseCwtFile(content: string, scopeMap: Map<string, string[]>): RuleInfo[] {
  const results: RuleInfo[] = [];
  let currentScopes: string[] = [];
  let currentDesc = '';
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const scopeMatch = line.match(/^##\s*scope\s*=\s*\{?\s*([^}]*)\}?\s*$/i);
    if (scopeMatch?.[1]) {
      currentScopes = scopeMatch[1].split(/\s+/).filter(Boolean);
      continue;
    }
    if (line.startsWith('## ') && !line.startsWith('## scope')) {
      currentDesc = line.slice(3).trim();
      continue;
    }
    const nameMatch = line.match(/^alias\[(?:trigger|effect):(\w+)\]\s*=\s*(.*)/);
    if (nameMatch?.[1]) {
      const name = nameMatch[1];
      results.push({
        name,
        description: currentDesc,
        scopes: scopeMap.get(name) ?? currentScopes,
        syntax: (nameMatch[2] ?? '').trim(),
      });
      currentScopes = [];
      currentDesc = '';
    }
  }
  return results;
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
