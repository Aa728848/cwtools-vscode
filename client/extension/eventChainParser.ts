/**
 * Event Chain Parser — Extracts event definitions and cross-references from
 * Paradox script files (.txt) for visualization as a directed graph.
 *
 * Parses:
 *   - Event definitions: `namespace = xxx`, `country_event = { id = xxx.N ... }`
 *   - Event references: `country_event = { id = xxx.N }` inside option/effect blocks
 *   - Direct triggers: `fire_on_action`, `mean_time_to_happen`, `is_triggered_only`
 *   - Common file triggers: on_actions, scripted_effects, decisions, scripted_triggers
 *
 * Output: A list of EventNode + EventEdge suitable for cytoscape rendering.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EventNode {
    /** Fully qualified event ID, e.g. "crisis.100" */
    id: string;
    /** Event type: country_event, planet_event, etc. */
    type: string;
    /** Title from title = xxx, if present */
    title?: string;
    /** Whether it's marked is_triggered_only */
    isTriggeredOnly: boolean;
    /** Source file path (relative) */
    file: string;
    /** Line number in source file (1-indexed) */
    line: number;
    /** End line number */
    endLine: number;
    /** Namespace this event belongs to */
    namespace: string;
    /** Whether this event has fire_on_action (entry point) */
    isFireOnAction: boolean;
    /** Whether the event is hidden (no popup) */
    isHidden: boolean;
}

export interface EventEdge {
    /** Source event ID */
    source: string;
    /** Target event ID */
    target: string;
    /** How the edge was created: option, immediate, after, mean_time_to_happen */
    edgeType: 'option' | 'immediate' | 'after' | 'effect' | 'on_action' | 'decision' | 'scripted' | 'unknown';
    /** Label for the edge (option name, etc.) */
    label?: string;
}

export interface EventGraph {
    nodes: EventNode[];
    edges: EventEdge[];
}

// ─── Event types in Paradox scripting ────────────────────────────────────────

const EVENT_TYPES = [
    'country_event', 'planet_event', 'fleet_event', 'ship_event',
    'pop_event', 'pop_faction_event', 'observer_event', 'event',
    'situation_event', 'first_contact_event', 'espionage_operation_event',
    'astral_rift_event',
] as const;

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

// Patterns that trigger another event
const EVENT_FIRE_PATTERNS = [
    'country_event', 'planet_event', 'fleet_event', 'ship_event',
    'pop_event', 'pop_faction_event', 'observer_event',
    'situation_event', 'first_contact_event', 'espionage_operation_event',
    'astral_rift_event',
];

// Additional patterns that reference an event by ID (non-standard triggers)
// e.g. set_next_astral_rift_event = { id = xxx.123 }
const EXTRA_FIRE_PATTERNS = [
    'set_next_astral_rift_event',
];

// ─── Event file parser ──────────────────────────────────────────────────────

/**
 * Parse a single Paradox script file and extract event definitions + references.
 * @param content - File text content
 * @param filePath - Relative file path (for display)
 */
