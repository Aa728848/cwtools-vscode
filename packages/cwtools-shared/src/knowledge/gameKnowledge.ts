export interface GameKnowledgeCard {
  id: string;
  title: string;
  facts: string[];
}

export interface GameKnowledgeResult {
  status: 'ready';
  game: string;
  cards: GameKnowledgeCard[];
}

const COMMON_PDX_CARDS: GameKnowledgeCard[] = [
  {
    id: 'pdx-script-core',
    title: 'PDXScript core syntax',
    facts: [
      'Use key = value pairs and key = { ... } blocks.',
      'Boolean values are yes/no, not true/false.',
      'Statements are separated by whitespace; semicolons are not valid PDXScript separators.',
    ],
  },
  {
    id: 'verification-first',
    title: 'Verification first',
    facts: [
      'Verify game identifiers through LSP or indexed tools before writing them.',
      'Use query_rules for trigger/effect syntax instead of inventing parameters.',
      'Use search_rule_capabilities when intent is known but the exact rule name is not.',
      'Treat semanticHints as retrieval guidance; legality comes from hardFacts and validation.',
      'Use parse_pdx_fragment for syntax-only fragment checks before final diagnostics.',
      'Use write_localisation for .yml localisation writes.',
    ],
  },
];

const STELLARIS_CARDS: GameKnowledgeCard[] = [
  {
    id: 'stellaris-localisation',
    title: 'Stellaris localisation',
    facts: [
      'Localisation files live under localisation/ or localisation_synced/ in most Stellaris mods.',
      'UTF-8 with BOM and an l_english: style header are expected.',
      'Entries use the form key:0 "Displayed text" with one leading space.',
    ],
  },
  {
    id: 'stellaris-scope-caution',
    title: 'Stellaris scope caution',
    facts: [
      'Scope chains should be verified with query_scope, completions, or query_rules before final edits.',
      'Archaeological site stage events commonly run in fleet scope with the site available through from.',
      'Override behavior differs by common/ folder and should not be guessed from load order alone.',
    ],
  },
];

export function queryGameKnowledge(game = 'paradox'): GameKnowledgeResult {
  const normalized = game.toLowerCase();
  return {
    status: 'ready',
    game: normalized,
    cards: normalized === 'stellaris'
      ? [...COMMON_PDX_CARDS, ...STELLARIS_CARDS]
      : COMMON_PDX_CARDS,
  };
}
