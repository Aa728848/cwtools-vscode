export interface DiagnosticKnowledgeQuery {
  code?: string;
  message?: string;
}

export interface DiagnosticKnowledgeResult {
  status: 'ready';
  code?: string;
  category: string;
  explanation: string;
  suggestedTools: string[];
  nextSteps: string[];
}

export function analyzeDiagnosticKnowledge(query: DiagnosticKnowledgeQuery): DiagnosticKnowledgeResult {
  const code = query.code?.trim();
  const message = query.message?.toLowerCase() ?? '';

  if (code?.startsWith('CW001') || message.includes('syntax')) {
    return {
      status: 'ready',
      code,
      category: 'syntax',
      explanation: 'The diagnostic appears to be a parse or syntax error.',
      suggestedTools: ['get_pdx_block', 'document_symbols', 'query_rules'],
      nextSteps: [
        'Inspect the nearest complete block before editing.',
        'Verify brace balance and rule syntax before writing.',
      ],
    };
  }

  if (message.includes('localisation') || message.includes('localization')) {
    return {
      status: 'ready',
      code,
      category: 'localisation',
      explanation: 'The diagnostic appears related to localisation keys or YML files.',
      suggestedTools: ['query_localisation_index', 'write_localisation', 'get_diagnostics'],
      nextSteps: [
        'Check whether the key already exists in the localisation index.',
        'Use write_localisation for any YML mutation.',
      ],
    };
  }

  if (message.includes('scope')) {
    return {
      status: 'ready',
      code,
      category: 'scope',
      explanation: 'The diagnostic appears related to an invalid or unexpected scope.',
      suggestedTools: ['query_scope', 'query_rules', 'get_completion_at'],
      nextSteps: [
        'Query the scope at the failing position.',
        'Verify valid scope changes or trigger/effect syntax before editing.',
      ],
    };
  }

  return {
    status: 'ready',
    code,
    category: 'general',
    explanation: 'No specialized diagnostic route matched; use LSP and indexed evidence before editing.',
    suggestedTools: ['get_diagnostics', 'query_definition_by_name', 'query_workspace_index'],
    nextSteps: [
      'Group similar diagnostics and inspect a representative block.',
      'Verify identifiers through indexed tools before making changes.',
    ],
  };
}
