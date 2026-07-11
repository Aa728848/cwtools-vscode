import * as fs from 'fs';
import * as path from 'path';
import { TokenType, tokenize, type Token } from '../../pdxTokenizer';
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
}

const EVENT_BLOCK_KEYS = new Set([
    'event', 'country_event', 'planet_event', 'ship_event', 'fleet_event',
    'pop_event', 'system_event', 'observer_event', 'first_contact_event',
]);
const FLAG_SET_KEYS = new Set(['set_global_flag', 'set_country_flag', 'set_planet_flag', 'set_fleet_flag', 'set_ship_flag', 'set_star_flag']);
const FLAG_READ_KEYS = new Set(['has_global_flag', 'has_country_flag', 'has_planet_flag', 'has_fleet_flag', 'has_ship_flag', 'has_star_flag']);
const FLAG_CLEAR_KEYS = new Set(['remove_global_flag', 'remove_country_flag', 'remove_planet_flag', 'remove_fleet_flag', 'remove_ship_flag', 'remove_star_flag']);
const TARGET_SAVE_KEYS = new Set(['save_event_target_as', 'save_global_event_target_as']);
const RESPONSIBILITY_PRIMITIVES = new Set([
    'create_fleet', 'create_ship', 'create_country', 'create_pop', 'create_army',
    'add_modifier', 'set_owner', 'set_location', 'destroy_fleet', 'kill_pop',
]);
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
        const localisationKeys: Array<{ id: string; file: string; line: number }> = [];

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
                        localisationKeys.push({ id: match[1].trim(), file, line: i + 1 });
                        evidence.push({ kind: 'localisation', id: match[1].trim(), operation: 'define', file, line: i + 1 });
                    }
                    continue;
                }
                roots.push({ file, nodes: parseNodes(tokenize(content)).nodes });
            } catch {
                // Written-file tracking can include deleted or transient files. Other gates report those writes.
            }
        }

        const effectDefinitions = new Set<string>();
        const triggerDefinitions = new Set<string>();
        const eventDefinitions = new Set<string>();
        for (const root of roots) {
            const normalized = root.file.replace(/\\/g, '/').toLowerCase();
            for (const node of root.nodes) {
                if (EVENT_BLOCK_KEYS.has(node.key)) {
                    const id = childValue(node, 'id');
                    if (id) {
                        eventDefinitions.add(id.toLowerCase());
                        evidence.push({ kind: 'event', id, operation: 'define', file: root.file, line: node.line, container: id });
                    }
                }
                if (normalized.includes('/common/scripted_effects/') && node.children) {
                    effectDefinitions.add(node.key.toLowerCase());
                    evidence.push({ kind: 'scripted_effect', id: node.key, operation: 'define', file: root.file, line: node.line, container: node.key });
                }
                if (normalized.includes('/common/scripted_triggers/') && node.children) {
                    triggerDefinitions.add(node.key.toLowerCase());
                    evidence.push({ kind: 'scripted_trigger', id: node.key, operation: 'define', file: root.file, line: node.line, container: node.key });
                }
            }
        }

        const primitiveByContainer = new Map<string, Set<string>>();
        const effectCallsByContainer = new Map<string, Set<string>>();
        const walk = (nodes: PdxNode[], file: string, inheritedContainer?: string, topLevel = false) => {
            for (const node of nodes) {
                let container = inheritedContainer;
                if (EVENT_BLOCK_KEYS.has(node.key)) {
                    const id = childValue(node, 'id');
                    if (id) {
                        if (!topLevel) evidence.push({ kind: 'event', id, operation: 'call', file, line: node.line, container: inheritedContainer });
                        container = id;
                    }
                } else if (topLevel && (effectDefinitions.has(node.key.toLowerCase()) || triggerDefinitions.has(node.key.toLowerCase()))) {
                    container = node.key;
                }

                if (node.value !== undefined) {
                    const key = node.key.toLowerCase();
                    const value = node.value;
                    if (FLAG_SET_KEYS.has(key)) evidence.push({ kind: 'flag', id: value, operation: 'set', file, line: node.line, container });
                    if (FLAG_READ_KEYS.has(key)) evidence.push({ kind: 'flag', id: value, operation: 'read', file, line: node.line, container });
                    if (FLAG_CLEAR_KEYS.has(key)) evidence.push({ kind: 'flag', id: value, operation: 'clear', file, line: node.line, container });
                    if (TARGET_SAVE_KEYS.has(key)) evidence.push({ kind: 'event_target', id: value, operation: 'save', file, line: node.line, container });
                    const targetMatches = `${node.key} ${value}`.matchAll(/event_target:([A-Za-z0-9_.-]+)/g);
                    for (const match of targetMatches) {
                        if (match[1]) evidence.push({ kind: 'event_target', id: match[1], operation: 'read', file, line: node.line, container });
                    }
                }

                if (container && RESPONSIBILITY_PRIMITIVES.has(node.key.toLowerCase())) {
                    const primitives = primitiveByContainer.get(container.toLowerCase()) ?? new Set<string>();
                    primitives.add(node.key.toLowerCase());
                    primitiveByContainer.set(container.toLowerCase(), primitives);
                }
                if (container && effectDefinitions.has(node.key.toLowerCase()) && node.key.toLowerCase() !== container.toLowerCase()) {
                    evidence.push({ kind: 'scripted_effect', id: node.key, operation: 'call', file, line: node.line, container });
                    const calls = effectCallsByContainer.get(container.toLowerCase()) ?? new Set<string>();
                    calls.add(node.key.toLowerCase());
                    effectCallsByContainer.set(container.toLowerCase(), calls);
                }
                if (container && triggerDefinitions.has(node.key.toLowerCase())) {
                    evidence.push({ kind: 'scripted_trigger', id: node.key, operation: 'call', file, line: node.line, container });
                }

                if (node.children) {
                    const targetAssignments = node.children.filter(child => child.key.toLowerCase() === 'target' && child.value !== undefined);
                    if (targetAssignments.length > 1) {
                        issues.push({
                            code: 'duplicate_target_assignment',
                            message: `Block '${node.key}' assigns target ${targetAssignments.length} times; keep one unambiguous target.`,
                            file,
                            line: targetAssignments[1]!.line,
                        });
                    }
                    walk(node.children, file, container, false);
                }
            }
        };
        for (const root of roots) walk(root.nodes, root.file, undefined, true);

        const evidenceKeys = new Set(evidence.map(item => contractKey(item.kind, item.id, normalizeOperation(item.operation))));
        const contracts = uniqueContracts(graph);
        for (const contract of contracts) {
            if (contract.required === false) continue;
            const operation = normalizeOperation(contract.operation);
            let found = evidenceKeys.has(contractKey(contract.kind, contract.id, operation));
            if (!found && operation === 'reference') {
                found = evidence.some(item => entityKey(item.kind, item.id) === entityKey(contract.kind, contract.id)
                    && ['call', 'read', 'reference'].includes(item.operation));
            }
            if (!found && operation === 'define' && toolExecutor && contract.kind !== 'flag' && contract.kind !== 'event_target' && contract.kind !== 'localisation') {
                try {
                    found = positiveDefinitionResult(await toolExecutor.execute('query_definition_by_name', { symbolName: contract.id }));
                } catch {
                    found = false;
                }
            }
            if (!found) {
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

        const flagSets = evidence.filter(item => item.kind === 'flag' && item.operation === 'set');
        for (const set of flagSets) {
            const read = evidence.some(item => item.kind === 'flag' && item.id.toLowerCase() === set.id.toLowerCase() && item.operation === 'read');
            if (!read) {
                issues.push({ code: 'unused_flag', message: `Flag '${set.id}' is set but never read in the integrated change.`, file: set.file, line: set.line });
            }
        }

        const savedTargets = evidence.filter(item => item.kind === 'event_target' && item.operation === 'save');
        for (const saved of savedTargets) {
            let read = evidence.some(item => item.kind === 'event_target' && item.id.toLowerCase() === saved.id.toLowerCase() && item.operation === 'read');
            if (!read && toolExecutor) {
                try {
                    const result = await toolExecutor.execute('query_references', { identifier: `event_target:${saved.id}` }) as any;
                    read = Array.isArray(result?.references) && result.references.length > 0;
                } catch {
                    read = false;
                }
            }
            if (!read) {
                issues.push({ code: 'unused_event_target', message: `Event target '${saved.id}' is saved but never consumed.`, file: saved.file, line: saved.line });
            }
        }

        for (const [container, calls] of effectCallsByContainer) {
            const direct = primitiveByContainer.get(container) ?? new Set<string>();
            for (const effect of calls) {
                const insideEffect = primitiveByContainer.get(effect) ?? new Set<string>();
                const overlap = [...direct].filter(primitive => insideEffect.has(primitive));
                if (overlap.length > 0) {
                    issues.push({
                        code: 'duplicate_responsibility',
                        message: `Entity '${container}' calls scripted effect '${effect}' but also implements the same operation(s) inline: ${overlap.join(', ')}.`,
                    });
                }
            }
        }

        const knownEvents = new Set(eventDefinitions);
        for (const key of localisationKeys) {
            const match = key.id.match(/^(.+\.\d+)(?:\.|$)/);
            if (!match?.[1]) continue;
            const owner = match[1];
            let exists = knownEvents.has(owner.toLowerCase());
            if (!exists && toolExecutor) {
                try {
                    exists = positiveDefinitionResult(await toolExecutor.execute('query_definition_by_name', { symbolName: owner }));
                } catch {
                    exists = false;
                }
            }
            if (!exists) {
                issues.push({
                    code: 'orphan_localisation',
                    message: `Localisation key '${key.id}' appears to belong to missing event '${owner}'.`,
                    file: key.file,
                    line: key.line,
                });
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
        const acceptanceFailures = this.evaluateAcceptanceChecks(acceptanceChecks, evidence, issues);
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
        issues: SemanticIssue[],
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
            } else if (check.type === 'flag_lifecycle' && subject) {
                passed = evidence.some(item => item.kind === 'flag' && item.id.toLowerCase() === subject.toLowerCase() && item.operation === 'set')
                    && evidence.some(item => item.kind === 'flag' && item.id.toLowerCase() === subject.toLowerCase() && item.operation === 'read');
            } else if (check.type === 'target_lifecycle' && subject) {
                passed = evidence.some(item => item.kind === 'event_target' && item.id.toLowerCase() === subject.toLowerCase() && item.operation === 'save')
                    && evidence.some(item => item.kind === 'event_target' && item.id.toLowerCase() === subject.toLowerCase() && item.operation === 'read');
            } else if (check.type === 'localisation_owner' && subject) {
                passed = !issues.some(issue => issue.code === 'orphan_localisation' && issue.message.includes(subject));
            }
            if (!passed) failures.push(`${check.id}: ${check.description}`);
        }
        return failures;
    }
}
