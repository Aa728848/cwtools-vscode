import * as fs from 'fs';
import * as path from 'path';
import { TokenType, tokenize, type Token } from '../../pdxTokenizer';
import type { CwtRuleValueReference, PdxSemanticCatalog } from '../types';
import type {
    AcceptanceCheck,
    TaskEntityContract,
    TaskEntityKind,
    TaskEntityOperation,
    TaskGraph,
} from './types';

interface PdxNode {
    key: string;
    value?: string;
    children?: PdxNode[];
    line: number;
}

export interface SemanticEvidence {
    kind: TaskEntityKind;
    id: string;
    operation: TaskEntityOperation;
    file: string;
    line: number;
    container?: string;
}

export interface SemanticIssue {
    code: string;
    message: string;
    file?: string;
    line?: number;
}

export interface SemanticVerificationResult {
    passed: boolean;
    issues: SemanticIssue[];
    evidence: SemanticEvidence[];
    acceptanceFailures: string[];
    filesChecked: string[];
    report: string;
}

export interface SemanticToolExecutor {
    execute(toolName: string, args: Record<string, unknown>): Promise<unknown>;
    getPdxSemanticCatalog?(targetFiles: readonly string[], ruleNames?: readonly string[]): Promise<PdxSemanticCatalog>;
}
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function parseNodes(tokens: Token[], start = 0, stopAtBrace = false): { nodes: PdxNode[]; next: number } {
    const nodes: PdxNode[] = [];
    let i = start;
    while (i < tokens.length) {
        const token = tokens[i]!;
        if (token.type === TokenType.EOF || (stopAtBrace && token.type === TokenType.RBrace)) {
            return { nodes, next: i + (token.type === TokenType.RBrace ? 1 : 0) };
        }
        if (token.type !== TokenType.Identifier && token.type !== TokenType.String) {
            i++;
            continue;
        }
        const equals = tokens[i + 1];
        const rhs = tokens[i + 2];
        if (!equals || equals.type !== TokenType.Equals || !rhs) {
            i++;
            continue;
        }
        if (rhs.type === TokenType.LBrace) {
            const parsed = parseNodes(tokens, i + 3, true);
            nodes.push({ key: token.value, children: parsed.nodes, line: token.line });
            i = parsed.next;
            continue;
        }
        if (rhs.type === TokenType.Identifier || rhs.type === TokenType.String || rhs.type === TokenType.Number) {
            nodes.push({ key: token.value, value: rhs.value, line: token.line });
            i += 3;
            continue;
        }
        i++;
    }
    return { nodes, next: i };
}

function childValue(node: PdxNode, key: string): string | undefined {
    return node.children?.find(child => child.key === key && child.value !== undefined)?.value;
}

function contractKey(kind: TaskEntityKind, id: string, operation: TaskEntityOperation): string {
    return `${kind}:${id.trim().toLowerCase()}:${operation}`;
}

function entityKey(kind: TaskEntityKind, id: string): string {
    return `${kind}:${id.trim().toLowerCase()}`;
}

