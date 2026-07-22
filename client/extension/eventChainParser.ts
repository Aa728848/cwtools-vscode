/**
 * Catalog-driven Paradox relationship parser used by the event-chain view.
 *
 * Syntax parsing lives here, while mutable game semantics (definition keys,
 * name fields, paths, rule arguments, and reference types) come exclusively
 * from the active CWTools/CWT semantic catalog.
 */

import type { CwtRuleValueReference, PdxSemanticCatalog } from '../shared/pdxSemanticCatalog';
import { tokenize, TokenType, type Token } from './pdxTokenizer';

interface PdxNode {
    key: string;
    value?: string;
    children?: PdxNode[];
    line: number;
}

function parseNodes(tokens: Token[], start = 0, stopAtBrace = false): { nodes: PdxNode[]; next: number } {
    const nodes: PdxNode[] = [];
    let index = start;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.type === TokenType.EOF || (stopAtBrace && token.type === TokenType.RBrace)) {
            return { nodes, next: index + (token.type === TokenType.RBrace ? 1 : 0) };
        }
        const equals = tokens[index + 1];
        const rhs = tokens[index + 2];
        if ((token.type !== TokenType.Identifier && token.type !== TokenType.String)
            || equals?.type !== TokenType.Equals || !rhs) {
            index++;
            continue;
        }
        if (rhs.type === TokenType.LBrace) {
            const parsed = parseNodes(tokens, index + 3, true);
            nodes.push({ key: token.value, children: parsed.nodes, line: token.line });
            index = parsed.next;
        } else if (rhs.type === TokenType.Identifier || rhs.type === TokenType.String || rhs.type === TokenType.Number) {
            nodes.push({ key: token.value, value: rhs.value, line: token.line });
            index += 3;
        } else {
            index++;
        }
    }
    return { nodes, next: index };
}

function parsePdx(content: string): PdxNode[] {
    return parseNodes(tokenize(content)).nodes;
}

export interface SemanticReference {
    typeName: string;
    value: string;
    access: CwtRuleValueReference['access'];
    category: PdxSemanticCatalog['rules'][number]['category'];
    ruleName: string;
}

export type EventConditionRelation = 'requires' | 'alternative' | 'blocks' | 'complex';

export interface EventTriggerCondition extends SemanticReference {
    relation: EventConditionRelation;
    operatorPath: string[];
}

export interface EventNode {
    id: string;
    type: string;
    title?: string;
    file: string;
    line: number;
    endLine: number;
    namespace: string;
    semanticReferences: SemanticReference[];
    meanTimeToHappen?: boolean;
    triggerConditions?: EventTriggerCondition[];
}

export interface EventEdge {
    source: string;
    target: string;
    edgeType: 'effect' | 'semantic' | 'mtth_condition' | 'unknown';
    label?: string;
    conditionRelation?: EventConditionRelation;
}

export interface EventGraph {
    nodes: EventNode[];
    edges: EventEdge[];
}

export interface ExternalSourceNode {
    id: string;
    name: string;
    sourceType: string;
    file: string;
    line: number;
    semanticReferences: SemanticReference[];
}

export interface CommonFileResult {
    edges: EventEdge[];
    externalSources: ExternalSourceNode[];
}

interface EventReferenceRule {
    name: string;
    reference: CwtRuleValueReference;
}

function normalizeReferenceType(typeName: string): string {
    const normalized = typeName.trim().toLowerCase();
    return normalized.startsWith('event.') ? 'event' : normalized;
}

function eventDefinition(catalog: PdxSemanticCatalog) {
    return catalog.definitionTypes.find(type => type.name === 'event');
}

function eventReferenceRules(catalog: PdxSemanticCatalog): EventReferenceRule[] {
    return catalog.rules.flatMap(rule => rule.valueReferences
        .filter(reference => normalizeReferenceType(reference.typeName) === 'event')
        .map(reference => ({ name: rule.name, reference })));
}

function scalar(node: PdxNode | undefined): string | undefined {
    return node?.value === undefined ? undefined : String(node.value);
}

function valueForReference(node: PdxNode, reference: CwtRuleValueReference): string | undefined {
    if (reference.argumentPath === '$value') return scalar(node);
    let current: PdxNode | undefined = node;
    for (const segment of reference.argumentPath.split('.').filter(Boolean)) {
        current = current.children?.find(child => child.key.toLowerCase() === segment.toLowerCase());
        if (!current) return undefined;
    }
    return scalar(current);
}

