import * as cp from 'child_process';
import * as vs from 'vscode';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface MCPServerConfig {
    name: string;
    type: 'stdio' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
}

export class MCPClient {
    private process: cp.ChildProcess | null = null;
    private messageId = 0;
    private pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void }>();
    private buffer = '';
    private initialized = false;
    private ssePostEndpoint: string | null = null;
    private sseRequest: http.ClientRequest | null = null;

    constructor(private config: MCPServerConfig) {}

    async connect(): Promise<void> {
        if (this.config.type === 'stdio') {
            return this.connectStdio();
        } else if (this.config.type === 'sse') {
            return this.connectSse();
        }
    }

    private async connectStdio(): Promise<void> {
        if (!this.config.command) throw new Error('Command is required for stdio MCP server');

        const workspaceFolder = vs.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        const safeEnv = Object.fromEntries(
            Object.entries(process.env).filter(([k]) =>
                !/API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL|AUTH/i.test(k)
            )
        );
        this.process = cp.spawn(this.config.command, this.config.args || [], {
            env: { ...safeEnv, PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ...this.config.env },
            cwd: workspaceFolder,
        });

        this.process.stdout?.on('data', (data) => {
            this.buffer += data.toString();
            this.processBuffer();
        });

        this.process.stderr?.on('data', (data) => {
            console.warn(`[MCP Server ${this.config.name}] ${data.toString()}`);
        });

        this.process.on('close', (code) => {
            console.log(`[MCP Server ${this.config.name}] exited with code ${code}`);
            this.cleanup();
        });

        await this.initialize();
    }

    private async connectSse(): Promise<void> {
        if (!this.config.url) throw new Error('URL is required for sse MCP server');
        return new Promise((resolve, reject) => {
            const url = new URL(this.config.url!);
            const client = url.protocol === 'https:' ? https : http;
            
            const req = client.request(url, {
                method: 'GET',
                headers: {
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                }
            }, (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Failed to connect to SSE: ${res.statusCode}`));
                    return;
                }

                let sseBuffer = '';
                res.on('data', (chunk) => {
                    sseBuffer += chunk.toString();
                    let eolIndex;
                    while ((eolIndex = sseBuffer.indexOf('\n\n')) !== -1) {
                        const eventString = sseBuffer.slice(0, eolIndex);
                        sseBuffer = sseBuffer.slice(eolIndex + 2);
                        
                        // Parse event string
                        const lines = eventString.split('\n');
                        let eventType = 'message';
                        let data = '';
                        
                        for (const line of lines) {
                            if (line.startsWith('event: ')) {
                                eventType = line.substring(7).trim();
                            } else if (line.startsWith('data: ')) {
                                data += line.substring(6);
                            }
                        }
                        
                        if (eventType === 'endpoint') {
                            // MCP SSE specific: endpoint event gives us the URL to POST messages to
                            this.ssePostEndpoint = data.trim();
                            if (!this.ssePostEndpoint.startsWith('http')) {
                                // Resolve relative URL
                                this.ssePostEndpoint = new URL(this.ssePostEndpoint, url.origin).toString();
                            }
                            this.initialize().then(resolve).catch(reject);
                        } else if (eventType === 'message' && data) {
                            try {
                                const message = JSON.parse(data);
                                this.handleMessage(message);
                            } catch (e) {
                                console.error(`[MCP] Failed to parse SSE message`, e);
                            }
                        }
                    }
                });

                res.on('close', () => {
                    this.cleanup();
                });
            });

            req.on('error', (err) => {
                reject(err);
                this.cleanup();
            });

            req.end();
            this.sseRequest = req;
        });
    }

    private processBuffer() {
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).trim();
            this.buffer = this.buffer.slice(newlineIndex + 1);

            if (!line) continue;

            try {
                const message = JSON.parse(line);
                this.handleMessage(message);
            } catch (e) {
                console.error(`[MCP] Failed to parse message: ${line}`, e);
            }
        }
    }

    private handleMessage(message: any) {
        if (message.id !== undefined && this.pendingRequests.has(message.id)) {
            const { resolve, reject } = this.pendingRequests.get(message.id)!;
            this.pendingRequests.delete(message.id);

            if (message.error) {
                reject(message.error);
            } else {
                resolve(message.result);
            }
        }
    }

    private sendRequest(method: string, params: any = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId;
            this.pendingRequests.set(id, { resolve, reject });

            const payload = JSON.stringify({
                jsonrpc: '2.0',
                id,
                method,
                params,
            });

            if (this.config.type === 'stdio' && this.process?.stdin) {
                this.process.stdin.write(payload + '\n');
            } else if (this.config.type === 'sse' && this.ssePostEndpoint) {
                const postUrl = new URL(this.ssePostEndpoint);
                const client = postUrl.protocol === 'https:' ? https : http;
                const req = client.request(postUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    }
                }, (res) => {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`MCP POST failed: ${res.statusCode}`));
                    }
                });
                req.on('error', reject);
                req.write(payload);
                req.end();
            } else {
                reject(new Error('Connection not established'));
            }
        });
    }

    async initialize(): Promise<void> {
        const res = await this.sendRequest('initialize', {
            clientInfo: {
                name: 'cwtools-vscode-ai',
                version: '1.0.0',
            },
            capabilities: {},
        });
        this.initialized = true;
        // send initialized notification
        const payload = JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        });
        
        if (this.config.type === 'stdio' && this.process?.stdin) {
            this.process.stdin.write(payload + '\n');
        } else if (this.config.type === 'sse' && this.ssePostEndpoint) {
            const postUrl = new URL(this.ssePostEndpoint);
            const client = postUrl.protocol === 'https:' ? https : http;
            const req = client.request(postUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            });
            req.on('error', (e) => console.error(e));
            req.write(payload);
            req.end();
        }
    }

    async getResources(): Promise<any> {
        if (!this.initialized) throw new Error('MCP Client not initialized');
        return this.sendRequest('resources/list');
    }

    async readResource(uri: string): Promise<any> {
        if (!this.initialized) throw new Error('MCP Client not initialized');
        return this.sendRequest('resources/read', { uri });
    }

    async listTools(): Promise<any> {
        if (!this.initialized) throw new Error('MCP Client not initialized');
        return this.sendRequest('tools/list');
    }

    async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
        if (!this.initialized) throw new Error('MCP Client not initialized');
        return this.sendRequest('tools/call', { name, arguments: args });
    }

    disconnect() {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        if (this.sseRequest) {
            this.sseRequest.destroy();
            this.sseRequest = null;
        }
        this.cleanup();
    }

    private cleanup() {
        for (const [id, req] of this.pendingRequests.entries()) {
            req.reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
        this.initialized = false;
    }
}
