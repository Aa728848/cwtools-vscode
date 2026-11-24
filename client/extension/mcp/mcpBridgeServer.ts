/**
 * Local Authenticated Loopback Bridge Server for External MCP Clients (`cwtools-mcp`).
 *
 * Publishes per-workspace `bridge-manifest.json` metadata and serves both
 * read-only MCP tool/resource queries and `/cwtools/rpc` native LSP dispatch
 * behind bearer-token auth, request-size caps, and project capability filters.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as vs from 'vscode';
import type { Disposable, ExtensionContext } from 'vscode';
import { createToolCallHandler, isMcpToolAvailable, isMcpToolName, listMcpToolSchemas, MCP_READONLY_TOOL_NAMES, MCP_WRITE_TOOL_NAMES, type HostServices, type SharedToolHandler } from 'cwtools-shared';
import { classifyWorkspaceRoot, type WorkspaceProjectDetection } from '../workspaceGameDetection';
import { bridgeResourceDenied, bridgeToolDenied, filterBridgeResources, filterBridgeTools } from './mcpBridgeCapabilities';
import { getGameKnowledge } from './gameKnowledge';
import { getProjectProfilePath, getProjectKnowledgeManifestPath, isProjectProfile, type ProjectProfile } from 'cwtools-shared';
import { ErrorReporter } from '../errorReporter';

import { getCwtoolsHomeDir } from './homeConfig';
import { listSkills, loadSkill } from './skills';
import {
    isAuthorizedBridgeRequest,
    isMcpBridgeMethod,
    McpBridgeRequestTooLargeError,
    parseBridgeJsonRpcPayload,
    readMcpBridgeRequestBody,
} from './mcpBridgeProtocol';
import { dispatchNativeCwtoolsRequest, NATIVE_HEALTH_PATH, NATIVE_PROTOCOL_VERSION, NATIVE_RPC_PATH, NativeBridgeProtocolError } from './cwtoolsNativeBridge';

const BRIDGE_PROTOCOL_VERSION = 1;
const MANIFEST_FILE_NAME = 'bridge-manifest.json';

export const MCP_BRIDGE_READONLY_TOOL_NAMES = MCP_READONLY_TOOL_NAMES;
export const MCP_BRIDGE_DOMAIN_WRITE_TOOL_NAMES = MCP_WRITE_TOOL_NAMES;


const MCP_BRIDGE_DOMAIN_WRITE_SET = new Set<string>(MCP_BRIDGE_DOMAIN_WRITE_TOOL_NAMES);

const RESOURCE_URIS = [
    'cwtools://knowledge/game',
    'cwtools://knowledge/diagnostic-routing',
    'cwtools://knowledge/workflow-hints',
    'cwtools://project/profile',
    'cwtools://project/knowledge-manifest',
    'cwtools://skills/catalog',
] as const;

interface BridgeManifest {
    schemaVersion: 1;
    protocolVersion: number;
    kind: 'cwtools-mcp-extension-bridge';
    host: '127.0.0.1';
    port: number;
    rpcUrl: string;
    healthUrl: string;
    cwtoolsNativeRpcUrl?: string;
    cwtoolsNativeHealthUrl?: string;
    token: string;
    pid: number;
    workspaceRoot: string;
    globalStoragePath: string;
    extensionPath: string;
    extensionId: string;
    hostAppName: string;
    hostUriScheme: string;
    project?: {
        kind: WorkspaceProjectDetection['kind'];
        gameId?: string;
        reason: string;
        evidence: string[];
        candidates?: string[];
    };
    createdAt: string;
    updatedAt: string;
}

interface McpContentResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

interface McpResourceResult {
    contents: Array<{ uri: string; mimeType: string; text: string }>;
}

interface McpToolSchema {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface McpBridgeServerOptions {
    context: ExtensionContext;
    host: HostServices;
    workspaceRoot: string;
    /** Live extension-owned classification, shared with startup and project profiling. */
    detectProject?: () => WorkspaceProjectDetection;
    additionalManifestDirs?: string[];
    /** Native, non-MCP CWTools access to the active LanguageClient. */
    executeCommand?: (command: string, args: unknown[]) => Promise<unknown>;
    lspRequest?: (method: string, params: unknown) => Promise<unknown>;
    isActive?: () => boolean;
    readyAtMs?: () => number | undefined;
}

