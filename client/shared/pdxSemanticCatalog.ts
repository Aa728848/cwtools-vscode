/** Current-game semantic metadata produced by CWTools + active CWT rules. */

export type PdxRuleCategory = 'trigger' | 'effect' | 'scope_change' | 'modifier';

export interface CwtRuleValueReference {
    argumentPath: string;
    access: 'value' | 'value_set' | 'scope' | 'type';
    typeName: string;
}

export interface PdxSemanticCatalog {
    status: 'ready' | 'partial' | 'unavailable';
    source: 'lsp' | 'cwt_fallback';
    gameProfile?: string;
    rulesGeneration?: number;
    rulesContentHash?: string;
    rules: Array<{
        name: string;
        category: PdxRuleCategory;
        supportedScopes: string[];
        pushScope?: string;
        valueReferences: CwtRuleValueReference[];
    }>;
    definitionTypes: Array<{
        name: string;
        paths: string[];
        nameField?: string;
        typeKeyFilters: string[];
    }>;
    warnings: string[];
}

export type PdxDefinitionType = PdxSemanticCatalog['definitionTypes'][number];

/**
 * Resolve a script block to the active CWTools TypeDef that owns its file path.
 * A type_key_filter is authoritative when present; ambiguous unfiltered matches
 * deliberately return undefined instead of guessing a game-specific kind.
 */
export function matchPdxDefinitionType(
    definitionTypes: readonly PdxDefinitionType[],
    filePath: string,
    blockKey?: string,
): PdxDefinitionType | undefined {
    const normalizedFile = `/${filePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()}/`;
    const matches = definitionTypes.flatMap(definition => definition.paths
        .map(candidate => candidate.replace(/\\/g, '/').replace(/^game\//i, '').replace(/^\/+|\/+$/g, '').toLowerCase())
        .filter(Boolean)
        .filter(candidate => normalizedFile.includes(`/${candidate}/`))
        .map(candidate => ({ definition, pathLength: candidate.length })));
    if (matches.length === 0) return undefined;
    const longestPath = Math.max(...matches.map(match => match.pathLength));
    const candidates = matches
        .filter(match => match.pathLength === longestPath)
        .map(match => match.definition)
        .filter((definition, index, values) => values.findIndex(value => value.name === definition.name) === index)
        .sort((left, right) => left.name.localeCompare(right.name));
    const normalizedKey = blockKey?.toLowerCase();
    if (normalizedKey) {
        const filtered = candidates.filter(definition => definition.typeKeyFilters.includes(normalizedKey));
        if (filtered.length === 1) return filtered[0];
        if (filtered.length > 1) return undefined;
    }
    const unfiltered = candidates.filter(definition => definition.typeKeyFilters.length === 0);
    return unfiltered.length === 1 ? unfiltered[0] : undefined;
}

/** Validate and normalize the untrusted LSP wire response at the shared boundary. */
export function parsePdxSemanticCatalog(
    value: unknown,
    source: PdxSemanticCatalog['source'] = 'lsp',
): PdxSemanticCatalog | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (record.ok === false || !Array.isArray(record.rules) || !Array.isArray(record.definitionTypes)) return undefined;
    const categories = new Set<PdxRuleCategory>(['trigger', 'effect', 'scope_change', 'modifier']);
    const accesses = new Set<CwtRuleValueReference['access']>(['value', 'value_set', 'scope', 'type']);
    const rules: PdxSemanticCatalog['rules'] = [];
    for (const item of record.rules.slice(0, 10_000)) {
        if (!item || typeof item !== 'object') continue;
        const rule = item as Record<string, unknown>;
        if (typeof rule.name !== 'string' || !categories.has(rule.category as PdxRuleCategory)) continue;
        const valueReferences: CwtRuleValueReference[] = [];
        if (Array.isArray(rule.valueReferences)) {
            for (const candidate of rule.valueReferences.slice(0, 32)) {
                if (!candidate || typeof candidate !== 'object') continue;
                const reference = candidate as Record<string, unknown>;
                if (typeof reference.argumentPath !== 'string'
                    || typeof reference.access !== 'string'
                    || !accesses.has(reference.access as CwtRuleValueReference['access'])
                    || typeof reference.typeName !== 'string') continue;
                valueReferences.push({
                    argumentPath: reference.argumentPath,
                    access: reference.access as CwtRuleValueReference['access'],
                    typeName: reference.typeName.toLowerCase(),
                });
            }
        }
        rules.push({
            name: rule.name.toLowerCase(),
            category: rule.category as PdxRuleCategory,
            supportedScopes: Array.isArray(rule.supportedScopes)
                ? rule.supportedScopes.filter((scope): scope is string => typeof scope === 'string').map(scope => scope.toLowerCase()).sort()
                : [],
            pushScope: typeof rule.pushScope === 'string' ? rule.pushScope.toLowerCase() : undefined,
            valueReferences,
        });
    }
    const definitionTypes: PdxSemanticCatalog['definitionTypes'] = [];
    for (const item of record.definitionTypes.slice(0, 4_000)) {
        if (!item || typeof item !== 'object') continue;
        const definition = item as Record<string, unknown>;
        if (typeof definition.name !== 'string') continue;
        definitionTypes.push({
            name: definition.name.toLowerCase(),
            paths: Array.isArray(definition.paths)
                ? definition.paths.filter((pathValue): pathValue is string => typeof pathValue === 'string')
                    .map(pathValue => pathValue.replace(/\\/g, '/').replace(/^game\//i, '').replace(/^\/+|\/+$/g, '').toLowerCase())
                    .filter(Boolean)
                    .sort()
                : [],
            nameField: typeof definition.nameField === 'string' ? definition.nameField.toLowerCase() : undefined,
            typeKeyFilters: Array.isArray(definition.typeKeyFilters)
                ? definition.typeKeyFilters.filter((key): key is string => typeof key === 'string').map(key => key.toLowerCase()).sort()
                : [],
        });
    }
    const status = record.status === 'ready' || record.status === 'partial' || record.status === 'unavailable'
        ? record.status
        : rules.length > 0 && definitionTypes.length > 0 ? 'ready' : rules.length > 0 || definitionTypes.length > 0 ? 'partial' : 'unavailable';
    return {
        status,
        source,
        gameProfile: typeof record.gameProfile === 'string' ? record.gameProfile : undefined,
        rulesGeneration: typeof record.rulesGeneration === 'number' ? record.rulesGeneration : undefined,
        rulesContentHash: typeof record.rulesContentHash === 'string' ? record.rulesContentHash : undefined,
        rules,
        definitionTypes,
        warnings: Array.isArray(record.warnings)
            ? record.warnings.filter((warning): warning is string => typeof warning === 'string').slice(0, 20)
            : [],
    };
}
