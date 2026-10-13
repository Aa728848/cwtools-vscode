import { expect } from 'chai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MCPServerConfig } from '../../extension/ai/types';
import {
    clearMcpServerFileConfigCache,
    loadMcpServerFileConfigs,
    mergeMcpServerConfigs,
    mcpServerSource,
    type SourcedMCPServerConfig,
} from '../../extension/ai/mcpConfig';

/**
 * The loaders read ~/.cwtools/mcp.json via os.homedir(); tests redirect the
 * home directory into a temp sandbox so the real user file is never touched.
 * Patching goes through the raw CJS module (the `import * as os` namespace is
 * getter-only, but its getters forward to the raw module's live properties).
 */
describe('MCP server file configs', () => {
    const rawOs = require('os') as typeof os & { homedir: () => string };
    let sandbox: string;
    let fakeHome: string;
    let workspaceRoot: string;
    let originalHomedir: () => string;

    const writeMcpJson = (cwtoolsDir: string, content: unknown) => {
        fs.mkdirSync(cwtoolsDir, { recursive: true });
        fs.writeFileSync(
            path.join(cwtoolsDir, 'mcp.json'),
            typeof content === 'string' ? content : JSON.stringify(content),
            'utf8',
        );
    };
    const writeHome = (content: unknown) => writeMcpJson(path.join(fakeHome, '.cwtools'), content);
    const writeProject = (content: unknown) => writeMcpJson(path.join(workspaceRoot, '.cwtools'), content);

    beforeEach(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-mcp-config-'));
        fakeHome = path.join(sandbox, 'home');
        workspaceRoot = path.join(sandbox, 'workspace');
        originalHomedir = rawOs.homedir;
        rawOs.homedir = () => fakeHome;
        clearMcpServerFileConfigCache();
    });

    afterEach(() => {
        rawOs.homedir = originalHomedir;
        clearMcpServerFileConfigCache();
        fs.rmSync(sandbox, { recursive: true, force: true });
    });

    it('returns empty results when no files exist', () => {
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home).to.deep.equal([]);
        expect(result.project).to.deep.equal([]);
        expect(result.warnings).to.deep.equal([]);
        expect(result.homeFilePath).to.equal(path.join(fakeHome, '.cwtools', 'mcp.json'));
        expect(result.projectFilePath).to.equal(path.join(workspaceRoot, '.cwtools', 'mcp.json'));
    });

    it('loads valid stdio and sse entries with defaults applied', () => {
        writeHome({
            mcpServers: {
                'local-tool': { command: 'uvx', args: ['mcp-server'], env: { MODE: 'fast' } },
                'remote-tool': { type: 'sse', url: 'https://example.com/sse', capabilityDomain: 'paradox' },
            },
        });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.warnings).to.deep.equal([]);
        expect(result.home).to.have.length(2);
        const local = result.home.find(server => server.name === 'local-tool');
        expect(local).to.deep.include({ name: 'local-tool', type: 'stdio', capabilityDomain: 'both', command: 'uvx' });
        expect(local?.args).to.deep.equal(['mcp-server']);
        expect(local?.env).to.deep.equal({ MODE: 'fast' });
        const remote = result.home.find(server => server.name === 'remote-tool');
        expect(remote).to.deep.include({ name: 'remote-tool', type: 'sse', capabilityDomain: 'paradox', url: 'https://example.com/sse' });
    });

    it('infers sse from url and stdio otherwise when type is omitted', () => {
        writeHome({
            mcpServers: {
                inferredSse: { url: 'http://localhost:3000/sse' },
                inferredStdio: { command: 'npx' },
            },
        });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home.find(server => server.name === 'inferredSse')?.type).to.equal('sse');
        expect(result.home.find(server => server.name === 'inferredStdio')?.type).to.equal('stdio');
    });

    it('loads the project file only when a workspace root is given', () => {
        writeProject({ mcpServers: { proj: { command: 'npx' } } });
        expect(loadMcpServerFileConfigs(workspaceRoot).project).to.have.length(1);
        const noRoot = loadMcpServerFileConfigs(undefined);
        expect(noRoot.project).to.deep.equal([]);
        expect(noRoot.projectFilePath).to.equal(undefined);
    });

    it('collects a warning instead of throwing on invalid JSON', () => {
        writeHome('{ not json');
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home).to.deep.equal([]);
        expect(result.warnings.some(warning => warning.includes('invalid JSON'))).to.equal(true);
    });

    it('rejects non-object roots and non-object mcpServers', () => {
        writeHome('[1,2]');
        let result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.warnings.some(warning => warning.includes('root'))).to.equal(true);

        writeHome({ mcpServers: ['nope'] });
        clearMcpServerFileConfigCache();
        result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.warnings.some(warning => warning.includes('mcpServers'))).to.equal(true);
    });

    it('skips stdio entries without a command', () => {
        writeHome({ mcpServers: { broken: { args: ['x'] }, ok: { command: 'npx' } } });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home.map(server => server.name)).to.deep.equal(['ok']);
        expect(result.warnings.some(warning => warning.includes('broken') && warning.includes('command'))).to.equal(true);
    });

    it('skips sse entries with a missing or non-http url', () => {
        writeHome({
            mcpServers: {
                noUrl: { type: 'sse' },
                badProtocol: { type: 'sse', url: 'ftp://example.com/sse' },
                notAUrl: { type: 'sse', url: '::not a url::' },
                ok: { type: 'sse', url: 'http://localhost:1/sse' },
            },
        });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home.map(server => server.name)).to.deep.equal(['ok']);
        expect(result.warnings.filter(warning => warning.includes('skipped sse server'))).to.have.length(3);
    });

    it('skips entries with invalid names', () => {
        writeHome({
            mcpServers: {
                'has space': { command: 'npx' },
                'has/slash': { command: 'npx' },
                ['x'.repeat(65)]: { command: 'npx' },
                'valid-name.1_2': { command: 'npx' },
            },
        });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home.map(server => server.name)).to.deep.equal(['valid-name.1_2']);
        expect(result.warnings.filter(warning => warning.includes('invalid name'))).to.have.length(3);
    });

    it('skips entries with an unknown transport type', () => {
        writeHome({ mcpServers: { bad: { type: 'websocket', url: 'http://x' } } });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home).to.deep.equal([]);
        expect(result.warnings.some(warning => warning.includes("'type'"))).to.equal(true);
    });

    it('defaults an invalid capabilityDomain to both with a warning', () => {
        writeHome({ mcpServers: { server: { command: 'npx', capabilityDomain: 'everything' } } });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home[0]?.capabilityDomain).to.equal('both');
        expect(result.warnings.some(warning => warning.includes('capabilityDomain'))).to.equal(true);
    });

    it('narrows args and env to strings and drops other values', () => {
        writeHome({
            mcpServers: {
                server: {
                    command: 'npx',
                    args: ['a', 1, null, 'b'],
                    env: { GOOD: '1', BAD: 2 },
                },
            },
        });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home[0]?.args).to.deep.equal(['a', 'b']);
        expect(result.home[0]?.env).to.deep.equal({ GOOD: '1' });
        expect(result.warnings.some(warning => warning.includes("non-string 'args'"))).to.equal(true);
        expect(result.warnings.some(warning => warning.includes("non-string 'env'"))).to.equal(true);
    });

    it('ignores unknown fields (whitelist) without failing the entry', () => {
        writeHome({ mcpServers: { server: { command: 'npx', headers: { x: 'y' }, disabled: true } } });
        const result = loadMcpServerFileConfigs(workspaceRoot);
        expect(result.home).to.have.length(1);
        expect(result.home[0]).to.not.have.property('headers');
        expect(result.home[0]).to.not.have.property('disabled');
    });

    it('changes the version token when a file is rewritten', () => {
        writeHome({ mcpServers: { a: { command: 'npx' } } });
        const first = loadMcpServerFileConfigs(workspaceRoot);
        writeHome({ mcpServers: { a: { command: 'npx' }, b: { command: 'uvx', args: ['extra'] } } });
        clearMcpServerFileConfigCache();
        const second = loadMcpServerFileConfigs(workspaceRoot);
        expect(second.version).to.not.equal(first.version);
    });

    it('serves repeat calls from the mtime cache', () => {
        writeHome({ mcpServers: { a: { command: 'npx' } } });
        const first = loadMcpServerFileConfigs(workspaceRoot);
        const second = loadMcpServerFileConfigs(workspaceRoot);
        expect(second).to.equal(first);
    });
});

