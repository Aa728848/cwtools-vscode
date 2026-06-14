import * as path from 'path';
import type { HostServices } from '../host/hostServices';
import { analyzeDiagnosticKnowledge } from '../knowledge/diagnosticRouting';
import { queryRulesWithHost } from '../knowledge/rules';
import { queryProjectProfileWithHost } from '../project/profile';
import { editPdxBlockWithHost } from '../safety/pdxEdit';
import { writeLocalisationWithHost } from '../safety/localisation';
import { getPdxBlockWithHost } from './pdxBlock';
import { toolUnavailable, type SharedToolResult } from './schema';
import {
  documentSymbolsWithHost,
  getCompletionAtWithHost,
  queryDefinitionByNameWithHost,
  queryDefinitionWithHost,
  queryReferencesWithHost,
  workspaceSymbolsWithHost,
} from './symbols';

export type SharedToolDispatcher = (
  host: HostServices,
  name: string,
  args: Record<string, unknown>,
) => Promise<SharedToolResult>;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function executeLspTool(
  host: HostServices,
  command: string,
  args: unknown[],
  unavailableNextStep: string,
): Promise<SharedToolResult> {
  const result = await host.lsp.executeCommand(command, args);
  const record = asRecord(result);
  const errorRecord = asRecord(record.error);
  const unavailable = record.status === 'unavailable' || errorRecord.code === 'lsp_unavailable';
  return {
    ok: !unavailable,
    status: unavailable ? 'unavailable' : 'ready',
    source: 'cwtools-lsp',
    data: result,
    error: unavailable
      ? {
          code: String(errorRecord.code ?? 'lsp_unavailable'),
          message: String(errorRecord.message ?? 'LSP command is unavailable.'),
        }
      : undefined,
    nextSteps: unavailable ? [unavailableNextStep] : undefined,
  };
}

export const defaultSharedToolDispatcher: SharedToolDispatcher = async (host, name, rawArgs) => {
  const args = asRecord(rawArgs);
  switch (name) {
    case 'query_project_profile':
      return queryProjectProfileWithHost(host, args);

    case 'query_workspace_index': {
      if (!host.indexing) {
        return toolUnavailable(name, 'Workspace index is not available in this host.', [
          'Wire an LSP index command or a thin Node index before using this tool for semantic evidence.',
        ]);
      }
      return {
        ok: true,
        status: 'ready',
        source: 'cwtools-index',
        data: await host.indexing.queryWorkspace(args),
      };
    }

    case 'query_localisation_index': {
      if (!host.indexing) {
        return toolUnavailable(name, 'Localisation index is not available in this host.', [
          'Wire an LSP index command or a thin Node index before using this tool for localisation evidence.',
        ]);
      }
      return {
        ok: true,
        status: 'ready',
        source: 'cwtools-index',
        data: await host.indexing.queryLocalisation(args),
      };
    }

    case 'get_diagnostics':
      {
        const diagnostics = await host.diagnostics.getDiagnostics(args);
        return {
          ok: diagnostics.ok,
          status: diagnostics.status === 'unavailable' ? 'unavailable' : diagnostics.status === 'stale' ? 'stale' : diagnostics.status === 'pending' ? 'loading' : 'ready',
          source: 'cwtools-diagnostics',
          data: diagnostics,
          error: diagnostics.error,
        };
      }

    case 'analyze_diagnostic_error':
      return {
        ok: true,
        status: 'ready',
        source: 'cwtools-knowledge',
        data: analyzeDiagnosticKnowledge({
          code: typeof args.code === 'string' ? args.code : undefined,
          message: typeof args.message === 'string' ? args.message : undefined,
        }),
      };

    case 'write_localisation':
      return writeLocalisationWithHost(host, {
        filePath: String(args.filePath ?? args.file ?? ''),
        language: typeof args.language === 'string' ? args.language : undefined,
        entries: Array.isArray(args.entries) ? args.entries as never : [],
      });

    case 'edit_pdx_block': {
      return editPdxBlockWithHost(host, {
        file: String(args.file ?? ''),
        symbol: String(args.symbol ?? ''),
        newContent: String(args.newContent ?? ''),
      });
    }

    case 'get_completion_at':
      return getCompletionAtWithHost(host, {
        file: String(args.file ?? ''),
        line: Number(args.line ?? 0),
        column: Number(args.column ?? 0),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'document_symbols':
      return documentSymbolsWithHost(host, {
        file: String(args.file ?? ''),
      });

    case 'workspace_symbols':
      return workspaceSymbolsWithHost(host, {
        query: String(args.query ?? ''),
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'query_definition':
      return queryDefinitionWithHost(host, {
        file: String(args.file ?? ''),
        line: Number(args.line ?? 0),
        column: Number(args.column ?? 0),
      });

    case 'query_definition_by_name':
      return queryDefinitionByNameWithHost(host, {
        symbolName: String(args.symbolName ?? ''),
      });

    case 'query_references':
      return queryReferencesWithHost(host, {
        identifier: String(args.identifier ?? ''),
        file: typeof args.file === 'string' ? args.file : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });

    case 'query_scope':
      return executeLspTool(
        host,
        'cwtools.ai.getScopeAtPosition',
        [toFileUri(String(args.file ?? ''), host.workspaceRoot), args.line, args.column],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_types':
      return executeLspTool(
        host,
        'cwtools.ai.queryTypes',
        [args.typeName, args.filter ?? '', args.limit ?? 30, args.vanilla === true],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_rules':
      return queryRulesWithHost(host, {
        category: String(args.category ?? 'trigger') as never,
        name: typeof args.name === 'string' ? args.name : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
      });

    case 'query_scripted_effects':
      return executeLspTool(
        host,
        'cwtools.ai.queryScriptedEffects',
        [args.filter ?? '', args.limit ?? 50],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_scripted_triggers':
      return executeLspTool(
        host,
        'cwtools.ai.queryScriptedTriggers',
        [args.filter ?? '', args.limit ?? 50],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_enums':
      return executeLspTool(
        host,
        'cwtools.ai.queryEnums',
        [args.enumName ?? '', args.limit ?? 500],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_static_modifiers':
      return executeLspTool(
        host,
        'cwtools.ai.queryStaticModifiers',
        [args.filter ?? '', args.limit ?? 300],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'query_variables':
      return executeLspTool(
        host,
        'cwtools.ai.queryVariables',
        [args.filter ?? ''],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'get_entity_info':
      return executeLspTool(
        host,
        'cwtools.ai.getEntityInfo',
        [toFileUri(String(args.file ?? ''), host.workspaceRoot)],
        'Start the CWTools LSP process or connect this host to an existing language server.',
      );

    case 'get_pdx_block':
      return getPdxBlockWithHost(host, {
        file: String(args.file ?? ''),
        symbol: String(args.symbol ?? ''),
      });

    default:
      return {
        ok: false,
        status: 'error',
        source: 'cwtools-shared',
        error: {
          code: 'unknown_tool',
          message: `Unknown MCP tool: ${name}`,
        },
      };
  }
};

function toFileUri(filePath: string, workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot, filePath).replace(/\\/g, '/');
  const withLeadingSlash = resolved.startsWith('/') ? resolved : `/${resolved}`;
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23')}`;
}
