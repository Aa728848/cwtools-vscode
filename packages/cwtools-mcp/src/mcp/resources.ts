import {
  analyzeDiagnosticKnowledge,
  getProjectProfilePath,
  queryGameKnowledge,
  queryWorkflowHints,
  type HostServices,
} from 'cwtools-shared';

export const RESOURCE_URIS = [
  'cwtools://knowledge/game',
  'cwtools://knowledge/diagnostic-routing',
  'cwtools://knowledge/workflow-hints',
  'cwtools://project/profile',
] as const;

export function listResources() {
  return [
    {
      uri: 'cwtools://knowledge/game',
      name: 'CWTools game knowledge',
      description: 'Structured PDX/Stellaris knowledge cards for MCP clients.',
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
      description: 'The generated .cwtools-ai/project/profile.json if available.',
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
    case 'cwtools://knowledge/game':
      return queryGameKnowledge('stellaris');
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
            _hint: 'Run /init in the VS Code extension or create .cwtools-ai/project/profile.json.',
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
