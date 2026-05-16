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

/**
 * Flag 信息：包含 scope 类型和 flag 名称
 * scope 用于严格匹配（set_country_flag 只匹配 has_country_flag）
 */
export interface FlagRef {
    scope: string;  // 'country' | 'global' | 'planet' | 'star' | 'fleet' | 'ship' | 'pop' | 'species' | 'leader'
    name: string;   // flag 名称
}

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
    /** Whether this event uses mean_time_to_happen (probabilistic trigger) */
    hasMTTH: boolean;
    /** 该事件在 effect 中设置的 flags（scope+name） */
    flagsSet: FlagRef[];
    /** 该事件在 trigger 中检查的 flags（scope+name） */
    flagsChecked: FlagRef[];
    /** 该事件授予的科技 */
    techsGranted: string[];
    /** 该事件在 trigger 中要求的科技（has_technology） */
    techsRequired: string[];
    /** 该事件在 trigger 中检测刚研究完的科技（last_increased_tech） */
    techsLastIncreased: string[];
    /** 该事件触发的 on_action（fire_on_action 调用） */
    firedOnActions: string[];
}

export interface EventEdge {
    /** Source event ID */
    source: string;
    /** Target event ID */
    target: string;
    /** 边类型：显式连接 + flag/on_action_implicit 隐式连接 */
    edgeType: 'option' | 'immediate' | 'after' | 'effect' | 'on_action' | 'decision' | 'scripted' | 'flag' | 'on_action_implicit' | 'unknown';
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