function definitionTypeForFile(filePath: string, catalog: PdxSemanticCatalog) {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    return catalog.definitionTypes
        .filter(type => type.paths.some(typePath => normalized.startsWith(`${typePath}/`) || normalized.includes(`/${typePath}/`)))
        .sort((a, b) => Math.max(0, ...b.paths.map(value => value.length)) - Math.max(0, ...a.paths.map(value => value.length)))[0];
}

function rulesByName(catalog: PdxSemanticCatalog): Map<string, PdxSemanticCatalog['rules']> {
    const result = new Map<string, PdxSemanticCatalog['rules']>();
    for (const rule of catalog.rules) {
        const values = result.get(rule.name) ?? [];
        values.push(rule);
        result.set(rule.name, values);
    }
    return result;
}

function collectSemanticReferences(nodes: readonly PdxNode[], catalog: PdxSemanticCatalog): SemanticReference[] {
    const result: SemanticReference[] = [];
    const byName = rulesByName(catalog);
    const walk = (items: readonly PdxNode[]) => {
        for (const node of items) {
            for (const rule of byName.get(node.key.toLowerCase()) ?? []) {
                for (const reference of rule.valueReferences) {
                    const value = valueForReference(node, reference);
                    if (!value) continue;
                    const item: SemanticReference = {
                        typeName: reference.typeName.toLowerCase(),
                        value,
                        access: reference.access,
                        category: rule.category,
                        ruleName: rule.name,
                    };
                    if (!result.some(existing => existing.typeName === item.typeName
                        && existing.value === item.value
                        && existing.access === item.access
                        && existing.category === item.category
                        && existing.ruleName === item.ruleName)) result.push(item);
                }
            }
            if (node.children) walk(node.children);
        }
    };
    walk(nodes);
    return result;
}

interface TriggerWalkContext {
    negated: boolean;
    alternative: boolean;
    complex: boolean;
    operatorPath: string[];
}

/**
 * Paradox boolean blocks are language syntax, while the actual trigger names,
 * argument paths, and typed values continue to come from the active CWT catalog.
 */
function nextTriggerContext(node: PdxNode, context: TriggerWalkContext): TriggerWalkContext {
    const key = node.key.toLowerCase();
    const operatorPath = [...context.operatorPath, key];
    if (key === 'or') return { ...context, alternative: true, operatorPath };
    if (key === 'nor') return { ...context, negated: !context.negated, alternative: true, operatorPath };
    if (key === 'nand') return { ...context, negated: !context.negated, complex: true, operatorPath };
    if (key === 'not') {
        const hasCompoundBody = (node.children?.length ?? 0) > 1;
        return {
            ...context,
            negated: !context.negated,
            complex: context.complex || context.alternative || hasCompoundBody,
            operatorPath,
        };
    }
    return { ...context, operatorPath };
}

function collectTriggerConditions(nodes: readonly PdxNode[], catalog: PdxSemanticCatalog): EventTriggerCondition[] {
    const collected: Array<SemanticReference & Omit<TriggerWalkContext, 'operatorPath'> & { operatorPath: string[] }> = [];
    const byName = rulesByName(catalog);
    const walk = (items: readonly PdxNode[], context: TriggerWalkContext) => {
        for (const node of items) {
            const next = nextTriggerContext(node, context);
            for (const rule of byName.get(node.key.toLowerCase()) ?? []) {
                if (rule.category !== 'trigger') continue;
                for (const reference of rule.valueReferences) {
                    const value = valueForReference(node, reference);
                    if (!value) continue;
                    collected.push({
                        typeName: reference.typeName.toLowerCase(),
                        value,
                        access: reference.access,
                        category: rule.category,
                        ruleName: rule.name,
                        negated: next.negated,
                        alternative: next.alternative,
                        complex: next.complex,
                        operatorPath: next.operatorPath,
                    });
                }
            }
            if (node.children) walk(node.children, next);
        }
    };
    walk(nodes, { negated: false, alternative: false, complex: false, operatorPath: [] });

    const result: EventTriggerCondition[] = [];
    for (const item of collected) {
        const relation: EventConditionRelation = item.complex
            ? 'complex'
            : item.negated
                ? 'blocks'
                : item.alternative
                    ? 'alternative'
                    : 'requires';
        const condition: EventTriggerCondition = {
            typeName: item.typeName,
            value: item.value,
            access: item.access,
            category: item.category,
            ruleName: item.ruleName,
            relation,
            operatorPath: item.operatorPath,
        };
        if (!result.some(existing => existing.typeName === condition.typeName
            && existing.value === condition.value
            && existing.access === condition.access
            && existing.ruleName === condition.ruleName
            && existing.relation === condition.relation
            && existing.operatorPath.join('.') === condition.operatorPath.join('.'))) result.push(condition);
    }
    return result;
}

