export interface WorkflowHint {
  id: string;
  title: string;
  triggers: string[];
  recommendedTools: string[];
  guardrails: string[];
}

export function queryWorkflowHints(): { status: 'ready'; hints: WorkflowHint[] } {
  return {
    status: 'ready',
    hints: [
      {
        id: 'diagnostic-fix',
        title: 'Fix CWTools diagnostics',
        triggers: ['diagnostic', 'error', 'warning'],
        recommendedTools: ['get_diagnostics', 'analyze_diagnostic_error', 'get_pdx_block', 'query_cwt_schema', 'query_rules'],
        guardrails: ['Verify after writes.', 'Do not suppress diagnostics instead of fixing them.'],
      },
      {
        id: 'loc-generation',
        title: 'Generate or update localisation',
        triggers: ['localisation', 'localization', 'translation'],
        recommendedTools: ['query_localisation_index', 'write_localisation'],
        guardrails: ['Do not write .yml files through generic file tools.', 'Preserve language header and BOM.'],
      },
      {
        id: 'entity-lookup',
        title: 'Verify game identifiers',
        triggers: ['id', 'technology', 'building', 'scripted_effect', 'scripted_trigger'],
        recommendedTools: ['query_cwt_schema', 'search_rule_capabilities', 'query_rules', 'query_types', 'query_workspace_index', 'query_definition_by_name'],
        guardrails: ['Treat empty text search results as inconclusive without indexed verification.', 'Treat semanticHints as retrieval hints, not legality proof.'],
      },
    ],
  };
}