export function parseEventFile(content: string, filePath: string): EventGraph {
    const lines = content.split(/\r?\n/);
    const nodes: EventNode[] = [];
    const edges: EventEdge[] = [];

    let currentNamespace = '';

    // Phase 1: Extract namespace
    for (const line of lines) {
        const nsMatch = line.match(/^\s*namespace\s*=\s*(\S+)/);
        if (nsMatch) {
            currentNamespace = nsMatch[1]!;
            break; // First namespace wins
        }
    }

    // Phase 2: Find event definitions (top-level blocks)
    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();

        // Match event definition: `country_event = {`
        const defMatch = trimmed.match(/^(\w+_event|event)\s*=\s*\{/);
        if (defMatch && EVENT_TYPE_SET.has(defMatch[1]!)) {
            const eventType = defMatch[1]!;
            const startLine = i + 1; // 1-indexed

            // Find the matching closing brace
            let depth = 0;
            let endLineIdx = i;
            for (let j = i; j < lines.length; j++) {
                for (const ch of lines[j]!) {
                    if (ch === '{') depth++;
                    if (ch === '}') depth--;
                }
                if (depth <= 0) {
                    endLineIdx = j;
                    break;
                }
            }

            // Extract event body
            const bodyLines = lines.slice(i, endLineIdx + 1);
            const body = bodyLines.join('\n');

            // Extract event ID
            const idMatch = body.match(/\bid\s*=\s*(\S+)/);
            if (idMatch) {
                const eventId = idMatch[1]!;

                // Extract title
                const titleMatch = body.match(/\btitle\s*=\s*"?([^"\n]+)"?/);
                const title = titleMatch ? titleMatch[1]!.trim() : undefined;

                // Check is_triggered_only
                const isTriggeredOnly = /\bis_triggered_only\s*=\s*yes\b/.test(body);

                // Check fire_on_action
                const isFireOnAction = /\bfire_on_action\b/.test(body);

                // Check is_hidden
                const isHidden = /\bis_hidden\s*=\s*yes\b/.test(body) || /\bhide_window\s*=\s*yes\b/.test(body);

                const ns = eventId.includes('.') ? eventId.split('.')[0]! : currentNamespace;

                nodes.push({
                    id: eventId,
                    type: eventType,
                    title,
                    isTriggeredOnly,
                    file: filePath,
                    line: startLine,
                    endLine: endLineIdx + 1,
                    namespace: ns,
                    isFireOnAction,
                    isHidden,
                });

                // Phase 3: Extract outgoing event references within this event body
                extractEdges(eventId, body, edges);
            }

            i = endLineIdx + 1;
            continue;
        }

        i++;
    }

    return { nodes, edges };
}

/**
 * Extract edges (event references) from an event body.
 */