function addEdgeDedup(
    edges: EventEdge[],
    source: string,
    target: string,
    edgeType: EventEdge['edgeType'],
    label?: string,
    conditionRelation?: EventConditionRelation,
): void {
    if (!edges.some(edge => edge.source === source
        && edge.target === target
        && edge.edgeType === edgeType
        && edge.label === label
        && edge.conditionRelation === conditionRelation)) {
        const edge: EventEdge = { source, target, edgeType, label };
        if (conditionRelation) edge.conditionRelation = conditionRelation;
        edges.push(edge);
    }
}

function addEventReferenceEdges(
    sourceId: string,
    nodes: readonly PdxNode[],
    catalog: PdxSemanticCatalog,
    edges: EventEdge[],
): void {
    const byName = new Map<string, EventReferenceRule[]>();
    for (const rule of eventReferenceRules(catalog)) {
        const values = byName.get(rule.name) ?? [];
        values.push(rule);
        byName.set(rule.name, values);
    }
    const walk = (items: readonly PdxNode[]) => {
        for (const node of items) {
            for (const rule of byName.get(node.key.toLowerCase()) ?? []) {
                const targetId = valueForReference(node, rule.reference);
                if (targetId && targetId !== sourceId) addEdgeDedup(edges, sourceId, targetId, 'effect', rule.name);
            }
            if (node.children) walk(node.children);
        }
    };
    walk(nodes);
}

export function parseEventFile(content: string, filePath: string, catalog: PdxSemanticCatalog): EventGraph {
    const definition = eventDefinition(catalog);
    const eventKeys = new Set(definition?.typeKeyFilters.map(key => key.toLowerCase()) ?? []);
    const nameField = definition?.nameField;
    if (!nameField) return { nodes: [], edges: [] };

    const lines = content.split(/\r?\n/);
    const nodes: EventNode[] = [];
    const edges: EventEdge[] = [];
    for (const root of parsePdx(content)) {
        if (!root.children || (eventKeys.size > 0 && !eventKeys.has(root.key.toLowerCase()))) continue;
        const id = scalar(root.children.find(child => child.key.toLowerCase() === nameField));
        if (!id) continue;
        const endLine = Math.max(root.line, findBlockEndLine(lines, root.line - 1));
        const semanticReferences = collectSemanticReferences(root.children, catalog);
        const meanTimeToHappen = root.children.some(child => child.key.toLowerCase() === 'mean_time_to_happen');
        const triggerConditions = meanTimeToHappen
            ? root.children
                .filter(child => child.key.toLowerCase() === 'trigger' && child.children)
                .flatMap(child => collectTriggerConditions(child.children ?? [], catalog))
            : [];
        nodes.push({
            id,
            type: root.key,
            file: filePath,
            line: root.line,
            endLine,
            namespace: id.includes('.') ? id.split('.')[0]! : definition.name,
            semanticReferences,
            meanTimeToHappen,
            triggerConditions,
        });
        addEventReferenceEdges(id, root.children, catalog, edges);
    }
    return { nodes, edges };
}