describe('mergeMcpServerConfigs', () => {
    const stdio = (name: string, command: string): MCPServerConfig => ({
        name, type: 'stdio', capabilityDomain: 'both', command,
    });

    it('annotates sources and keeps settings entries untouched', () => {
        const merged = mergeMcpServerConfigs([stdio('a', 'cmd-a')], [], []);
        expect(merged).to.have.length(1);
        expect(merged[0]?.source).to.equal('settings');
        expect(merged[0]?.command).to.equal('cmd-a');
    });

    it('lets home override settings and project override both, whole-entry', () => {
        const merged = mergeMcpServerConfigs(
            [stdio('same', 'from-settings'), stdio('settings-only', 's')],
            [stdio('same', 'from-home'), stdio('home-only', 'h')],
            [stdio('same', 'from-project')],
        );
        const byName = new Map(merged.map(server => [server.name, server]));
        expect(byName.get('same')?.command).to.equal('from-project');
        expect(byName.get('same')?.source).to.equal('project');
        expect(byName.get('settings-only')?.source).to.equal('settings');
        expect(byName.get('home-only')?.source).to.equal('home');

        const homeWins = mergeMcpServerConfigs([stdio('same', 'from-settings')], [stdio('same', 'from-home')], []);
        expect(homeWins[0]?.command).to.equal('from-home');
        expect(homeWins[0]?.source).to.equal('home');
    });

    it('skips entries without a usable name', () => {
        const merged = mergeMcpServerConfigs(
            [{ ...stdio('ok', 'cmd') }, { name: '', type: 'stdio', capabilityDomain: 'both' }],
            [],
            [],
        );
        expect(merged.map(server => server.name)).to.deep.equal(['ok']);
    });

    it('narrows the source annotation with mcpServerSource', () => {
        const plain = stdio('plain', 'cmd');
        const homeServer: SourcedMCPServerConfig = { ...plain, source: 'home' };
        const projectServer: SourcedMCPServerConfig = { ...plain, source: 'project' };
        expect(mcpServerSource(plain)).to.equal('settings');
        expect(mcpServerSource(homeServer)).to.equal('home');
        expect(mcpServerSource(projectServer)).to.equal('project');
    });
});