function extractEdges(sourceId: string, body: string, edges: EventEdge[]) {
    // Split body into lines for context detection
    const lines = body.split('\n');
    let inOption = false;
    let optionName = '';
    let inImmediate = false;
    let inAfter = false;

    for (let j = 0; j < lines.length; j++) {
        const line = lines[j]!;
        const trimmed = line.trim();

        // Track context (option, immediate, after blocks)
        if (/^\s*option\s*=\s*\{/.test(trimmed)) {
            inOption = true;
            const nameMatch = trimmed.match(/name\s*=\s*"?([^"\n}]+)"?/);
            optionName = nameMatch ? nameMatch[1]!.trim() : 'option';
        }
        if (/^\s*immediate\s*=\s*\{/.test(trimmed)) inImmediate = true;
        if (/^\s*after\s*=\s*\{/.test(trimmed)) inAfter = true;

        // Match event fire patterns:
        // country_event = { id = crisis.200 }
        // country_event = { id = crisis.200 days = 10 }
        for (const pattern of EVENT_FIRE_PATTERNS) {
            const fireMatch = trimmed.match(
                new RegExp(`${pattern}\\s*=\\s*\\{\\s*id\\s*=\\s*(\\S+)`)
            );
            if (fireMatch) {
                const targetId = fireMatch[1]!;
                // Don't self-reference (recursive events are rare and cluttering)
                if (targetId === sourceId) continue;

                let edgeType: EventEdge['edgeType'] = 'unknown';
                let label: string | undefined;

                if (inOption) {
                    edgeType = 'option';
                    label = optionName;
                } else if (inImmediate) {
                    edgeType = 'immediate';
                } else if (inAfter) {
                    edgeType = 'after';
                } else {
                    edgeType = 'effect';
                }

                // Avoid duplicate edges
                const exists = edges.some(e =>
                    e.source === sourceId && e.target === targetId && e.edgeType === edgeType
                );
                if (!exists) {
                    edges.push({ source: sourceId, target: targetId, edgeType, label });
                }
            }
        }

        // Generic fallback for any line containing id = xxx or event = xxx
        // This gracefully handles multi-line blocks like:
        // country_event = { \n id = exe_invasion.132 \n }
        // as well as archaeological site stages: stage = { event = kuat_legacy.3 }
        const genericIdMatch = trimmed.match(/\b(?:id|event)\s*=\s*([a-zA-Z_]\w*\.\d+)/);
        if (genericIdMatch) {
            const targetId = genericIdMatch[1]!;
            if (targetId !== sourceId) {
                let edgeType: EventEdge['edgeType'] = inOption ? 'option' : inImmediate ? 'immediate' : inAfter ? 'after' : 'effect';
                addEdgeDedup(edges, sourceId, targetId, edgeType, inOption ? optionName : undefined);
            }
        }

        // Match random_events and random_list weights (e.g. 20 = kuat_situation.1)
        const randomMatch = trimmed.match(/^\d+\s*=\s*([a-zA-Z0-9_]+(?:\.\d+)?)$/);
        if (randomMatch) {
            const targetId = randomMatch[1]!;
            if (targetId !== '0' && targetId !== sourceId && !/^\d+$/.test(targetId)) {
                let edgeType: EventEdge['edgeType'] = inOption ? 'option' : inImmediate ? 'immediate' : inAfter ? 'after' : 'effect';
                addEdgeDedup(edges, sourceId, targetId, edgeType, inOption ? optionName : undefined);
            }
        }

        // Helper for multi-line extraction
        const extractLookahead = (pattern: RegExp, startIdx: number, maxLookahead: number = 4) => {
            for (let k = 0; k <= maxLookahead && startIdx + k < lines.length; k++) {
                const match = lines[startIdx + k]!.match(pattern);
                if (match) return match[1];
            }
            return undefined;
        };

        // Match special project creation
        if (trimmed.startsWith('enable_special_project')) {
            const name = extractLookahead(/name\s*=\s*"?([a-zA-Z0-9_-]+)"?/, j);
            if (name) {
                const targetId = `[special_project] ${name}`;
                addEdgeDedup(edges, sourceId, targetId, 'effect', inOption ? optionName : undefined);
            }
        }

        // Match situation creation
        if (trimmed.startsWith('create_situation')) {
            const sit = extractLookahead(/situation\s*=\s*"?([a-zA-Z0-9_-]+)"?/, j);
            if (sit) {
                const targetId = `[situation] ${sit}`;
                addEdgeDedup(edges, sourceId, targetId, 'effect', inOption ? optionName : undefined);
            }
        }

        // Match anomaly creation
        const anomalyMatch = trimmed.match(/add_anomaly\s*=\s*"?([a-zA-Z0-9_-]+)"?/);
        if (anomalyMatch) {
            const targetId = `[anomaly] ${anomalyMatch[1]!}`;
            addEdgeDedup(edges, sourceId, targetId, 'effect', inOption ? optionName : undefined);
        }

        // Match archaeology site creation
        const archMatch = trimmed.match(/create_archaeological_site\s*=\s*"?([a-zA-Z0-9_-]+)"?/);
        if (archMatch && archMatch[1] !== 'random') {
            const targetId = `[archaeology] ${archMatch[1]!}`;
            addEdgeDedup(edges, sourceId, targetId, 'effect', inOption ? optionName : undefined);
        }

        // Match extra fire patterns (e.g. set_next_astral_rift_event = { id = xxx })
        for (const pattern of EXTRA_FIRE_PATTERNS) {
            const fireMatch = trimmed.match(
                new RegExp(`${pattern}\\s*=\\s*\\{\\s*id\\s*=\\s*(\\S+)`)
            );
            if (fireMatch) {
                const targetId = fireMatch[1]!;
                if (targetId === sourceId) continue;
                const edgeType: EventEdge['edgeType'] = inOption ? 'option' : inImmediate ? 'immediate' : inAfter ? 'after' : 'effect';
                addEdgeDedup(edges, sourceId, targetId, edgeType, inOption ? optionName : undefined);
            }
        }

        // Reset context on closing braces (rough heuristic)
        if (trimmed === '}') {
            if (inOption) inOption = false;
            if (inImmediate) inImmediate = false;
            if (inAfter) inAfter = false;
        }
    }
}

// ─── Common file parser (on_actions, decisions, scripted_effects, etc.) ──────

/**
 * Parse a common/ directory file for event references.
 * Extracts edges from files like:
 * - on_actions/*.txt: `on_xxx = { events = { ns.100 ns.200 } }`
 * - scripted_effects/*.txt: `xxx_effect = { country_event = { id = ns.100 } }`
 * - decisions/*.txt: decision blocks that fire events
 * - solar_system_initializers, etc.
 *
 * These files don't define events, they reference them — so we only produce edges.
 * Source is either the on_action name or decision/effect name; target is the event ID.
 */
export function parseCommonFile(content: string, filePath: string): CommonFileResult {
    const edges: EventEdge[] = [];
    const externalSources: ExternalSourceNode[] = [];

    const lines = content.split(/\r?\n/);

    // Detect file type from path — comprehensive mapping
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();

    /** Determine source type from path */
    function detectSourceType(): ExternalSourceNode['sourceType'] {
        if (normalizedPath.includes('on_actions') || normalizedPath.includes('on_action')) return 'on_action';
        if (normalizedPath.includes('decisions')) return 'decision';
        if (normalizedPath.includes('scripted_effects')) return 'scripted_effect';
        if (normalizedPath.includes('scripted_triggers')) return 'scripted_trigger';
        if (normalizedPath.includes('special_projects')) return 'special_project';
        return 'other';
    }

    /** Determine edge type from path */
    function detectEdgeType(): EventEdge['edgeType'] {
        if (normalizedPath.includes('on_actions') || normalizedPath.includes('on_action')) return 'on_action';
        if (normalizedPath.includes('decisions')) return 'decision';
        if (normalizedPath.includes('scripted_effects') || normalizedPath.includes('scripted_triggers')) return 'scripted';
        return 'effect';
    }

    /** Label prefix for source node IDs */
    function detectLabel(): string {
        if (normalizedPath.includes('on_actions') || normalizedPath.includes('on_action')) return 'on_action';
        if (normalizedPath.includes('decisions')) return 'decision';
        if (normalizedPath.includes('scripted_effects')) return 'scripted_effect';
        if (normalizedPath.includes('scripted_triggers')) return 'scripted_trigger';
        if (normalizedPath.includes('special_projects')) return 'special_project';
        if (normalizedPath.includes('technology')) return 'technology';
        if (normalizedPath.includes('traditions')) return 'tradition';
        if (normalizedPath.includes('ascension_perks')) return 'ascension_perk';
        if (normalizedPath.includes('espionage_operation_types')) return 'espionage_op';
        if (normalizedPath.includes('first_contact')) return 'first_contact';
        if (normalizedPath.includes('anomalies')) return 'anomaly';
        if (normalizedPath.includes('archaeological_site_types')) return 'archaeology';
        if (normalizedPath.includes('situations')) return 'situation';
        if (normalizedPath.includes('megastructures')) return 'megastructure';
        if (normalizedPath.includes('diplomatic_actions')) return 'diplo_action';
        if (normalizedPath.includes('observation_station')) return 'observation';
        if (normalizedPath.includes('edicts')) return 'edict';
        if (normalizedPath.includes('policies')) return 'policy';
        if (normalizedPath.includes('resolutions')) return 'resolution';
        return 'common';
    }

    const sourceType = detectSourceType();
    const edgeType = detectEdgeType();
    const labelPrefix = detectLabel();

    // Current top-level block name (on_action name, decision name, effect name)
    let currentBlockName = '';
    let currentBlockLine = 0;
    let depth = 0;
    let lastSeenSequentialEvent: string | undefined = undefined;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('#')) continue;

        // Track brace depth for block context
        const prevDepth = depth;
        const noComment = trimmed.split('#')[0]!;
        for (const ch of noComment) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
        }

        // Detect top-level block names (depth 0→1 transition)
        // Using prevDepth === 0 ensures we only capture the actual root definitions
        // and not inline blocks that open and close on the same line at depth 1.
        if (prevDepth === 0 && depth > 0) {
            const blockMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{/);
            if (blockMatch) {
                currentBlockName = blockMatch[1]!;
                currentBlockLine = i + 1;
                lastSeenSequentialEvent = undefined;

                externalSources.push({
                    id: `[${labelPrefix}] ${currentBlockName}`,
                    name: currentBlockName,
                    sourceType,
                    file: filePath,
                    line: currentBlockLine,
                });
            }
        }

        // Refine generic block names if a key/name is specified inside the block
        if (depth > 0 && /^(?:special_project|anomaly|situation)$/.test(currentBlockName)) {
            const keyMatch = trimmed.match(/^(?:key|name|anomaly_category)\s*=\s*"?([a-zA-Z0-9_-]+)"?/);
            if (keyMatch) {
                const newName = keyMatch[1]!;
                const oldId = `[${labelPrefix}] ${currentBlockName}`;
                const newId = `[${labelPrefix}] ${newName}`;
                
                const source = externalSources.find(s => s.id === oldId && s.line === currentBlockLine);
                if (source) {
                    source.id = newId;
                    source.name = newName;
                }
                for (const edge of edges) {
                    if (edge.source === oldId) edge.source = newId;
                    if (edge.target === oldId) edge.target = newId;
                }
                currentBlockName = newName;
            }
        }

        // Reset block name on return to depth 0
        if (depth <= 0) {
            currentBlockName = '';
            depth = 0; // Prevent negative depth
        }

        // Pattern 1: on_action events list
        //   events = { ns.100 ns.200 ns.300 }
        //   events = { ns.100 }
        const eventsListMatch = trimmed.match(/\bevents\s*=\s*\{([^}]+)\}/);
        if (eventsListMatch && currentBlockName) {
            const eventIds = eventsListMatch[1]!.trim().split(/\s+/);
            for (const eventId of eventIds) {
                if (eventId && /\w+\.\d+/.test(eventId)) {
                    const sourceId = `[${labelPrefix}] ${currentBlockName}`;
                    addEdgeDedup(edges, sourceId, eventId, edgeType);
                }
            }
        }

        // Pattern 2: inline event fire (works in decisions, scripted_effects, special_projects, etc.)
        //   country_event = { id = ns.100 }
        //   country_event = { id = ns.100 days = 30 }
        for (const pattern of EVENT_FIRE_PATTERNS) {
            const fireMatch = trimmed.match(
                new RegExp(`${pattern}\\s*=\\s*\\{\\s*id\\s*=\\s*(\\S+)`)
            );
            if (fireMatch && currentBlockName) {
                const targetId = fireMatch[1]!;
                const sourceId = `[${labelPrefix}] ${currentBlockName}`;
                addEdgeDedup(edges, sourceId, targetId, edgeType);
            }
        }

        // Generic fallback for multi-line blocks or archaeological stages
        // e.g. stage = { event = kuat_legacy.3 }
        const genericIdMatch = trimmed.match(/\b(?:id|event)\s*=\s*([a-zA-Z_]\w*\.\d+)/);
        if (genericIdMatch && currentBlockName) {
            const targetId = genericIdMatch[1]!;
            const sourceId = `[${labelPrefix}] ${currentBlockName}`;
            
            if (labelPrefix === 'archaeology' || labelPrefix === 'situation') {
                if (lastSeenSequentialEvent) {
                    addEdgeDedup(edges, lastSeenSequentialEvent, targetId, 'after');
                } else {
                    addEdgeDedup(edges, sourceId, targetId, edgeType);
                }
                lastSeenSequentialEvent = targetId;
            } else {
                addEdgeDedup(edges, sourceId, targetId, edgeType);
            }
        }

        // Pattern 3: Multi-line events list
        //   events = {
        //       ns.100
        //       ns.200
        //   }
        if (trimmed === 'events = {' || /\bevents\s*=\s*\{\s*$/.test(trimmed)) {
            // Consume until closing brace
            for (let j = i + 1; j < lines.length; j++) {
                const inner = lines[j]!.trim();
                if (inner === '}') break;
                if (inner.startsWith('#')) continue;
                // Each line may contain one or more event IDs
                const ids = inner.split(/\s+/).filter(s => /\w+\.\d+/.test(s));
                for (const eventId of ids) {
                    if (currentBlockName) {
                        const sourceId = `[${labelPrefix}] ${currentBlockName}`;
                        addEdgeDedup(edges, sourceId, eventId, edgeType);
                    }
                }
            }
        }

        // Match random_events weights (e.g. 20 = kuat_situation.1)
        const randomMatch = trimmed.match(/^\d+\s*=\s*([a-zA-Z0-9_]+(?:\.\d+)?)$/);
        if (randomMatch && currentBlockName) {
            const targetId = randomMatch[1]!;
            if (targetId !== '0' && !/^\d+$/.test(targetId)) {
                const sourceId = `[${labelPrefix}] ${currentBlockName}`;
                addEdgeDedup(edges, sourceId, targetId, edgeType);
            }
        }

        // Helper for multi-line extraction
        const extractLookaheadOther = (pattern: RegExp, startIdx: number, maxLookahead: number = 4) => {
            for (let k = 0; k <= maxLookahead && startIdx + k < lines.length; k++) {
                const match = lines[startIdx + k]!.match(pattern);
                if (match) return match[1];
            }
            return undefined;
        };

        // Match special project creation
        if (trimmed.startsWith('enable_special_project')) {
            const name = extractLookaheadOther(/name\s*=\s*"?([a-zA-Z0-9_-]+)"?/, i);
            if (name && currentBlockName) {
                const targetId = `[special_project] ${name}`;
                const sourceId = `[${labelPrefix}] ${currentBlockName}`;
                addEdgeDedup(edges, sourceId, targetId, edgeType);
            }
        }

        // Match situation creation
        if (trimmed.startsWith('create_situation')) {
            const sit = extractLookaheadOther(/situation\s*=\s*"?([a-zA-Z0-9_-]+)"?/, i);
            if (sit && currentBlockName) {
                const targetId = `[situation] ${sit}`;
                const sourceId = `[${labelPrefix}] ${currentBlockName}`;
                addEdgeDedup(edges, sourceId, targetId, edgeType);
            }
        }

        // Match anomaly creation
        const anomalyMatch = trimmed.match(/add_anomaly\s*=\s*"?([a-zA-Z0-9_-]+)"?/);
        if (anomalyMatch && currentBlockName) {
            const targetId = `[anomaly] ${anomalyMatch[1]!}`;
            const sourceId = `[${labelPrefix}] ${currentBlockName}`;
            addEdgeDedup(edges, sourceId, targetId, edgeType);
        }
    }

    return { edges, externalSources };
}