function findBlockEndLine(lines: readonly string[], startIndex: number): number {
    let depth = 0;
    let entered = false;
    for (let index = Math.max(0, startIndex); index < lines.length; index++) {
        const line = lines[index]!.replace(/#.*$/, '');
        for (const character of line) {
            if (character === '{') {
                depth++;
                entered = true;
            } else if (character === '}') {
                depth--;
            }
        }
        if (entered && depth <= 0) return index + 1;
    }
    return Math.min(lines.length, startIndex + 1);
}

export function parseCommonFile(content: string, filePath: string, catalog: PdxSemanticCatalog): CommonFileResult {
    const edges: EventEdge[] = [];
    const externalSources: ExternalSourceNode[] = [];
    const definition = definitionTypeForFile(filePath, catalog);
    const sourceType = definition?.name ?? 'other';

    for (const root of parsePdx(content).filter(node => node.children)) {
        const name = definition?.nameField
            ? scalar(root.children?.find(child => child.key.toLowerCase() === definition.nameField)) ?? root.key
            : root.key;
        const id = `[${sourceType}] ${name}`;
        const semanticReferences = collectSemanticReferences(root.children ?? [], catalog);
        externalSources.push({ id, name, sourceType, file: filePath, line: root.line, semanticReferences });
        addEventReferenceEdges(id, root.children ?? [], catalog, edges);
    }
    return { edges, externalSources };
}

export function mergeGraphs(graphs: EventGraph[]): EventGraph {
    const nodeMap = new Map<string, EventNode>();
    const edgeMap = new Map<string, EventEdge>();
    for (const graph of graphs) {
        for (const node of graph.nodes) {
            const existing = nodeMap.get(node.id);
            if (!existing) {
                nodeMap.set(node.id, node);
            } else {
                for (const reference of node.semanticReferences) {
                    if (!existing.semanticReferences.some(item => item.typeName === reference.typeName
                        && item.value === reference.value
                        && item.access === reference.access
                        && item.ruleName === reference.ruleName)) existing.semanticReferences.push(reference);
                }
                existing.meanTimeToHappen ||= node.meanTimeToHappen;
                for (const condition of node.triggerConditions ?? []) {
                    existing.triggerConditions ??= [];
                    if (!existing.triggerConditions.some(item => item.typeName === condition.typeName
                        && item.value === condition.value
                        && item.ruleName === condition.ruleName
                        && item.relation === condition.relation
                        && item.operatorPath.join('.') === condition.operatorPath.join('.'))) {
                        existing.triggerConditions.push(condition);
                    }
                }
            }
        }
        for (const edge of graph.edges) edgeMap.set(`${edge.source}\u0000${edge.target}\u0000${edge.edgeType}\u0000${edge.label ?? ''}\u0000${edge.conditionRelation ?? ''}`, edge);
    }
    return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

/** Connect any CWT-declared typed writer to readers of the same type and value. */
export function buildImplicitEdges(graph: EventGraph): EventEdge[] {
    const writers = new Map<string, string[]>();
    const readers = new Map<string, string[]>();
    for (const node of graph.nodes) {
        for (const reference of node.semanticReferences) {
            const key = `${reference.typeName.toLowerCase()}:${reference.value.toLowerCase()}`;
            const isMtthTriggerCondition = node.meanTimeToHappen
                && node.triggerConditions?.some(condition => condition.typeName.toLowerCase() === reference.typeName.toLowerCase()
                    && condition.value.toLowerCase() === reference.value.toLowerCase()
                    && condition.ruleName === reference.ruleName);
            if (isMtthTriggerCondition && reference.access !== 'value_set') continue;
            const index = reference.access === 'value_set' ? writers : readers;
            const ids = index.get(key) ?? [];
            if (!ids.includes(node.id)) ids.push(node.id);
            index.set(key, ids);
        }
    }

    const edges: EventEdge[] = [];
    for (const [key, writerIds] of writers) {
        for (const readerId of readers.get(key) ?? []) {
            for (const writerId of writerIds) {
                if (writerId !== readerId) addEdgeDedup(edges, writerId, readerId, 'semantic', key);
            }
        }
    }
    for (const node of graph.nodes) {
        if (!node.meanTimeToHappen) continue;
        for (const condition of node.triggerConditions ?? []) {
            if (condition.access === 'value_set') continue;
            const key = `${condition.typeName.toLowerCase()}:${condition.value.toLowerCase()}`;
            for (const writerId of writers.get(key) ?? []) {
                if (writerId === node.id) continue;
                addEdgeDedup(
                    edges,
                    writerId,
                    node.id,
                    'mtth_condition',
                    `${condition.ruleName} = ${condition.value}`,
                    condition.relation,
                );
            }
        }
    }
    return edges;
}

export function extractConnectedSubgraph(
    fullGraph: EventGraph,
    seedIds: Set<string>,
    maxDepth = 10,
): EventGraph {
    const visited = new Set<string>();
    let frontier = [...seedIds];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const next: string[] = [];
        for (const id of frontier) {
            if (visited.has(id)) continue;
            visited.add(id);
            for (const edge of fullGraph.edges) {
                if (edge.source === id && !visited.has(edge.target)) next.push(edge.target);
                if (edge.target === id && !visited.has(edge.source)) next.push(edge.source);
            }
        }
        frontier = next;
    }
    frontier.forEach(id => visited.add(id));
    return {
        nodes: fullGraph.nodes.filter(node => visited.has(node.id)),
        edges: fullGraph.edges.filter(edge => visited.has(edge.source) || visited.has(edge.target)),
    };
}
