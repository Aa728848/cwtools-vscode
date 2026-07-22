import {
  analyzeDiagnosticKnowledge,
  getProjectProfilePath,
  queryGameKnowledge,
  queryWorkflowHints,
  type HostServices,
} from 'cwtools-shared';
import * as path from 'path';

export const RESOURCE_URIS = [
  'cwtools://knowledge/game',
  'cwtools://knowledge/diagnostic-routing',
  'cwtools://knowledge/workflow-hints',
  'cwtools://project/profile',
  'cwtools://project/knowledge-manifest',
] as const;

export function listResources() {
  return [
    {
      uri: 'cwtools://knowledge/game',
      name: 'CWTools game knowledge',
      description: 'Current-game semantic catalog summary and stable evidence-routing guidance.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://knowledge/diagnostic-routing',
      name: 'CWTools diagnostic routing',
      description: 'Structured diagnostic routing guidance and suggested tools.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://knowledge/workflow-hints',
      name: 'CWTools workflow hints',
      description: 'Reusable workflow hints for diagnostics, localisation, and entity lookup.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://project/profile',
      name: 'CWTools project profile',
      description: 'The generated .cwtools/project/profile.json if available.',
      mimeType: 'application/json',
    },
    {
      uri: 'cwtools://project/knowledge-manifest',
      name: 'CWTools project knowledge manifest',
      description: 'Freshness, domains, counts, and fingerprints for the /init-generated semantic knowledge pack.',
      mimeType: 'application/json',
    },
  ];
}

export async function readResource(host: HostServices, uri: string) {
  const data = await readResourceData(host, uri);
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: `${JSON.stringify(data, null, 2)}\n`,
      },
    ],
  };
}

async function readResourceData(host: HostServices, uri: string): Promise<unknown> {
  switch (uri) {
    case 'cwtools://knowledge/game': {
      const catalog = await host.lsp.executeCommand(
        'cwtools.ai.getSemanticCatalog',
        [[], []],
        { timeoutMs: 10_000 },
      ).catch(() => undefined);
      return queryGameKnowledge('paradox', catalog);
    }
    case 'cwtools://knowledge/diagnostic-routing':
      return {
        status: 'ready',
        routes: [
          analyzeDiagnosticKnowledge({ message: 'syntax error' }),
          analyzeDiagnosticKnowledge({ message: 'missing localisation key' }),
          analyzeDiagnosticKnowledge({ message: 'scope mismatch' }),
          analyzeDiagnosticKnowledge({ message: 'unknown' }),
        ],
      };
    case 'cwtools://knowledge/workflow-hints':
      return queryWorkflowHints();
    case 'cwtools://project/profile': {
      const profilePath = getProjectProfilePath(host.workspaceRoot);
      const read = await host.filesystem.readTextFile(profilePath);
      return read.exists
        ? JSON.parse(read.content)
        : {
            status: 'missing',
            profilePath,
            _hint: 'Run /init in the VS Code extension or create .cwtools/project/profile.json.',
          };
    }
    case 'cwtools://project/knowledge-manifest': {
      let manifestPath = path.join(host.workspaceRoot, '.cwtools', 'project', 'knowledge', 'manifest.json');
      let read = await host.filesystem.readTextFile(manifestPath);
      if (!read.exists) {
        const legacyPath = path.join(host.workspaceRoot, '.cwtools-ai', 'project', 'knowledge', 'manifest.json');
        const legacyRead = await host.filesystem.readTextFile(legacyPath);
        if (legacyRead.exists) {
          manifestPath = legacyPath;
          read = legacyRead;
        }
      }
      return read.exists
        ? JSON.parse(read.content)
        : {
            status: 'missing',
            manifestPath,
            _hint: 'Run /init in the VS Code extension and wait for the deep semantic phase.',
          };
    }
    default:
      return {
        status: 'error',
        error: {
          code: 'resource_not_found',
          message: `Unknown CWTools MCP resource: ${uri}`,
        },
      };
  }
}
