/**
 * Catalog-driven Paradox relationship parser used by the event-chain view.
 *
 * Syntax parsing lives here, while mutable game semantics (definition keys,
 * name fields, paths, rule arguments, and reference types) come exclusively
 * from the active CWTools/CWT semantic catalog.
 */

import { matchPdxDefinitionType, type CwtRuleValueReference, type PdxSemanticCatalog } from '../shared/pdxSemanticCatalog';
import { tokenize, TokenType, type Token } from './pdxTokenizer';

interface PdxNode {
    key: string;
    value?: string;
    children?: PdxNode[];
    line: number;
}

function isPdxAtom(token: Token | undefined): token is Token {
    return token?.type === TokenType.Identifier || token?.type === TokenType.String || token?.type === TokenType.Number;
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
        if (!isPdxAtom(token) || equals?.type !== TokenType.Equals || !rhs) {
            if (isPdxAtom(token)) {
                nodes.push({ key: '$value', value: token.value, line: token.line });
            }
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
    definitionIdentity?: {
        typeName: string;
        value: string;
    };
    meanTimeToHappen?: boolean;
    triggerConditions?: EventTriggerCondition[];
}

export interface EventEdge {
    source: string;
    target: string;
    edgeType: 'effect' | 'trigger' | 'mtth_condition' | 'definition' | 'definition_effect' | 'definition_trigger' | 'sequence' | 'unknown';
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
    definitionIdentity: {
        typeName: string;
        value: string;
    };
}

export interface CommonFileResult {
    edges: EventEdge[];
    externalSources: ExternalSourceNode[];
}

/** Prefer the event under, or nearest to, the invoking editor cursor. */
export function selectEventSeedIds(graph: EventGraph, sourceLine?: number): string[] {
    if (sourceLine === undefined || !Number.isInteger(sourceLine) || sourceLine < 1) {
        return graph.nodes.map(node => node.id);
    }
    const containing = graph.nodes
        .filter(node => node.line <= sourceLine && node.endLine >= sourceLine)
        .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line)
            || a.line - b.line
            || a.id.localeCompare(b.id));
    if (containing.length > 0) return [containing[0]!.id];

    const nearest = [...graph.nodes].sort((a, b) => {
        const distanceTo = (node: EventNode) => sourceLine < node.line
            ? node.line - sourceLine
            : sourceLine - node.endLine;
        return distanceTo(a) - distanceTo(b) || a.line - b.line || a.id.localeCompare(b.id);
    });
    return nearest.length > 0 ? [nearest[0]!.id] : [];
}

interface EventReferenceRule {
    name: string;
    reference: CwtRuleValueReference;
    category: PdxSemanticCatalog['rules'][number]['category'];
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
        .map(reference => ({ name: rule.name, reference, category: rule.category })));
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
    edgeKeys?: Set<string>,
): void {
    const key = `${source}\u0000${target}\u0000${edgeType}\u0000${label ?? ''}\u0000${conditionRelation ?? ''}`;
    const duplicate = edgeKeys
        ? edgeKeys.has(key)
        : edges.some(edge => edge.source === source
        && edge.target === target
        && edge.edgeType === edgeType
        && edge.label === label
        && edge.conditionRelation === conditionRelation);
    if (duplicate) return;

    const edge: EventEdge = { source, target, edgeType, label };
    if (conditionRelation) edge.conditionRelation = conditionRelation;
    edges.push(edge);
    edgeKeys?.add(key);
}

function addEventReferenceEdges(
    sourceId: string,
    nodes: readonly PdxNode[],
    catalog: PdxSemanticCatalog,
    edges: EventEdge[],
    includePath = false,
): void {
    const byName = new Map<string, EventReferenceRule[]>();
    for (const rule of eventReferenceRules(catalog)) {
        const values = byName.get(rule.name) ?? [];
        values.push(rule);
        byName.set(rule.name, values);
    }
    const walk = (items: readonly PdxNode[], path: readonly string[]) => {
        for (const node of items) {
            const nodePath = node.key === '$value' ? path : [...path, node.key];
            for (const rule of byName.get(node.key.toLowerCase()) ?? []) {
                const targetId = valueForReference(node, rule.reference);
                if (targetId && targetId !== sourceId) {
                    const label = includePath ? [...path, rule.name].join('.') : rule.name;
                    if (rule.category === 'trigger') {
                        addEdgeDedup(edges, targetId, sourceId, 'trigger', label);
                    } else {
                        addEdgeDedup(edges, sourceId, targetId, 'effect', label);
                    }
                }
            }
            if (node.children) walk(node.children, nodePath);
        }
    };
    walk(nodes, []);
}

