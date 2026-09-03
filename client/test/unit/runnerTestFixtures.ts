import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Common test fixtures and mock loaders for runner, checkpoint, and ledger tests.
 * Eliminates duplicate vscode stubs and dynamic module loading boilerplate across unit tests.
 */

export interface VscodeRunnerStubOptions {
    workspaceFolders?: Array<{ uri: { fsPath: string } }>;
    configOverrides?: Record<string, any>;
    isTrusted?: boolean;
}

export function createVscodeRunnerStub(options: VscodeRunnerStubOptions = {}) {
    const folders = options.workspaceFolders ?? [];
    const config = options.configOverrides ?? {};

    return {
        workspace: {
            workspaceFolders: folders,
            isTrusted: options.isTrusted !== false,
            getConfiguration: () => ({
                get: <T>(key: string, defaultValue?: T): T | undefined => {
                    if (key in config) return config[key] as T;
                    return defaultValue;
                },
            }),
            textDocuments: [],
        },
        window: {
            activeTextEditor: undefined,
            createOutputChannel: () => ({
                appendLine: () => undefined,
                show: () => undefined,
                clear: () => undefined,
                dispose: () => undefined,
            }),
            showWarningMessage: async () => undefined,
            showInformationMessage: async () => undefined,
            showErrorMessage: async () => undefined,
        },
        languages: {
            getDiagnostics: () => [],
        },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
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
    };
}

/**
 * Dynamically load a CommonJS module with a custom or default vscode stub.
 */
export function loadModuleWithVscodeStub<T>(
    moduleRelativePath: string,
    customStub?: any,
    options: { freshPaths?: string[] } = {},
): T {
    const stub = customStub ?? createVscodeRunnerStub();
    const moduleLoader = require('module') as { _load: (...args: any[]) => any };
    const originalLoad = moduleLoader._load;

    const freshResolvedPaths = (options.freshPaths ?? []).map(p => {
        try { return require.resolve(p); } catch { return undefined; }
    }).filter((p): p is string => p !== undefined);

    const cachedEntries = new Map<string, any>();
    for (const p of freshResolvedPaths) {
        if (require.cache[p]) {
            cachedEntries.set(p, require.cache[p]);
            delete require.cache[p];
        }
    }

    moduleLoader._load = function (this: unknown, request: string, ...args: any[]) {
        if (request === 'vscode') return stub;
        return originalLoad.apply(this, [request, ...args]);
    };

    try {
        const targetResolved = require.resolve(moduleRelativePath);
        delete require.cache[targetResolved];
        return require(targetResolved) as T;
    } finally {
        moduleLoader._load = originalLoad;
        for (const [p, cached] of cachedEntries.entries()) {
            if (cached) require.cache[p] = cached;
        }
    }
}

/**
 * Safely creates a unique temporary workspace under os.tmpdir() with guaranteed cleanup.
 */
export function createTempRunnerWorkspace(prefix: string): { workspaceRoot: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    return {
        workspaceRoot: dir,
        cleanup: () => {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors on busy files in Windows
            }
        },
    };
}
