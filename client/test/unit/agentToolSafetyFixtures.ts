import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    PARADOX_WRITE,
} from './schedulingFixtures';

export let diagnosticPairs: Array<[any, any[]]> = [];
export let ignoredDiagnostics: string[] = [];
export let permissionsConfig: any;
export let stubConfigOverrides: Record<string, any> = {};

export function setDiagnosticPairs(pairs: Array<[any, any[]]>): void {
    diagnosticPairs = pairs;
}

export function setIgnoredDiagnostics(ignored: string[]): void {
    ignoredDiagnostics = ignored;
}

export function setPermissionsConfig(cfg: any): void {
    permissionsConfig = cfg;
}

export function setStubConfigOverrides(overrides: Record<string, any>): void {
    stubConfigOverrides = overrides;
}

export function resetStubState(): void {
    diagnosticPairs = [];
    ignoredDiagnostics = [];
    permissionsConfig = undefined;
    stubConfigOverrides = {};
    vscodeStub.workspace.isTrusted = true;
    vscodeStub.workspace.workspaceFolders = [];
}

export const vscodeStub = {
    workspace: {
        workspaceFolders: [],
        isTrusted: true,
        getConfiguration: () => ({
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                if (key in stubConfigOverrides) return stubConfigOverrides[key] as T;
                if (key === 'ignoredDiagnostics') return ignoredDiagnostics as T;
                if (key === 'permissions') return permissionsConfig as T;
                return defaultValue;
            },
        }),
    },
    languages: {
        getDiagnostics: () => diagnosticPairs,
    },
    DiagnosticSeverity: {
        Error: 0,
        Warning: 1,
        Information: 2,
        Hint: 3,
    },
    commands: {
        executeCommand: async () => undefined,
    },
    Uri: {
        file: (filePath: string) => ({
            fsPath: filePath,
            toString: () => `file://${filePath.replace(/\\/g, '/')}`,
        }),
    },
    CancellationTokenSource: class {
        token = {};
        cancel(): void { /* stub */ }
        dispose(): void { /* stub */ }
    },
    window: {
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        createOutputChannel: () => ({
            appendLine: () => undefined,
            show: () => undefined,
            clear: () => undefined,
            dispose: () => undefined,
        }),
    },
};

export function loadToolModules() {
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args]);
    };
    try {
        return {
            fileTools: require('../../extension/ai/tools/fileTools') as typeof import('../../extension/ai/tools/fileTools'),
            externalTools: require('../../extension/ai/tools/externalTools') as typeof import('../../extension/ai/tools/externalTools'),
            agentTools: require('../../extension/ai/agentTools') as typeof import('../../extension/ai/agentTools'),
            agentRunner: require('../../extension/ai/agentRunner') as typeof import('../../extension/ai/agentRunner'),
            permissionPolicy: require('../../extension/ai/runner/permissionPolicy') as typeof import('../../extension/ai/runner/permissionPolicy'),
            processRegistry: require('../../extension/ai/runner/processRegistry') as typeof import('../../extension/ai/runner/processRegistry'),
            workspacePaths: require('../../extension/ai/workspacePaths') as typeof import('../../extension/ai/workspacePaths'),
            configuredGameRoots: require('../../extension/configuredGameRoots') as typeof import('../../extension/configuredGameRoots'),
        };
    } finally {
        moduleLoader._load = originalLoad;
    }
}

export const {
    fileTools,
    externalTools,
    agentTools,
    agentRunner,
    permissionPolicy,
    processRegistry: processRegistryModule,
    workspacePaths,
    configuredGameRoots,
} = loadToolModules();

export const { FileToolHandler } = fileTools;
export const { ExternalToolHandler, HeadTailTextBuffer } = externalTools;
export const { AgentToolExecutor, TOOL_DEFINITIONS } = agentTools;
export const { getAgentToolTargetFiles, SUPERSEDED_BY_LATER_SAME_FILE_WRITE_TOOLS } = agentRunner;
export const { PermissionPolicyStore } = permissionPolicy;
export const { processRegistry } = processRegistryModule;
export const { resetSandboxStorageForTesting, getParadoxUserDataRoots } = configuredGameRoots;

export const TEMP_BASE = path.join(os.tmpdir(), 'cwtools-test-agent-tools');

export function makeWorkspace(): string {
    fs.mkdirSync(TEMP_BASE, { recursive: true });
    return fs.mkdtempSync(path.join(TEMP_BASE, 'cwtools-agent-tools-'));
}

export function cleanupWorkspace(workspaceRoot: string | undefined): void {
    if (workspaceRoot) {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    try { fs.rmdirSync(TEMP_BASE); } catch { /* not empty or already removed */ }
}

export function makeContext(topicId = 'topic-a'): any {
    const abortController = new AbortController();
    return {
        runnerOptions: {
            schedulingState: PARADOX_WRITE,
            topicId,
            abortSignal: abortController.signal,
        },
    };
}