interface DefinitionEventOccurrence {
    targetId: string;
    argumentPath: string;
    line: number;
}

function nodesAtArgumentPath(nodes: readonly PdxNode[], argumentPath: string): PdxNode[] {
    const segments = argumentPath.split('.').map(segment => segment.trim().toLowerCase()).filter(Boolean);
    let current = [...nodes];
    for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]!;
        const matched = current.filter(node => segment === '*'
            ? node.key !== '$value'
            : node.key.toLowerCase() === segment);
        current = index === segments.length - 1
            ? matched
            : matched.flatMap(node => node.children ?? []);
        if (current.length === 0) break;
    }
    return current;
}

function collectDefinitionEventOccurrences(
    nodes: readonly PdxNode[],
    definition: PdxSemanticCatalog['definitionTypes'][number] | undefined,
): DefinitionEventOccurrence[] {
    if (!definition) return [];
    const result: DefinitionEventOccurrence[] = [];
    for (const reference of definition.valueReferences ?? []) {
        if (normalizeReferenceType(reference.typeName) !== 'event') continue;
        for (const node of nodesAtArgumentPath(nodes, reference.argumentPath)) {
            const targetId = scalar(node);
            if (!targetId) continue;
            const occurrence = { targetId, argumentPath: reference.argumentPath, line: node.line };
            if (!result.some(existing => existing.targetId === occurrence.targetId
                && existing.argumentPath === occurrence.argumentPath
                && existing.line === occurrence.line)) result.push(occurrence);
        }
    }
    return result.sort((left, right) => left.line - right.line || left.argumentPath.localeCompare(right.argumentPath));
}

function isOrderedDefinitionPath(nodes: readonly PdxNode[], argumentPath: string): boolean {
    const segments = argumentPath.split('.').map(segment => segment.trim().toLowerCase()).filter(Boolean);
    if (segments.includes('*')) return false;
    if (segments[segments.length - 1] === '$value') return true;
    let current = [...nodes];
    for (const segment of segments.slice(0, -1)) {
        const matched = current.filter(node => node.key.toLowerCase() === segment);
        if (matched.length > 1) return true;
        current = matched.flatMap(node => node.children ?? []);
        if (current.length === 0) return false;
    }
    return false;
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
            definitionIdentity: { typeName: definition.name, value: id },
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

    for (const root of parsePdx(content).filter(node => node.children)) {
        const definition = matchPdxDefinitionType(catalog.definitionTypes, filePath, root.key);
        const sourceType = definition?.name ?? 'other';
        const name = definition?.nameField
            ? scalar(root.children?.find(child => child.key.toLowerCase() === definition.nameField)) ?? root.key
            : root.key;
        const id = `[${sourceType}] ${name}`;
        const semanticReferences = collectSemanticReferences(root.children ?? [], catalog);
        externalSources.push({
            id,
            name,
            sourceType,
            file: filePath,
            line: root.line,
            semanticReferences,
            definitionIdentity: { typeName: sourceType, value: name },
        });
        addEventReferenceEdges(id, root.children ?? [], catalog, edges, true);

        const definitionOccurrences = collectDefinitionEventOccurrences(root.children ?? [], definition);
        for (const occurrence of definitionOccurrences) {
            addEdgeDedup(edges, id, occurrence.targetId, 'definition', occurrence.argumentPath);
        }
        const orderedGroups = new Map<string, DefinitionEventOccurrence[]>();
        for (const occurrence of definitionOccurrences) {
            // Only plain value lists and repeated structural containers prove order.
            // Wildcard-key CWT fields represent keyed/weighted alternatives.
            if (!isOrderedDefinitionPath(root.children ?? [], occurrence.argumentPath)) continue;
            const group = orderedGroups.get(occurrence.argumentPath) ?? [];
            group.push(occurrence);
            orderedGroups.set(occurrence.argumentPath, group);
        }
        for (const [argumentPath, occurrences] of orderedGroups) {
            for (let index = 1; index < occurrences.length; index++) {
                const previous = occurrences[index - 1]!;
                const current = occurrences[index]!;
                if (previous.targetId === current.targetId) continue;
                addEdgeDedup(edges, previous.targetId, current.targetId, 'sequence', `${sourceType}.${argumentPath}`);
            }
        }
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

/** Connect typed value writers only to MTTH events whose root trigger requires them. */
export function buildMtthConditionEdges(graph: EventGraph): EventEdge[] {
    const writers = new Map<string, string[]>();
    for (const node of graph.nodes) {
        for (const reference of node.semanticReferences) {
            if (reference.access !== 'value_set') continue;
            const key = `${reference.typeName.toLowerCase()}:${reference.value.toLowerCase()}`;
            const ids = writers.get(key) ?? [];
            if (!ids.includes(node.id)) ids.push(node.id);
            writers.set(key, ids);
        }
    }

    const edges: EventEdge[] = [];
    const edgeKeys = new Set<string>();
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
                    edgeKeys,
                );
            }
        }
    }
    return edges;
}

