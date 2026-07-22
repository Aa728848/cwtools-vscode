import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import type { SharedToolResult } from '../tools/schema';

export interface QueryProjectKnowledgeArgs {
  intent?: string;
  domains?: string[];
  identifiers?: string[];
  entityTypes?: string[];
  includeProjectPatterns?: boolean;
  includeVanillaArchetypes?: boolean;
  includeTopology?: boolean;
  includeUnresolved?: boolean;
  includeEventGraph?: boolean;
  limit?: number;
}

const KNOWLEDGE_DIR = path.join('.cwtools', 'project', 'knowledge');

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function tokensFor(args: QueryProjectKnowledgeArgs): string[] {
  return [args.intent ?? '', ...(args.identifiers ?? []), ...(args.entityTypes ?? [])]
    .join(' ')
    .toLowerCase()
    .match(/[@a-z0-9_.:-]{2,}/g)
    ?.slice(0, 30) ?? [];
}

function score(value: Record<string, unknown>, tokens: string[]): number {
  if (tokens.length === 0) return 1;
  const text = JSON.stringify(value).toLowerCase();
  return tokens.reduce((total, token) => total + (text.includes(token) ? 3 : 0), 0);
}

async function readJson(host: HostServices, filePath: string): Promise<Record<string, unknown> | undefined> {
  const read = await host.filesystem.readTextFile(filePath);
  if (!read.exists) return undefined;
  try {
    return asRecord(JSON.parse(read.content));
  } catch {
    return undefined;
  }
}

export async function queryProjectKnowledgeWithHost(
  host: HostServices,
  args: QueryProjectKnowledgeArgs = {},
): Promise<SharedToolResult> {
  let root = path.join(host.workspaceRoot, KNOWLEDGE_DIR);
  let manifestPath = path.join(root, 'manifest.json');
  let manifest = await readJson(host, manifestPath);
  if (!manifest) {
    const legacyRoot = path.join(host.workspaceRoot, '.cwtools-ai', 'project', 'knowledge');
    const legacyManifestPath = path.join(legacyRoot, 'manifest.json');
    const legacyManifest = await readJson(host, legacyManifestPath);
    if (legacyManifest) {
      root = legacyRoot;
      manifestPath = legacyManifestPath;
      manifest = legacyManifest;
    }
  }

  if (!manifest) {
    return {
      ok: false,
      status: 'unavailable',
      source: 'cwtools-project-knowledge',
      error: { code: 'knowledge_missing', message: 'Project knowledge pack is missing.' },
      data: {
        status: 'missing',
        manifestPath,
        domains: [],
        evidence: [],
        unresolved: [],
        _hint: 'Run /init in the VS Code extension and wait for the deep semantic phase to complete.',
      },
    };
  }

  if (Number(manifest.schemaVersion) >= 2) {
    const database = asRecord(manifest.database);
    const relativeDatabasePath = typeof database.path === 'string' && database.path.trim()
      ? database.path
      : 'knowledge.sqlite';
    const databasePath = path.resolve(root, relativeDatabasePath);
    const relative = path.relative(root, databasePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-project-knowledge-sqlite',
        error: { code: 'invalid_database_path', message: 'Project knowledge database path escapes the knowledge directory.' },
      };
    }
    const result = asRecord(await host.lsp.executeCommand(
      'cwtools.ai.queryProjectKnowledgeDb',
      [{ databasePath, ...args, includeEventGraph: args.includeEventGraph !== false }],
      { timeoutMs: 30_000 },
    ));
    if (result.ok !== true) {
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-project-knowledge-sqlite',
        error: {
          code: 'knowledge_query_failed',
          message: typeof result.error === 'string' ? result.error : 'Project knowledge SQLite query failed.',
        },
        data: { manifestPath, databasePath },
      };
    }
    const manifestStatus = String(manifest.status ?? 'stale');
    const staleReasons = stringArray(manifest.staleReasons);
    const ready = String(result.status ?? manifestStatus) === 'ready' && manifestStatus === 'ready' && staleReasons.length === 0;
    const partial = staleReasons.length === 0
      && (String(result.status ?? manifestStatus) === 'partial' || manifestStatus === 'partial');
    return {
      ok: true,
      status: ready ? 'ready' : partial ? 'partial' : 'stale',
      source: 'cwtools-project-knowledge-sqlite',
      data: {
        ...result,
        status: ready ? 'ready' : partial ? 'partial' : 'stale',
        manifestPath,
        staleReasons,
      },
    };
  }

  const manifestDomains = stringArray(manifest.domains);
  const domains = (args.domains?.length ? args.domains : manifestDomains)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
  const tokens = tokensFor(args);
  const limit = Math.max(1, Math.min(Number(args.limit ?? 80) || 80, 300));
  const evidence: Array<Record<string, unknown>> = [];
  const capabilities: Array<Record<string, unknown>> = [];

  for (const domain of domains) {
    const capability = await readJson(host, path.join(root, 'capabilities', `${domain}.json`));
    if (!capability) continue;
    capabilities.push({ domain, summary: capability.summary, evidencePolicy: capability.evidencePolicy });
    const candidates: Array<Record<string, unknown>> = [];
    if (Array.isArray(capability.definitions)) candidates.push(...capability.definitions.map(asRecord));
    if (args.includeProjectPatterns !== false && Array.isArray(capability.projectExamples)) candidates.push(...capability.projectExamples.map(asRecord));
    if (args.includeVanillaArchetypes !== false && Array.isArray(capability.vanillaArchetypes)) candidates.push(...capability.vanillaArchetypes.map(asRecord));
    if (args.includeTopology !== false) {
      const topology = asRecord(capability.topology);
      if (Array.isArray(topology.edges)) candidates.push(...topology.edges.map(asRecord));
    }
    evidence.push(...candidates
      .map(item => ({ ...item, domain, score: score(item, tokens) }))
      .filter(item => tokens.length === 0 || Number(item.score) > 0)
      .sort((a, b) => Number(b.score) - Number(a.score))
      .slice(0, Math.max(5, Math.ceil(limit / Math.max(1, domains.length)))));
  }

  const unresolvedFile = args.includeUnresolved === false
    ? undefined
    : await readJson(host, path.join(root, 'unresolved.json'));
  const unresolved = Array.isArray(unresolvedFile?.entries)
    ? unresolvedFile.entries.map(asRecord).slice(0, 100)
    : [];
  const manifestStatus = String(manifest.status ?? 'stale');
  const staleReasons = stringArray(manifest.staleReasons);
  const ready = manifestStatus === 'ready' && staleReasons.length === 0;

  return {
    ok: true,
    status: ready ? 'ready' : 'stale',
    source: 'cwtools-project-knowledge',
    data: {
      status: ready ? 'ready' : 'stale',
      manifestPath,
      generatedAt: manifest.generatedAt,
      game: manifest.game,
      graphVersion: manifest.graphVersion,
      staleReasons,
      domains,
      capabilities,
      evidence: evidence.slice(0, limit),
      unresolved,
      requiredNextChecks: [
        'Use query_cwt_schema/query_rules/query_scope for legality before writing.',
        'Use query_override_modes for target directories with vanilla definitions.',
        'Read exact source blocks before approving a complex blueprint.',
      ],
    },
  };
}