function uniqueContracts(graph: TaskGraph): TaskEntityContract[] {
    const contracts = [
        ...(graph.metadata.featureManifest?.entities ?? []),
        ...[...graph.nodes.values()].flatMap(node => [...(node.produces ?? []), ...(node.consumes ?? [])]),
    ];
    const seen = new Set<string>();
    return contracts.filter(contract => {
        const key = contractKey(contract.kind, contract.id, contract.operation);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function normalizeOperation(operation: TaskEntityOperation): TaskEntityOperation {
    return operation === 'localise' ? 'define' : operation;
}

function positiveDefinitionResult(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const value = result as Record<string, unknown>;
    if (value.ok === false || value.found === false || value.error) return false;
    if (value.ok === true || value.found === true) return true;
    return ['file', 'uri', 'location', 'locations', 'range', 'definition'].some(key => value[key] !== undefined);
}

function formatEvidence(evidence: SemanticEvidence): string {
    return `${evidence.kind}:${evidence.id} ${evidence.operation} at ${evidence.file}:${evidence.line}${evidence.container ? ` in ${evidence.container}` : ''}`;
}

function normalizeReferenceType(typeName: string): string {
    return typeName.trim().toLowerCase();
}

function referenceDefinitionType(typeName: string): string {
    const normalized = normalizeReferenceType(typeName);
    const separator = normalized.indexOf('.');
    return separator > 0 ? normalized.slice(0, separator) : normalized;
}

function definitionTypeForFile(
    file: string,
    catalog: PdxSemanticCatalog | undefined,
): PdxSemanticCatalog['definitionTypes'][number] | undefined {
    const normalized = file.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    return catalog?.definitionTypes
        .filter(type => type.paths.some(typePath => normalized.startsWith(`${typePath}/`) || normalized.includes(`/${typePath}/`)))
        .sort((a, b) => Math.max(0, ...b.paths.map(value => value.length)) - Math.max(0, ...a.paths.map(value => value.length)))[0];
}

function definitionIdForNode(
    node: PdxNode,
    definitionType: PdxSemanticCatalog['definitionTypes'][number] | undefined,
): string | undefined {
    if (!definitionType || !node.children) return undefined;
    const key = node.key.toLowerCase();
    if (definitionType.typeKeyFilters.length > 0 && !definitionType.typeKeyFilters.includes(key)) return undefined;
    return definitionType.nameField ? childValue(node, definitionType.nameField) : node.key;
}

function valueForReference(node: PdxNode, reference: CwtRuleValueReference): string | undefined {
    if (reference.argumentPath === '$value') return node.value;
    const segments = reference.argumentPath.split('.').filter(Boolean);
    let current: PdxNode | undefined = node;
    for (const segment of segments) {
        current = current.children?.find(child => child.key.toLowerCase() === segment.toLowerCase());
        if (!current) return undefined;
    }
    return current.value;
}

export class SemanticVerifier {
    async verify(
        workspaceRoot: string,
        writtenFiles: string[],
        graph: TaskGraph,
        toolExecutor?: SemanticToolExecutor,
    ): Promise<SemanticVerificationResult> {
        const evidence: SemanticEvidence[] = [];
        const issues: SemanticIssue[] = [];
        const filesChecked: string[] = [];
        const roots: Array<{ file: string; nodes: PdxNode[] }> = [];
        let catalog: PdxSemanticCatalog | undefined;
        let catalogWarning: string | undefined;

        for (const input of [...new Set(writtenFiles)].slice(0, MAX_FILES)) {
            const file = path.isAbsolute(input) ? path.resolve(input) : path.resolve(workspaceRoot, input);
            try {
                const stat = await fs.promises.stat(file);
                if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
                const content = await fs.promises.readFile(file, 'utf8');
                filesChecked.push(file);
                if (file.toLowerCase().endsWith('.yml')) {
                    const lines = content.split(/\r?\n/);
                    for (let i = 0; i < lines.length; i++) {
                        const match = lines[i]!.match(/^\s*([^\s:#][^:]*):\d*\s+/);
                        if (!match?.[1] || /^l_[a-z_]+$/i.test(match[1])) continue;
                        evidence.push({ kind: 'localisation', id: match[1].trim(), operation: 'define', file, line: i + 1 });
                    }
                    continue;
                }
                roots.push({ file, nodes: parseNodes(tokenize(content)).nodes });
            } catch {
                // Written-file tracking can include deleted or transient files. Other gates report those writes.
            }
        }

        const ruleNames = new Set<string>();
        const collectRuleNames = (nodes: readonly PdxNode[]) => {
            for (const node of nodes) {
                ruleNames.add(node.key.toLowerCase());
                if (node.children) collectRuleNames(node.children);
            }
        };
        roots.forEach(root => collectRuleNames(root.nodes));
        if (toolExecutor?.getPdxSemanticCatalog) {
            try {
                catalog = await toolExecutor.getPdxSemanticCatalog(writtenFiles, [...ruleNames].sort());
                if (catalog.source !== 'lsp') {
                    catalogWarning = `LSP semantic catalog is unavailable; using ${catalog.source}.`;
                } else if (catalog.status !== 'ready') {
                    catalogWarning = `CWT semantic catalog is ${catalog.status}; unavailable rule families are advisory.`;
                }
            } catch (error) {
                catalogWarning = `CWT semantic catalog could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
            }
        } else {
            catalogWarning = 'CWT semantic catalog is unavailable; catalog-dependent checks were skipped.';
        }

        const definitionKindsById = new Map<string, string>();
        const rulesByName = new Map<string, PdxSemanticCatalog['rules']>();
        for (const rule of catalog?.rules ?? []) {
            const rules = rulesByName.get(rule.name) ?? [];
            rules.push(rule);
            rulesByName.set(rule.name, rules);
        }
        for (const root of roots) {
            const definitionType = definitionTypeForFile(root.file, catalog);
            for (const node of root.nodes) {
                const id = definitionIdForNode(node, definitionType);
                if (!id || !definitionType) continue;
                definitionKindsById.set(id.toLowerCase(), definitionType.name);
                evidence.push({ kind: definitionType.name, id, operation: 'define', file: root.file, line: node.line, container: id });
            }
        }

        const primitiveByContainer = new Map<string, Set<string>>();
        const definitionCallsByContainer = new Map<string, Set<string>>();
        const walk = (nodes: PdxNode[], file: string, inheritedContainer?: string, topLevel = false) => {
            const fileDefinitionType = definitionTypeForFile(file, catalog);
            for (const node of nodes) {
                let container = inheritedContainer;
                const key = node.key.toLowerCase();
                const topLevelDefinitionId = topLevel ? definitionIdForNode(node, fileDefinitionType) : undefined;
                if (topLevelDefinitionId) container = topLevelDefinitionId;

                const matchingRules = rulesByName.get(key) ?? [];
                for (const rule of matchingRules) {
                    for (const reference of rule.valueReferences) {
                        const value = valueForReference(node, reference);
                        if (!value) continue;
                        const exactKind = normalizeReferenceType(reference.typeName);
                        const definitionKind = referenceDefinitionType(reference.typeName);
                        if (topLevelDefinitionId
                            && fileDefinitionType?.name === definitionKind
                            && value.toLowerCase() === topLevelDefinitionId.toLowerCase()) continue;
                        const operation: TaskEntityOperation = reference.access === 'value_set' ? 'set' : 'reference';
                        evidence.push({ kind: exactKind, id: value, operation, file, line: node.line, container });
                        if (definitionKind !== exactKind) {
                            evidence.push({ kind: definitionKind, id: value, operation, file, line: node.line, container });
                        }
                    }
                }

                if (container && matchingRules.some(rule => rule.category === 'effect')) {
                    const primitives = primitiveByContainer.get(container.toLowerCase()) ?? new Set<string>();
                    primitives.add(key);
                    primitiveByContainer.set(container.toLowerCase(), primitives);
                }
                const calledDefinitionKind = definitionKindsById.get(key);
                if (container && calledDefinitionKind && key !== container.toLowerCase()) {
                    evidence.push({ kind: calledDefinitionKind, id: node.key, operation: 'call', file, line: node.line, container });
                    const calls = definitionCallsByContainer.get(container.toLowerCase()) ?? new Set<string>();
                    calls.add(node.key.toLowerCase());
                    definitionCallsByContainer.set(container.toLowerCase(), calls);
                }

                if (node.children) walk(node.children, file, container, false);
            }
        };
        for (const root of roots) walk(root.nodes, root.file, undefined, true);

        const evidenceKeys = new Set(evidence.map(item => contractKey(item.kind, item.id, normalizeOperation(item.operation))));
        const contracts = uniqueContracts(graph);
        const skippedCatalogContracts: string[] = [];
        const hasDefinitionType = (name: string) => catalog?.definitionTypes.some(type => type.name === name) === true;
        const catalogCanVerify = (kind: TaskEntityKind): boolean => {
            if (kind === 'localisation') return true;
            if (hasDefinitionType(kind)) return true;
            return catalog?.rules.some(rule => rule.valueReferences.some(reference => {
                const exact = normalizeReferenceType(reference.typeName);
                return exact === kind || referenceDefinitionType(exact) === kind;
            })) === true;
        };
        for (const contract of contracts) {
            if (contract.required === false) continue;
            const operation = normalizeOperation(contract.operation);
            let found = evidenceKeys.has(contractKey(contract.kind, contract.id, operation));
            if (!found && operation === 'reference') {
                found = evidence.some(item => entityKey(item.kind, item.id) === entityKey(contract.kind, contract.id)
                    && ['call', 'read', 'reference'].includes(item.operation));
            }
            if (!found && operation === 'define' && toolExecutor && contract.kind !== 'localisation') {
                try {
                    found = positiveDefinitionResult(await toolExecutor.execute('go_to_definition', { symbolName: contract.id }));
                } catch {
                    found = false;
                }
            }
            if (!found) {
                if (!catalogCanVerify(contract.kind)) {
                    skippedCatalogContracts.push(`${contract.kind}:${contract.id} ${contract.operation}`);
                    continue;
                }
                issues.push({
                    code: 'missing_contract_evidence',
                    message: `Required contract has no evidence: ${contract.kind}:${contract.id} ${contract.operation}.`,
                });
            }
        }

        for (const edge of graph.metadata.featureManifest?.requiredEdges ?? []) {
            if (edge.required === false) continue;
            const found = evidence.some(item =>
                item.id.toLowerCase() === edge.to.toLowerCase()
                && item.operation === edge.relation
                && item.container?.toLowerCase() === edge.from.toLowerCase());
            if (!found) {
                issues.push({
                    code: 'missing_required_edge',
                    message: `Required feature edge is missing: ${edge.from} --${edge.relation}--> ${edge.to}.`,
                });
            }
        }

        for (const [container, calls] of definitionCallsByContainer) {
            const direct = primitiveByContainer.get(container) ?? new Set<string>();
            for (const effect of calls) {
                const insideEffect = primitiveByContainer.get(effect) ?? new Set<string>();
                const overlap = [...direct].filter(primitive => insideEffect.has(primitive));
                if (overlap.length > 0) {
                    issues.push({
                        code: 'duplicate_responsibility',
                        message: `Entity '${container}' calls definition '${effect}' but also implements the same CWT operation(s) inline: ${overlap.join(', ')}.`,
                    });
                }
            }
        }

        const expectedChanges = graph.metadata.featureManifest?.expectsFileChanges === true
            || [...graph.nodes.values()].some(node => ['build', 'loc_writer', 'gui_expert'].includes(node.agentType)
                && ((node.plannedFiles?.length ?? 0) > 0 || (node.produces?.length ?? 0) > 0));
        if (expectedChanges && filesChecked.length === 0) {
            issues.push({ code: 'expected_changes_missing', message: 'The feature contract expected project changes, but no written project file could be verified.' });
        }

        const acceptanceChecks = [
            ...(graph.metadata.featureManifest?.acceptanceCriteria ?? []),
            ...[...graph.nodes.values()].flatMap(node => node.acceptanceChecks ?? []),
        ];
        const acceptanceFailures = this.evaluateAcceptanceChecks(acceptanceChecks, evidence);
        for (const failure of acceptanceFailures) {
            issues.push({ code: 'acceptance_failed', message: failure });
        }

        const issueLines = issues.length > 0
            ? issues.map(issue => `- [${issue.code}] ${issue.message}${issue.file ? ` (${issue.file}:${issue.line ?? 1})` : ''}`)
            : ['- No deterministic semantic issues found.'];
        const report = [
            '## Deterministic Semantic Verification',
            `Files checked: ${filesChecked.length}`,
            `Evidence records: ${evidence.length}`,
            `Issues: ${issues.length}`,
            ...(catalogWarning ? [`Catalog: ${catalogWarning}`] : []),
            ...(skippedCatalogContracts.length > 0
                ? [`Catalog-dependent contracts skipped: ${skippedCatalogContracts.slice(0, 20).join(', ')}`]
                : []),
            '',
            ...issueLines,
            '',
            '### Contract Evidence',
            ...evidence.slice(0, 100).map(item => `- ${formatEvidence(item)}`),
        ].join('\n');

        return {
            passed: issues.length === 0,
            issues,
            evidence,
            acceptanceFailures,
            filesChecked,
            report,
        };
    }

    private evaluateAcceptanceChecks(
        checks: AcceptanceCheck[],
        evidence: SemanticEvidence[],
    ): string[] {
        const failures: string[] = [];
        for (const check of checks) {
            if (check.required === false || check.type === 'custom' || check.type === 'scope') continue;
            const subject = check.subject?.trim();
            let passed = true;
            if (check.type === 'entity_exists' && subject) {
                passed = evidence.some(item => item.id.toLowerCase() === subject.toLowerCase() && item.operation === 'define');
            } else if (check.type === 'entity_referenced' && subject) {
                passed = evidence.some(item => item.id.toLowerCase() === subject.toLowerCase() && ['call', 'read', 'reference'].includes(item.operation));
            } else if (check.type === 'typed_lifecycle' && subject && check.entityKind) {
                const kind = check.entityKind.toLowerCase();
                passed = evidence.some(item => item.kind.toLowerCase() === kind
                    && item.id.toLowerCase() === subject.toLowerCase()
                    && ['set', 'save', 'define'].includes(item.operation))
                    && evidence.some(item => item.kind.toLowerCase() === kind
                        && item.id.toLowerCase() === subject.toLowerCase()
                        && ['read', 'call', 'reference', 'clear'].includes(item.operation));
            } else if (check.type === 'localisation_owner' && subject) {
                const normalized = subject.toLowerCase();
                const ownerKind = check.entityKind?.toLowerCase();
                passed = evidence.some(item => item.operation === 'define'
                    && item.id.toLowerCase() === normalized
                    && (!ownerKind || item.kind.toLowerCase() === ownerKind))
                    && evidence.some(item => item.kind === 'localisation'
                        && (item.id.toLowerCase() === normalized || item.id.toLowerCase().startsWith(`${normalized}.`)));
            }
            if (!passed) failures.push(`${check.id}: ${check.description}`);
        }
        return failures;
    }
}