                // 检测 mean_time_to_happen（概率触发事件）
                const hasMTTH = /\bmean_time_to_happen\s*=\s*\{/.test(body);

                // 提取隐式连接数据（flags、科技、fire_on_action）
                const implicit = extractImplicitData(body);

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
                    hasMTTH,
                    flagsSet: implicit.flagsSet,
                    flagsChecked: implicit.flagsChecked,
                    techsGranted: implicit.techsGranted,
                    techsRequired: implicit.techsRequired,
                    techsLastIncreased: implicit.techsLastIncreased,
                    firedOnActions: implicit.firedOnActions,
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
        if (trimmed.startsWith('start_situation') || trimmed.startsWith('create_situation')) {
            const sit = extractLookahead(/(?:type|situation)\s*=\s*"?([a-zA-Z0-9_-]+)"?/, j);
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

/**
 * 科技定义文件中的 flag 前置条件映射。
 * key: 科技名称，value: 该科技在 potential 中要求的 flags。
 */
export type TechFlagMap = Map<string, FlagRef[]>;

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

/**
 * 解析科技定义文件，提取每个科技在 potential 块中的 flag 前置条件。
 * 用于构建 flag → tech → event 的传递性隐式链接。
 */
export function parseTechFlagRequirements(content: string): TechFlagMap {
    const result: TechFlagMap = new Map();
    const lines = content.split(/\r?\n/);
    let currentTech = '';
    let depth = 0;
    let inPotential = false;
    let potentialDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i]!.trim();
        if (trimmed.startsWith('#')) continue;

        const prevDepth = depth;
        for (const ch of trimmed.split('#')[0]!) {
            if (ch === '{') depth++;
            if (ch === '}') depth--;
        }

        // 顶层科技定义：tech_xxx = {
        if (prevDepth === 0 && depth > 0) {
            const blockMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s*=\s*\{/);
            if (blockMatch && blockMatch[1]!.startsWith('tech_')) {
                currentTech = blockMatch[1]!;
                result.set(currentTech, []);
            }
        }

        // 检测 potential 块
        if (currentTech && !inPotential && /^potential\s*=\s*\{/.test(trimmed)) {
            inPotential = true;
            potentialDepth = 0;
            for (const ch of trimmed) {
                if (ch === '{') potentialDepth++;
                if (ch === '}') potentialDepth--;
            }
            // 提取当行的 flag
            extractFlagsFromLine(trimmed, currentTech, result);
            if (potentialDepth <= 0) inPotential = false;
            continue;
        }

        if (inPotential) {
            for (const ch of trimmed) {
                if (ch === '{') potentialDepth++;
                if (ch === '}') potentialDepth--;
            }
            extractFlagsFromLine(trimmed, currentTech, result);
            if (potentialDepth <= 0) inPotential = false;
        }

        // 科技定义结束
        if (depth <= 0) {
            currentTech = '';
            inPotential = false;
            depth = 0;
        }
    }

    return result;
}

/** 从line中提取 has_*_flag 并添加到 techFlagMap */
function extractFlagsFromLine(line: string, techName: string, map: TechFlagMap) {
    const re = new RegExp(
        `\\bhas_(${FLAG_SCOPES.join('|')})_flag\\s*=\\s*"?([a-zA-Z0-9_]+)"?`, 'g'
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
        const flags = map.get(techName);
        if (flags) {
            flags.push({ scope: m[1]!, name: m[2]! });
        }
    }
}

// ─── 隐式连接数据提取 ────────────────────────────────────────────────────────

// 支持的所有 flag scope 类型
const FLAG_SCOPES = ['country', 'global', 'planet', 'star', 'fleet', 'ship', 'pop', 'species', 'leader'] as const;

// 构建 set/has flag 正则（带 scope 捕获）
const SET_FLAG_RE = new RegExp(
    `\\bset_(${FLAG_SCOPES.join('|')})_flag\\s*=\\s*(?:\\{\\s*flag\\s*=\\s*)?"?([a-zA-Z0-9_]+)"?`, 'g'
);
const HAS_FLAG_RE = new RegExp(
    `\\bhas_(${FLAG_SCOPES.join('|')})_flag\\s*=\\s*"?([a-zA-Z0-9_]+)"?`, 'g'
);
// timed flag：set_timed_country_flag = { flag = xxx days = 30 }
const SET_TIMED_FLAG_RE = new RegExp(
    `\\bset_timed_(${FLAG_SCOPES.join('|')})_flag\\s*=\\s*\\{[^}]*flag\\s*=\\s*"?([a-zA-Z0-9_]+)"?`, 'g'
);

// 科技相关
const GIVE_TECH_RE = /\bgive_technology\s*=\s*\{[^}]*tech\s*=\s*"?([a-zA-Z0-9_]+)"?/g;
const ADD_RESEARCH_OPTION_RE = /\badd_research_option\s*=\s*"?([a-zA-Z0-9_]+)"?/g;
const HAS_TECH_RE = /\bhas_technology\s*=\s*"?([a-zA-Z0-9_]+)"?/g;
const LAST_INCREASED_TECH_RE = /\blast_increased_tech\s*=\s*"?([a-zA-Z0-9_]+)"?/g;

// fire_on_action
const FIRE_ON_ACTION_RE = /\bfire_on_action\s*=\s*\{[^}]*on_action\s*=\s*"?([a-zA-Z0-9_]+)"?/g;

/**
 * 从事件体中提取隐式连接数据。
 * 区分 trigger 块（条件检查）和 effect 块（设置操作）。
 */
function extractImplicitData(body: string): {
    flagsSet: FlagRef[];
    flagsChecked: FlagRef[];
    techsGranted: string[];
    techsRequired: string[];
    techsLastIncreased: string[];
    firedOnActions: string[];
} {
    const flagsSet: FlagRef[] = [];
    const flagsChecked: FlagRef[] = [];
    const techsGranted: string[] = [];
    const techsRequired: string[] = [];
    const techsLastIncreased: string[] = [];
    const firedOnActions: string[] = [];

    // 分离 trigger 块和其余部分（effect 块）
    // trigger 块通常是事件体内的顶层块
    const { triggerText, effectText } = splitTriggerAndEffect(body);

    // 从 effect 部分提取 set_*_flag（设置 flag）
    let match: RegExpExecArray | null;
    SET_FLAG_RE.lastIndex = 0;
    while ((match = SET_FLAG_RE.exec(effectText)) !== null) {
        flagsSet.push({ scope: match[1]!, name: match[2]! });
    }
    SET_TIMED_FLAG_RE.lastIndex = 0;
    while ((match = SET_TIMED_FLAG_RE.exec(effectText)) !== null) {
        flagsSet.push({ scope: match[1]!, name: match[2]! });
    }

    // 从 trigger 部分提取 has_*_flag（检查 flag）
    HAS_FLAG_RE.lastIndex = 0;
    while ((match = HAS_FLAG_RE.exec(triggerText)) !== null) {
        flagsChecked.push({ scope: match[1]!, name: match[2]! });
    }

    // 从 effect 部分提取 give_technology / add_research_option（授予科技）
    GIVE_TECH_RE.lastIndex = 0;
    while ((match = GIVE_TECH_RE.exec(effectText)) !== null) {
        techsGranted.push(match[1]!);
    }
    ADD_RESEARCH_OPTION_RE.lastIndex = 0;
    while ((match = ADD_RESEARCH_OPTION_RE.exec(effectText)) !== null) {
        techsGranted.push(match[1]!);
    }

    // 从 trigger 部分提取 has_technology（要求科技）
    HAS_TECH_RE.lastIndex = 0;
    while ((match = HAS_TECH_RE.exec(triggerText)) !== null) {
        techsRequired.push(match[1]!);
    }
    LAST_INCREASED_TECH_RE.lastIndex = 0;
    while ((match = LAST_INCREASED_TECH_RE.exec(triggerText)) !== null) {
        techsLastIncreased.push(match[1]!);
    }

    // 从 effect 部分提取 fire_on_action
    FIRE_ON_ACTION_RE.lastIndex = 0;
    while ((match = FIRE_ON_ACTION_RE.exec(effectText)) !== null) {
        firedOnActions.push(match[1]!);
    }

    return { flagsSet, flagsChecked, techsGranted, techsRequired, techsLastIncreased, firedOnActions };
}

/**
 * 将事件体分离为 trigger 部分和 effect 部分。
 * trigger 块内的条件用于 flagsChecked/techsRequired，
 * 其余部分（option/immediate/after/mean_time_to_happen 的 modifier）用于 flagsSet/techsGranted。
 */
function splitTriggerAndEffect(body: string): { triggerText: string; effectText: string } {
    const lines = body.split('\n');
    const triggerLines: string[] = [];
    const effectLines: string[] = [];
    let inTrigger = false;
    let triggerDepth = 0;

    for (const line of lines) {
        const trimmed = line.trim();
        // 跳过注释
        if (trimmed.startsWith('#')) continue;

        // 检测 trigger 块开始（事件体内的顶层 trigger = {）
        if (!inTrigger && /^trigger\s*=\s*\{/.test(trimmed)) {
            inTrigger = true;
            triggerDepth = 0;
            for (const ch of trimmed) {
                if (ch === '{') triggerDepth++;
                if (ch === '}') triggerDepth--;
            }
            triggerLines.push(trimmed);
            if (triggerDepth <= 0) inTrigger = false;
            continue;
        }

        if (inTrigger) {
            for (const ch of trimmed) {
                if (ch === '{') triggerDepth++;
                if (ch === '}') triggerDepth--;
            }
            triggerLines.push(trimmed);
            if (triggerDepth <= 0) inTrigger = false;
        } else {
            effectLines.push(trimmed);
        }
    }

    return {
        triggerText: triggerLines.join('\n'),
        effectText: effectLines.join('\n'),
    };
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
 * 在所有事件解析并合并后，通过交叉匹配 flag/科技/on_action 创建隐式边。
 * 这是全局后处理步骤，必须在 mergeGraphs 之后调用。
 * @param techFlagMap 科技定义文件中的 flag 前置条件映射（可选）
 */
export function buildImplicitEdges(graph: EventGraph, techFlagMap?: TechFlagMap): EventEdge[] {
    const implicitEdges: EventEdge[] = [];
    const edgeSet = new Set<string>();

    // 建立节点映射，便于检查 hasMTTH
    const nodeMap = new Map<string, EventNode>();
    for (const node of graph.nodes) {
        nodeMap.set(node.id, node);
    }

    // 索引：按 scope+flag 名称建立 set→events 和 check→events 的映射
    const flagSetters = new Map<string, string[]>();  // key: "scope:name" → eventIds[]
    const flagCheckers = new Map<string, string[]>(); // key: "scope:name" → eventIds[]
    const techGranters = new Map<string, string[]>(); // key: techName → eventIds[]
    const techRequirers = new Map<string, string[]>(); // key: techName → eventIds[]
    const techLastIncreased = new Map<string, string[]>(); // key: techName → eventIds[]
    const onActionFirers = new Map<string, string[]>(); // key: onActionName → eventIds[]

    for (const node of graph.nodes) {
        // 跳过外部源节点（[on_action] xxx 等）
        if (node.id.startsWith('[')) continue;

        for (const flag of node.flagsSet) {
            const key = `${flag.scope}:${flag.name}`;
            if (!flagSetters.has(key)) flagSetters.set(key, []);
            flagSetters.get(key)!.push(node.id);
        }
        for (const flag of node.flagsChecked) {
            const key = `${flag.scope}:${flag.name}`;
            if (!flagCheckers.has(key)) flagCheckers.set(key, []);
            flagCheckers.get(key)!.push(node.id);
        }
        for (const tech of node.techsGranted) {
            if (!techGranters.has(tech)) techGranters.set(tech, []);
            techGranters.get(tech)!.push(node.id);
        }
        for (const tech of node.techsRequired) {
            if (!techRequirers.has(tech)) techRequirers.set(tech, []);
            techRequirers.get(tech)!.push(node.id);
        }
        for (const tech of node.techsLastIncreased) {
            if (!techLastIncreased.has(tech)) techLastIncreased.set(tech, []);
            techLastIncreased.get(tech)!.push(node.id);
        }
        for (const oa of node.firedOnActions) {
            if (!onActionFirers.has(oa)) onActionFirers.set(oa, []);
            onActionFirers.get(oa)!.push(node.id);
        }
    }

    // Flag 隐式边：set_*_flag 事件 → has_*_flag 事件（同 scope+name 匹配）
    for (const [flagKey, setterIds] of flagSetters) {
        const checkerIds = flagCheckers.get(flagKey);
        if (!checkerIds) continue;
        const flagName = flagKey.split(':')[1] || flagKey;
        for (const setterId of setterIds) {
            for (const checkerId of checkerIds) {
                if (setterId === checkerId) continue; // 不自引用
                
                // 【过滤规则】隐式连接线只针对带有 MTTH 的事件，不连接正常的显式链条事件
                const checkerNode = nodeMap.get(checkerId);
                if (checkerNode && !checkerNode.hasMTTH) continue;

                const edgeKey = `${setterId}→${checkerId}→flag`;
                if (!edgeSet.has(edgeKey)) {
                    edgeSet.add(edgeKey);
                    implicitEdges.push({
                        source: setterId,
                        target: checkerId,
                        edgeType: 'flag',
                        label: flagName,
                    });
                }
            }
        }
    }

    // 科技隐式边：give_technology 事件 → has_technology / last_increased_tech 事件
    for (const [tech, granterIds] of techGranters) {
        const requirerIds = techRequirers.get(tech) || [];
        const lastIncIds = techLastIncreased.get(tech) || [];
        const allTargetIds = Array.from(new Set([...requirerIds, ...lastIncIds]));
        
        if (allTargetIds.length === 0) continue;

        for (const granterId of granterIds) {
            for (const targetId of allTargetIds) {
                if (granterId === targetId) continue;

                const targetNode = nodeMap.get(targetId);
                // 【过滤规则】如果是 has_technology（在 requirerIds 中），则必须要有 MTTH
                // 如果是 last_increased_tech（在 lastIncIds 中），则豁免此规则（因为是在 on_action 中触发的）
                if (targetNode && requirerIds.includes(targetId) && !lastIncIds.includes(targetId) && !targetNode.hasMTTH) {
                    continue;
                }

                const edgeKey = `${granterId}→${targetId}→flag`;
                if (!edgeSet.has(edgeKey)) {
                    edgeSet.add(edgeKey);
                    implicitEdges.push({
                        source: granterId,
                        target: targetId,
                        edgeType: 'flag',
                        label: tech,
                    });
                }
            }
        }
    }

    // on_action 隐式边：fire_on_action 事件 → [on_action] xxx 节点
    for (const [oaName, firerIds] of onActionFirers) {
        // 查找图中对应的 on_action 节点
        const oaNodeId = `[on_action] ${oaName}`;
        const oaNodeExists = graph.nodes.some(n => n.id === oaNodeId);
        if (!oaNodeExists) continue;

        for (const firerId of firerIds) {
            const edgeKey = `${firerId}→${oaNodeId}→on_action_implicit`;
            if (!edgeSet.has(edgeKey)) {
                edgeSet.add(edgeKey);
                implicitEdges.push({
                    source: firerId,
                    target: oaNodeId,
                    edgeType: 'on_action_implicit',
                });
            }
        }
    }

    // 传递性隐式链：flag → 科技 → 事件
    // 场景：Event A set_flag → Tech potential has_flag → Event B trigger has_technology
    if (techFlagMap && techFlagMap.size > 0) {
        // 构建反向索引：flagKey → techs that require it
        const flagToTechs = new Map<string, string[]>();
        for (const [techName, flags] of techFlagMap) {
            for (const flag of flags) {
                const key = `${flag.scope}:${flag.name}`;
                if (!flagToTechs.has(key)) flagToTechs.set(key, []);
                flagToTechs.get(key)!.push(techName);
            }
        }

        // 对每个 set_flag 的事件，查找哪些科技需要该 flag，再查找哪些事件需要该科技
        for (const [flagKey, setterIds] of flagSetters) {
            const techNames = flagToTechs.get(flagKey);
            if (!techNames) continue;

            for (const techName of techNames) {
                const requirerIds = techRequirers.get(techName) || [];
                const lastIncIds = techLastIncreased.get(techName) || [];
                const allTargetIds = Array.from(new Set([...requirerIds, ...lastIncIds]));

                if (allTargetIds.length === 0) continue;

                for (const setterId of setterIds) {
                    for (const targetId of allTargetIds) {
                        if (setterId === targetId) continue;

                        const targetNode = nodeMap.get(targetId);
                        // 【过滤规则】同上，过滤掉正常的链条事件
                        if (targetNode && requirerIds.includes(targetId) && !lastIncIds.includes(targetId) && !targetNode.hasMTTH) {
                            continue;
                        }

                        const edgeKey = `${setterId}→${targetId}→flag`;
                        if (!edgeSet.has(edgeKey)) {
                            edgeSet.add(edgeKey);
                            implicitEdges.push({
                                source: setterId,
                                target: targetId,
                                edgeType: 'flag',
                                label: `${flagKey.split(':')[1]} → ${techName}`,
                            });
                        }
                    }
                }
            }
        }
    }

    return implicitEdges;
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