function referenceMatchesDefinition(referenceType: string, definitionType: string): boolean {
    const reference = referenceType.trim().toLowerCase();
    const definition = definitionType.trim().toLowerCase();
    return reference === definition || reference.startsWith(`${definition}.`);
}

/** Connect CWT-declared typed references to definition nodes present in the graph. */
export function buildDefinitionReferenceEdges(graph: EventGraph): EventEdge[] {
    const definitions = graph.nodes
        .filter((node): node is EventNode & { definitionIdentity: NonNullable<EventNode['definitionIdentity']> } => Boolean(node.definitionIdentity))
        .map(node => ({
            node,
            typeName: node.definitionIdentity.typeName.toLowerCase(),
            value: node.definitionIdentity.value.toLowerCase(),
        }));
    const definitionsByValue = new Map<string, typeof definitions>();
    for (const definition of definitions) {
        const matches = definitionsByValue.get(definition.value) ?? [];
        matches.push(definition);
        definitionsByValue.set(definition.value, matches);
    }
    const existingPairs = new Set(graph.edges.map(edge => `${edge.source}\u0000${edge.target}`));
    const edges: EventEdge[] = [];
    const edgeKeys = new Set<string>();
    for (const sourceNode of graph.nodes) {
        for (const reference of sourceNode.semanticReferences) {
            const targets = (definitionsByValue.get(reference.value.toLowerCase()) ?? [])
                .filter(target => referenceMatchesDefinition(reference.typeName, target.typeName));
            for (const target of targets) {
                if (target.node.id === sourceNode.id) continue;
                const label = `${reference.ruleName} = ${reference.value}`;
                if (reference.category === 'trigger') {
                    if (existingPairs.has(`${target.node.id}\u0000${sourceNode.id}`)) continue;
                    addEdgeDedup(edges, target.node.id, sourceNode.id, 'definition_trigger', label, undefined, edgeKeys);
                } else {
                    // Explicit event/definition-member edges already carry this direction.
                    if (existingPairs.has(`${sourceNode.id}\u0000${target.node.id}`)) continue;
                    addEdgeDedup(edges, sourceNode.id, target.node.id, 'definition_effect', label, undefined, edgeKeys);
                }
            }
        }
    }
    return edges;
}

export function extractConnectedSubgraph(
    fullGraph: EventGraph,
    seedIds: Set<string>,
    maxDepth = 10,
    maxNodes = Number.POSITIVE_INFINITY,
): EventGraph {
    const knownNodeIds = new Set(fullGraph.nodes.map(node => node.id));
    const adjacentIds = new Map<string, Set<string>>();
    const connect = (source: string, target: string) => {
        let adjacent = adjacentIds.get(source);
        if (!adjacent) {
            adjacent = new Set<string>();
            adjacentIds.set(source, adjacent);
        }
        adjacent.add(target);
    };
    for (const edge of fullGraph.edges) {
        connect(edge.source, edge.target);
        connect(edge.target, edge.source);
    }

    const nodeLimit = Number.isFinite(maxNodes) ? Math.max(1, Math.floor(maxNodes)) : Number.POSITIVE_INFINITY;
    const visited = new Set<string>();
    let frontier = new Set([...seedIds].sort());
    for (let depth = 0; depth <= maxDepth && frontier.size > 0 && visited.size < nodeLimit; depth++) {
        const next = new Set<string>();
        for (const id of [...frontier].sort()) {
            if (visited.has(id)) continue;
            if (visited.size >= nodeLimit) break;
            visited.add(id);
            for (const adjacentId of [...(adjacentIds.get(id) ?? [])].sort()) {
                if (!visited.has(adjacentId)) next.add(adjacentId);
            }
        }
        frontier = next;
    }

    const isVisibleNode = (id: string) => knownNodeIds.has(id) && visited.has(id);
    return {
        nodes: fullGraph.nodes.filter(node => visited.has(node.id)),
        edges: fullGraph.edges.filter(edge => {
            const sourceVisible = isVisibleNode(edge.source);
            const targetVisible = isVisibleNode(edge.target);
            if (sourceVisible && targetVisible) return true;

            // Keep unresolved references attached to the visible subgraph, but
            // do not leak known nodes from beyond the requested depth back in
            // as phantom nodes in the Webview.
            return (sourceVisible && !knownNodeIds.has(edge.target))
                || (targetVisible && !knownNodeIds.has(edge.source));
        }),
    };
}