export class McpBridgeServer implements Disposable {
    private readonly toolHandler: SharedToolHandler;
    private readonly token = crypto.randomBytes(32).toString('hex');
    private readonly createdAt = new Date().toISOString();
    private readonly manifestDirs: string[];
    private server?: http.Server;
    private startPromise?: Promise<void>;
    private port?: number;

    constructor(private readonly options: McpBridgeServerOptions) {
        this.toolHandler = createToolCallHandler(options.host);
        const primaryDir = path.join(options.context.globalStorageUri.fsPath, 'mcp');
        this.manifestDirs = Array.from(new Set([
            primaryDir,
            ...(options.additionalManifestDirs ?? []),
        ].map(dir => path.resolve(dir))));
    }

    start(): Promise<void> {
        if (!this.startPromise) {
            this.startPromise = this.startInternal();
        }
        return this.startPromise;
    }

    dispose(): void {
        void this.stop();
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (server) {
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
        await Promise.all(this.manifestPaths().map(file => this.removeManifestIfOwned(file)));
    }

    private projectDetection(): WorkspaceProjectDetection {
        try {
            return this.options.detectProject?.()
                ?? classifyWorkspaceRoot(this.options.workspaceRoot, () => undefined);
        } catch (error) {
            return {
                kind: 'unsupported',
                strength: 'none',
                evidence: [],
                reason: `Workspace detection failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    private async startInternal(): Promise<void> {
        const server = http.createServer((request, response) => {
            void this.handleRequest(request, response).catch(error => {
                this.sendJson(response, 500, {
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: -32603,
                        message: error instanceof Error ? error.message : String(error),
                    },
                });
            });
        });
        this.server = server;

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                const address = server.address();
                if (!address || typeof address === 'string') {
                    reject(new Error('CWTools MCP bridge did not receive a TCP port.'));
                    return;
                }
                this.port = address.port;
                resolve();
            });
        });

        await this.writeManifests();
        ErrorReporter.debug('MCP', `Started extension MCP bridge on 127.0.0.1:${this.port}`);
    }

    private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        if (request.method === 'GET' && request.url === '/healthz') {
            this.sendJson(response, 200, {
                ok: true,
                name: 'cwtools-mcp-extension-bridge',
                protocolVersion: BRIDGE_PROTOCOL_VERSION,
                workspaceRoot: this.options.workspaceRoot,
            });
            return;
        }

        if (request.method === 'GET' && request.url === NATIVE_HEALTH_PATH) {
            this.sendJson(response, 200, {
                ok: true,
                protocolVersion: NATIVE_PROTOCOL_VERSION,
                active: this.options.isActive?.() ?? this.options.executeCommand !== undefined,
                workspaceRoot: path.resolve(this.options.workspaceRoot),
                ...(this.options.readyAtMs?.() !== undefined ? { readyAtMs: this.options.readyAtMs() } : {}),
            });
            return;
        }

        if (request.method === 'POST' && request.url === NATIVE_RPC_PATH) {
            if (!isAuthorizedBridgeRequest(request.headers, this.token)) {
                this.sendJson(response, 401, {
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32001, message: 'Unauthorized CWTools native bridge request.' },
                });
                return;
            }
            let nativeBody: string;
            try {
                nativeBody = await readMcpBridgeRequestBody(request);
            } catch (error) {
                if (!(error instanceof McpBridgeRequestTooLargeError)) throw error;
                this.sendJson(response, 413, {
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32600, message: error.message },
                });
                return;
            }
            const parsed = parseBridgeJsonRpcPayload(nativeBody);
            if (!parsed.ok) {
                this.sendJson(response, 400, {
                    jsonrpc: '2.0',
                    id: parsed.id,
                    error: { code: parsed.code, message: parsed.message },
                });
                return;
            }
            const rpc = parsed.request;
            try {
                if (!this.options.executeCommand || !this.options.lspRequest) {
                    throw new NativeBridgeProtocolError(-32601, 'The native CWTools host is not active.');
                }
                const result = await dispatchNativeCwtoolsRequest(rpc, {
                    executeCommand: this.options.executeCommand,
                    lspRequest: this.options.lspRequest,
                    getIdeContext: args => this.options.host.ide?.getContext(args) ?? Promise.reject(new Error('IDE context is unavailable.')),
                    openVisualEditor: args => this.options.host.ide?.openVisualEditor(args) ?? Promise.reject(new Error('Visual editor is unavailable.')),
                    captureGuiPreview: args => this.options.host.ide?.captureGuiPreview?.(args) ?? Promise.reject(new Error('GUI capture is unavailable.')),
                });
                this.sendJson(response, 200, { jsonrpc: '2.0', id: rpc.id ?? null, result });
            } catch (error) {
                this.sendJson(response, 200, {
                    jsonrpc: '2.0',
                    id: rpc.id ?? null,
                    error: {
                        code: error instanceof NativeBridgeProtocolError ? error.code : -32603,
                        message: error instanceof Error ? error.message : String(error),
                    },
                });
            }
            return;
        }

        if (request.method !== 'POST' || request.url !== '/rpc') {
            this.sendJson(response, 404, { error: 'not_found' });
            return;
        }

        if (!isAuthorizedBridgeRequest(request.headers, this.token)) {
            this.sendJson(response, 401, {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32001, message: 'Unauthorized CWTools MCP bridge request.' },
            });
            return;
        }

        let requestBody: string;
        try {
            requestBody = await readMcpBridgeRequestBody(request);
        } catch (error) {
            if (!(error instanceof McpBridgeRequestTooLargeError)) throw error;
            this.sendJson(response, 413, {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: error.message },
            });
            return;
        }
        const parsed = parseBridgeJsonRpcPayload(requestBody);
        if (!parsed.ok) {
            this.sendJson(response, 400, {
                jsonrpc: '2.0',
                id: parsed.id,
                error: { code: parsed.code, message: parsed.message },
            });
            return;
        }
        const rpc = parsed.request;
        const id = rpc.id ?? null;
        if (!isMcpBridgeMethod(rpc.method)) {
            this.sendJson(response, 200, {
                jsonrpc: '2.0',
                id,
                error: { code: -32601, message: `Unknown CWTools MCP bridge method: ${rpc.method}` },
            });
            return;
        }

        try {
            const result = await this.dispatch(rpc.method, rpc.params);
            this.sendJson(response, 200, { jsonrpc: '2.0', id, result });
        } catch (error) {
            this.sendJson(response, 200, {
                jsonrpc: '2.0',
                id,
                error: {
                    code: -32603,
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }

    private async dispatch(method: string, params: unknown): Promise<unknown> {
        const record = asRecord(params);
        switch (method) {
            case 'tools/list':
                return { tools: listBridgeTools(this.projectDetection(), this.options.host) };
            case 'tools/call':
                return this.callTool(record);
            case 'resources/list':
                return { resources: this.listBridgeResources() };
            case 'resources/read':
                return this.readResource(String(record.uri ?? ''));
            case 'bridge/metadata':
                return this.currentManifest();
            default:
                throw new Error(`Unknown CWTools MCP bridge method: ${method}`);
        }
    }

    private async callTool(params: Record<string, unknown>): Promise<McpContentResult> {
        const name = String(params.name ?? '');
        const args = asRecord(params.arguments ?? params.args);
        const project = this.projectDetection();
        if (!isMcpToolName(name, { includeWrites: true })
            || !isMcpToolAvailable(name, { includeWrites: true, cwtOnly: project.kind === 'cwt-only', capabilities: this.options.host.capabilities })) {
            return toMcpTextResult({
                ok: false,
                status: 'denied',
                source: 'cwtools-vscode-extension',
                error: {
                    code: 'tool_not_available',
                    message: `Tool '${name}' is not available on the CWTools MCP bridge.`,
                },
            }, true);
        }

        const capabilityDenied = bridgeToolDenied(project, name);
        if (capabilityDenied) {
            return toMcpTextResult({
                ok: false,
                status: 'denied',
                source: 'cwtools-vscode-extension',
                error: { code: capabilityDenied.code, message: capabilityDenied.message },
                nextSteps: capabilityDenied.nextSteps,
            }, true);
        }

        try {
            const result = await this.toolHandler(name, args);
            return toMcpTextResult(result, !result.ok);
        } catch (error) {
            return toMcpTextResult({
                ok: false,
                status: 'unavailable',
                source: 'cwtools-vscode-extension',
                error: {
                    code: 'extension_bridge_error',
                    message: error instanceof Error ? error.message : String(error),
                },
                nextSteps: [
                    'Make sure the compatible VS Code host is still open and the CWTools language client has started.',
                ],
            }, true);
        }
    }

    private listBridgeResources() {
        const project = this.projectDetection();
        if (project.kind === 'unsupported' || project.kind === 'ambiguous') return [];
        const base = listResources();
        if (project.kind === 'cwt-only') return filterBridgeResources(base, project);
        const skills = this.discoverSkills();
        for (const skill of skills) {
            base.push({
                uri: `cwtools://skills/${encodeURIComponent(skill.name)}`,
                name: `Paradox Skill: ${skill.name}`,
                description: skill.description,
                mimeType: 'text/markdown',
            });
        }
        return base;
    }

