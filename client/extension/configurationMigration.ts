import * as vs from 'vscode';
import type { ExtensionContext } from 'vscode';

export const SETTINGS_NAMESPACE = 'stellarisLanguageServices';
export const LEGACY_SETTINGS_NAMESPACE = 'cwtools';

type Inspection = ReturnType<vs.WorkspaceConfiguration['inspect']>;

const FALLBACK_CONFIGURATION_SUFFIXES = [
    'editor.formatIndentOnPaste',
    'trace.server',
    'localisation.languages',
    'localisation.generated_strings',
    'errors.vanilla',
    'errors.ignore',
    'errors.ignorefiles',
    'experimental',
    'debug_mode',
    'showInlineText',
    'logging.diagnostic',
    'rules_version',
    'rules_remote_url',
    'rules_folder',
    'ignore_patterns',
    'cache.eu4',
    'cache.hoi4',
    'cache.stellaris',
    'cache.ck2',
    'cache.imperator',
    'cache.vic2',
    'cache.ck3',
    'cache.vic3',
    'cache.eu5',
    'scriptedVariablesFallbackPaths',
    'graph.zoomSensitivity',
    'maxFileSize',
    'diagnostics.deferDynamicParameterDiagnostics',
    'diagnostics.dynamicPreflightTimeoutMs',
    'diagnostics.dynamicPreflightMaxEntities',
    'checkForUpdates',
    'ai.enabled',
    'ai.provider',
    'ai.model',
    'ai.endpoint',
    'ai.providerEndpoints',
    'ai.customApiFormat',
    'ai.agentFileWriteMode',
    'ai.approvals.reviewer',
    'ai.developer.disableSecuritySandbox',
    'ai.policy.preset',
    'ai.maxRetries',
    'ai.requestTimeoutMs',
    'ai.reasoningEffort',
    'ai.maxContextTokens',
    'ai.inlineCompletion.enabled',
    'ai.inlineCompletion.debounceMs',
    'ai.inlineCompletion.maxTokens',
    'ai.inlineCompletion.contextBeforeLines',
    'ai.inlineCompletion.contextAfterLines',
    'ai.inlineCompletion.includeMcpContext',
    'ai.inlineCompletion.mcpCacheTtlMs',
    'ai.inlineCompletion.requestTimeoutMs',
    'ai.inlineCompletion.lspFastPath',
    'ai.inlineCompletion.overlapStripping',
    'ai.inlineCompletion.provider',
    'ai.inlineCompletion.model',
    'ai.inlineCompletion.endpoint',
    'ai.dynamicModels',
    'ai.dynamicModelsContext',
    'ai.ignoredDiagnostics',
    'ai.enhancedDiagnostics',
    'ai.braveSearchApiKey',
    'ai.exaApiKey',
    'ai.mcp.servers',
    'ai.orchestrator.agentModels',
    'ai.performance.legacyFullToolset',
    'ai.performance.fullProjectRulesInBuild',
    'ai.performance.includeFullSmallFiles',
    'ai.permissions',
    'ai.imageMagickPath',
    'ai.ffmpegPath',
    'vanillaCompare.showGutterDecorations',
] as const;

function hasConfiguredValue(inspection: Inspection | undefined, field: keyof NonNullable<Inspection>): boolean {
    return !!inspection
        && Object.prototype.hasOwnProperty.call(inspection, field)
        && (inspection as Record<string, unknown>)[field] !== undefined;
}

function contributedConfigurationSuffixes(context: ExtensionContext): string[] {
    const configuration = context.extension.packageJSON?.contributes?.configuration;
    const entries = Array.isArray(configuration) ? configuration : [configuration];
    const suffixes = new Set<string>(FALLBACK_CONFIGURATION_SUFFIXES);
    for (const entry of entries) {
        const properties = entry?.properties;
        if (!properties || typeof properties !== 'object') continue;
        for (const key of Object.keys(properties)) {
            if (key.startsWith(`${SETTINGS_NAMESPACE}.`)) {
                suffixes.add(key.slice(SETTINGS_NAMESPACE.length + 1));
            }
        }
    }
    return Array.from(suffixes);
}

async function copyConfiguredValue(
    suffix: string,
    field: keyof NonNullable<Inspection>,
    target: vs.ConfigurationTarget,
    scope?: vs.ConfigurationScope,
): Promise<boolean> {
    const legacyConfig = vs.workspace.getConfiguration(LEGACY_SETTINGS_NAMESPACE, scope);
    const currentConfig = vs.workspace.getConfiguration(SETTINGS_NAMESPACE, scope);
    const legacy = legacyConfig.inspect(suffix);
    const current = currentConfig.inspect(suffix);

    if (!hasConfiguredValue(legacy, field) || hasConfiguredValue(current, field)) {
        return false;
    }

    try {
        await currentConfig.update(
            suffix,
            (legacy as Record<string, unknown>)[field],
            target,
        );
        return true;
    } catch {
        return false;
    }
}

export async function migrateLegacyConfiguration(context: ExtensionContext): Promise<number> {
    let migrated = 0;
    const suffixes = contributedConfigurationSuffixes(context);

    for (const suffix of suffixes) {
        try {
            if (await copyConfiguredValue(suffix, 'globalValue', vs.ConfigurationTarget.Global)) {
                migrated++;
            }
            if (await copyConfiguredValue(suffix, 'workspaceValue', vs.ConfigurationTarget.Workspace)) {
                migrated++;
            }

            for (const folder of vs.workspace.workspaceFolders ?? []) {
                if (await copyConfiguredValue(suffix, 'workspaceFolderValue', vs.ConfigurationTarget.WorkspaceFolder, folder.uri)) {
                    migrated++;
                }
            }
        } catch {
            // Migration is compatibility glue only; never let it block activation.
        }
    }

    return migrated;
}