/** External source node (on_action, decision, scripted_effect — not an event) */
export interface ExternalSourceNode {
    id: string;
    name: string;
    sourceType: 'on_action' | 'decision' | 'scripted_effect' | 'scripted_trigger' | 'special_project' | 'other';
    file: string;
    line: number;
}

export interface CommonFileResult {
    edges: EventEdge[];
    externalSources: ExternalSourceNode[];
}

/** Helper: add edge if not duplicate */
function addEdgeDedup(
    edges: EventEdge[], source: string, target: string,
    edgeType: EventEdge['edgeType'], label?: string,
) {
    const exists = edges.some(e => e.source === source && e.target === target && e.edgeType === edgeType);
    if (!exists) {
        edges.push({ source, target, edgeType, label });
    }
}

// ─── Graph merging ───────────────────────────────────────────────────────────

/**
 * Merge multiple EventGraphs into a single unified graph.
 * Deduplicates nodes by ID (first definition wins) and merges all edges.
 */
export function mergeGraphs(graphs: EventGraph[]): EventGraph {
    const nodeMap = new Map<string, EventNode>();
    const allEdges: EventEdge[] = [];

    for (const g of graphs) {
        for (const node of g.nodes) {
            if (!nodeMap.has(node.id)) {
                nodeMap.set(node.id, node);
            }
        }
        allEdges.push(...g.edges);
    }

    // Deduplicate edges
    const edgeSet = new Set<string>();
    const edges: EventEdge[] = [];
    for (const e of allEdges) {
        const key = `${e.source}→${e.target}→${e.edgeType}`;
        if (!edgeSet.has(key)) {
            edgeSet.add(key);
            edges.push(e);
        }
    }

    return {
        nodes: Array.from(nodeMap.values()),
        edges,
    };
}

/**
 * BFS-expand from seed event IDs to find all connected events.
 * Returns a subgraph containing only events reachable from the seeds.
 */
export function extractConnectedSubgraph(
    fullGraph: EventGraph,
    seedIds: Set<string>,
    maxDepth: number = 10,
): EventGraph {
    const visited = new Set<string>();
    let frontier = [...seedIds];

    // BFS expansion
    for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
        const nextFrontier: string[] = [];
        for (const id of frontier) {
            if (visited.has(id)) continue;
            visited.add(id);

            // Find all edges from/to this node
            for (const e of fullGraph.edges) {
                if (e.source === id && !visited.has(e.target)) {
                    nextFrontier.push(e.target);
                }
                if (e.target === id && !visited.has(e.source)) {
                    nextFrontier.push(e.source);
                }
            }
        }
        frontier = nextFrontier;
    }
    // Add final frontier
    for (const id of frontier) visited.add(id);

    // Filter graph
    const nodes = fullGraph.nodes.filter(n => visited.has(n.id));
    const nodeIds = new Set(nodes.map(n => n.id));
    // Include edges where BOTH endpoints are in our visited set
    const edges = fullGraph.edges.filter(e => visited.has(e.source) || visited.has(e.target));

    return { nodes, edges };
}