    private discoverSkills() {
        try {
            return listSkills({
                workspaceRoot: this.options.workspaceRoot,
                extensionPath: this.options.context.extensionPath,
                homeDir: getCwtoolsHomeDir(),
            }, 'paradox');
        } catch {
            return [];
        }
    }

    private async readResource(uri: string): Promise<McpResourceResult> {
        const project = this.projectDetection();
        const capabilityDenied = bridgeResourceDenied(project, uri);
        if (capabilityDenied) {
            return {
                contents: [{
                    uri,
                    mimeType: 'application/json',
                    text: `${JSON.stringify({ status: 'error', error: { code: capabilityDenied.code, message: capabilityDenied.message } }, null, 2)}\n`,
                }],
            };
        }
        if (uri.startsWith('cwtools://skills/') && uri !== 'cwtools://skills/catalog') {
            const skillName = decodeURIComponent(uri.slice('cwtools://skills/'.length));
            const loaded = loadSkill(skillName, {
                workspaceRoot: this.options.workspaceRoot,
                extensionPath: this.options.context.extensionPath,
                homeDir: getCwtoolsHomeDir(),
            }, 'paradox');
            if (loaded.success && loaded.content) {
                return {
                    contents: [{
                        uri,
                        mimeType: 'text/markdown',
                        text: `${loaded.content}\n`,
                    }],
                };
            }
            const errMsg = !loaded.success ? loaded.error : `Skill '${skillName}' not found.`;
            return {
                contents: [{
                    uri,
                    mimeType: 'application/json',
                    text: `${JSON.stringify({
                        status: 'error',
                        error: { code: 'skill_not_found', message: errMsg },
                    }, null, 2)}\n`,
                }],
            };
        }

        const data = await this.readResourceData(uri);
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

    private async readResourceData(uri: string): Promise<unknown> {
        if (!(RESOURCE_URIS as readonly string[]).includes(uri)) {
            return {
                status: 'error',
                error: { code: 'resource_not_found', message: `Unknown CWTools MCP resource: ${uri}` },
            };
        }
        switch (uri) {
            case 'cwtools://knowledge/game': {
                const languageId = this.resolveGameId();
                return {
                    status: 'ready',
                    languageId,
                    content: getGameKnowledge(languageId),
                };
            }
            case 'cwtools://knowledge/diagnostic-routing':
                return {
                    status: 'ready',
                    routes: [
                        { category: 'syntax', recommendedTools: ['get_diagnostics', 'get_pdx_block', 'query_cwt_schema', 'query_rules'] },
                        { category: 'localisation', recommendedTools: ['get_diagnostics', 'query_localisation_index', 'write_localisation'] },
                        { category: 'scope', recommendedTools: ['query_scope', 'explain_scope', 'query_cwt_schema', 'query_rules', 'get_completion_at'] },
                        { category: 'reference', recommendedTools: ['go_to_definition', 'find_references', 'workspace_symbols'] },
                        { category: 'shader', recommendedTools: ['query_shader_symbol', 'query_shader_compile_unit', 'explain_shader_reachability', 'validate_shader'] },
                        { category: 'ide', recommendedTools: ['get_ide_context', 'open_in_visual_editor'] },
                    ],
                };
            case 'cwtools://knowledge/workflow-hints':
                return {
                    status: 'ready',
                    hints: [
                        'Use query_types before relying on a game ID.',
                        'Use query_cwt_schema for schema/entity shape and query_rules/query_scope before changing trigger/effect syntax.',
                        'Use get_ide_context to inspect the user active file, cursor selection, dirty buffers, and open visual editors.',
                        'Use open_in_visual_editor to open or refresh GUI, Entity, Particle, Solar System, Tech Tree, Event Chain, or Targeting Weight panels.',
                        'When started with --allow-domain-writes, use write_localisation for .yml files (preserves UTF-8 BOM), typed_pdx_write/candidate_transaction for guarded script edits, and convert_image_to_dds/convert_audio for assets.',
                        'Read cwtools://skills/catalog and cwtools://skills/<name> for Paradox domain SOP skills.',
                    ],
                };
            case 'cwtools://project/profile': {
                const profilePath = getProjectProfilePath(this.options.workspaceRoot);
                const profile = readProfile(this.options.workspaceRoot);
                return profile ?? {
                    status: 'missing',
                    profilePath,
                    _hint: 'Call initialize_project to create .cwtools/project/profile.json.',
                };
            }
            case 'cwtools://project/knowledge-manifest': {
                const manifestPath = getProjectKnowledgeManifestPath(this.options.workspaceRoot);
                return readKnowledgeManifest(this.options.workspaceRoot) ?? {
                    status: 'missing',
                    manifestPath,
                    _hint: 'Call initialize_project and wait for the knowledge export.',
                };
            }
            case 'cwtools://skills/catalog': {
                const skills = this.discoverSkills();
                return {
                    status: 'ready',
                    count: skills.length,
                    skills: skills.map(skill => ({
                        name: skill.name,
                        description: skill.description,
                        source: skill.source,
                        uri: `cwtools://skills/${encodeURIComponent(skill.name)}`,
                    })),
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

    private resolveGameId(): string {
        try {
            const profile = readProfile(this.options.workspaceRoot);
            if (profile?.game?.id) return profile.game.id;
        } catch {
            // ignore profile read errors
        }
        const activeLanguage = vs.window.activeTextEditor?.document.languageId;
        if (activeLanguage && activeLanguage !== 'plaintext') return activeLanguage;
        return this.options.host.projectGameId ?? 'paradox';
    }

    private currentManifest(): BridgeManifest {
        const project = this.projectDetection();
        const port = this.port;
        if (!port) {
            throw new Error('CWTools MCP bridge has not finished starting.');
        }
        const rpcUrl = `http://127.0.0.1:${port}/rpc`;
        const cwtoolsNativeRpcUrl = `http://127.0.0.1:${port}${NATIVE_RPC_PATH}`;
        const cwtoolsNativeHealthUrl = `http://127.0.0.1:${port}${NATIVE_HEALTH_PATH}`;
        return {
            schemaVersion: 1,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            kind: 'cwtools-mcp-extension-bridge',
            host: '127.0.0.1',
            port,
            rpcUrl,
            healthUrl: `http://127.0.0.1:${port}/healthz`,
            ...(this.options.executeCommand ? { cwtoolsNativeRpcUrl, cwtoolsNativeHealthUrl } : {}),
            token: this.token,
            pid: process.pid,
            workspaceRoot: path.resolve(this.options.workspaceRoot),
            globalStoragePath: this.options.context.globalStorageUri.fsPath,
            extensionPath: this.options.context.extensionPath,
            extensionId: this.options.context.extension.id,
            hostAppName: vs.env.appName,
            hostUriScheme: vs.env.uriScheme,
            project: {
                kind: project.kind,
                ...(project.gameId ? { gameId: project.gameId } : {}),
                reason: project.reason,
                evidence: [...project.evidence],
                ...(project.candidates ? { candidates: [...project.candidates] } : {}),
            },
            createdAt: this.createdAt,
            updatedAt: new Date().toISOString(),
        };
    }

    private async writeManifests(): Promise<void> {
        const manifest = this.currentManifest();
        await Promise.all(this.manifestPaths().map(async file => {
            await fs.promises.mkdir(path.dirname(file), { recursive: true });
            await fs.promises.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        }));
    }

    private manifestPaths(): string[] {
        return this.manifestDirs.map(dir => path.join(dir, MANIFEST_FILE_NAME));
    }

    private async removeManifestIfOwned(file: string): Promise<void> {
        try {
            const raw = await fs.promises.readFile(file, 'utf8');
            const parsed = JSON.parse(raw) as Partial<BridgeManifest>;
            if (parsed.token === this.token) {
                await fs.promises.unlink(file);
            }
        } catch {
            // Manifest cleanup is best effort.
        }
    }

    private sendJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
        const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
        response.writeHead(statusCode, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': payload.length,
        });
        response.end(payload);
    }
}

export function mcpBridgeManifestDir(context: ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'mcp');
}

function listBridgeTools(project: WorkspaceProjectDetection | undefined, host: HostServices): McpToolSchema[] {
    const schemas = listMcpToolSchemas({
        includeWrites: true,
        cwtOnly: project?.kind === 'cwt-only',
        capabilities: host.capabilities,
    });
    const names = schemas.map(schema => schema.name);
    const allowed = project ? filterBridgeTools(names, project) : names;
    const allowedSet = new Set(allowed);
    return schemas.filter(schema => allowedSet.has(schema.name));
}

function listResources() {
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
            description: 'Reusable workflow hints for diagnostics, localisation, entity lookup, IDE sensing, and domain writes.',
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
            description: 'Freshness, domains, counts, and fingerprints for the initialize_project semantic knowledge pack.',
            mimeType: 'application/json',
        },
        {
            uri: 'cwtools://skills/catalog',
            name: 'CWTools Paradox skills catalog',
            description: 'Catalog of built-in, project, and user Paradox modding skills exposed as cwtools://skills/<name> resources.',
            mimeType: 'application/json',
        },
    ];
}

function readProfile(workspaceRoot: string): ProjectProfile | undefined {
    try {
        const value = JSON.parse(fs.readFileSync(getProjectProfilePath(workspaceRoot), 'utf8')) as unknown;
        return isProjectProfile(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

function readKnowledgeManifest(workspaceRoot: string): Record<string, unknown> | undefined {
    try {
        return asRecord(JSON.parse(fs.readFileSync(getProjectKnowledgeManifestPath(workspaceRoot), 'utf8')));
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function isFailureResult(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.success === false || record.ok === false || typeof record.error === 'string';
}

function toMcpTextResult(payload: unknown, isError = false): McpContentResult {
    return {
        content: [
            {
                type: 'text',
                text: `${JSON.stringify(payload, null, 2)}\n`,
            },
        ],
        ...(isError ? { isError: true } : {}),
    };
}
