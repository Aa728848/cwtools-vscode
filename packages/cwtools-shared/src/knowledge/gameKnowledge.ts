export interface GameKnowledgeCard {
  id: string;
  title: string;
  facts: string[];
}

export interface GameKnowledgeResult {
  status: 'ready' | 'partial';
  source: 'stable-policy' | 'lsp-semantic-catalog';
  game: string;
  rulesGeneration?: number;
  rulesContentHash?: string;
  ruleCount?: number;
  definitionTypeCount?: number;
  cards: GameKnowledgeCard[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Return stable routing policy plus current catalog metadata when supplied.
 * Mutable game rules are deliberately not embedded in this package.
 */
export function queryGameKnowledge(game = 'paradox', semanticCatalog?: unknown): GameKnowledgeResult {
  const catalog = asRecord(semanticCatalog);
  const rules = Array.isArray(catalog?.rules) ? catalog.rules : [];
  const definitionTypes = Array.isArray(catalog?.definitionTypes) ? catalog.definitionTypes : [];
  const hasCatalog = rules.length > 0 || definitionTypes.length > 0;
  const resolvedGame = typeof catalog?.gameProfile === 'string' && catalog.gameProfile.trim()
    ? catalog.gameProfile.toLowerCase()
    : game.toLowerCase();
  const cards: GameKnowledgeCard[] = [
    {
      id: 'dynamic-evidence-routing',
      title: 'Dynamic game evidence',
      facts: [
        'Obtain definition paths and identifier shapes from the active CWTools TypeDefs.',
        'Obtain rule arguments, typed references, and scope constraints from active CWT/LSP queries.',
        'Treat project and vanilla indexes as examples and dependency evidence; validate legality through current rules and diagnostics.',
      ],
    },
  ];
  if (hasCatalog) {
    cards.push({
      id: 'active-semantic-catalog',
      title: 'Active semantic catalog',
      facts: [
        `${rules.length} rule aliases and ${definitionTypes.length} definition types are currently available.`,
        'Use focused query_rules, query_types, query_cwt_schema, and query_scope calls to retrieve the exact facts needed for the current task.',
      ],
    });
  }
  return {
    status: hasCatalog ? 'ready' : 'partial',
    source: hasCatalog ? 'lsp-semantic-catalog' : 'stable-policy',
    game: resolvedGame,
    rulesGeneration: typeof catalog?.rulesGeneration === 'number' ? catalog.rulesGeneration : undefined,
    rulesContentHash: typeof catalog?.rulesContentHash === 'string' ? catalog.rulesContentHash : undefined,
    ruleCount: rules.length,
    definitionTypeCount: definitionTypes.length,
    cards,
  };
}
