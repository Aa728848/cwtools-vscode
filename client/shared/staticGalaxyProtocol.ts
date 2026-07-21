/**
 * Shared Static Galaxy preview/editor protocol.
 *
 * Environment-neutral contract between the Extension Host and the Webview.
 * This file must only contain serializable types, constants and platform-free
 * type guards — no `vscode`, `fs`, `path` or DOM imports.
 *
 * Source spans never cross this boundary: the Host keeps a private
 * `nodeKey -> spans` index per revision and the Webview only holds opaque
 * keys plus the revision/document version it rendered.
 */

// ─── Coordinates ────────────────────────────────────────────────────────────

export type StaticGalaxyAxis =
    | {
        kind: 'fixed';
        value: number;
        center: number;
    }
    | {
        kind: 'range';
        min: number;
        max: number;
        center: number;
        width: number;
        reversed: boolean;
    }
    | {
        kind: 'unresolved';
        raw: string;
        reason: string;
    };

export interface StaticGalaxyPosition {
    x: StaticGalaxyAxis;
    y: StaticGalaxyAxis;
    z?: StaticGalaxyAxis;
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

export type StaticGalaxyDiagnosticSeverity = 'error' | 'warning' | 'information';

export interface StaticGalaxyDiagnosticView {
    severity: StaticGalaxyDiagnosticSeverity;
    code: string;
    message: string;
    /** Present when the diagnostic belongs to a specific system/nebula/lane. */
    nodeKey?: string;
}

// ─── Render model ───────────────────────────────────────────────────────────

export interface StaticGalaxyInitializerInfo {
    starClass?: string;
    color?: string;
    planetCount: number;
    moonCount: number;
    beltCount: number;
    hasRing: boolean;
    /** False when the initializer was not found in the workspace. */
    found: boolean;
}

export interface StaticGalaxySystemView {
    nodeKey: string;
    id: string;
    name?: string;
    displayName: string;
    initializer?: string;
    initializerInfo?: StaticGalaxyInitializerInfo;
    rawPosition: StaticGalaxyPosition;
    effectivePosition: StaticGalaxyPosition;
    editable: boolean;
    /** Why the system cannot be edited from the canvas (when editable=false). */
    editBlockedReason?: string;
    /** True when a coordinate_transform affects this node's effective position. */
    transformApplied?: boolean;
    diagnostics: StaticGalaxyDiagnosticView[];
    visual?: {
        color?: string;
        starClass?: string;
    };
}

export interface StaticGalaxyNebulaView {
    nodeKey: string;
    name?: string;
    displayName: string;
    rawPosition: StaticGalaxyPosition;
    effectivePosition: StaticGalaxyPosition;
    radius: number | null;
    /** Whether the radius can be written back (literal token or insertable block). */
    radiusEditable?: boolean;
    editable: boolean;
    /** Why the nebula cannot be edited from the canvas (when editable=false). */
    editBlockedReason?: string;
    /** True when a coordinate_transform affects this node's effective position. */
    transformApplied?: boolean;
    diagnostics: StaticGalaxyDiagnosticView[];
}

export type StaticGalaxyHyperlaneKind = 'add' | 'remove' | 'prevent';

export interface StaticGalaxyHyperlaneView {
    nodeKey: string;
    kind: StaticGalaxyHyperlaneKind;
    /** Declared endpoint system ids (text as written in source). */
    fromId: string;
    toId: string;
    /** Resolved endpoint nodes; undefined when dangling or ambiguous. */
    fromNodeKey?: string;
    toNodeKey?: string;
    diagnostics: StaticGalaxyDiagnosticView[];
}

export interface StaticGalaxyScenarioSettings {
    randomHyperlanes: boolean;
    maxHyperlaneDistance?: number;
    hyperlaneDensity?: number;
}

export interface StaticGalaxyBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

export interface StaticGalaxyScenarioView {
    scenarioKey: string;
    name: string;
    systems: StaticGalaxySystemView[];
    nebulas: StaticGalaxyNebulaView[];
    hyperlanes: StaticGalaxyHyperlaneView[];
    settings: StaticGalaxyScenarioSettings;
    bounds: StaticGalaxyBounds;
    diagnostics: StaticGalaxyDiagnosticView[];
}

export interface StaticGalaxyRevision {
    revisionId: string;
    documentVersion: number;
    scenarios: StaticGalaxyScenarioView[];
    /** True when this snapshot is a fallback shown after a parse failure. */
    parseFailed?: boolean;
}

// ─── Document state ─────────────────────────────────────────────────────────

export type StaticGalaxyDocumentState =
    | 'saved'
    | 'modified'
    | 'applying'
    | 'readonly'
    | 'stale'
    | 'error';

// ─── Edit requests ──────────────────────────────────────────────────────────

/** Maximum number of moves in a single request. Batch editing may raise this. */
export const STATIC_GALAXY_MAX_MOVES = 1;

/** Maximum chained hyperlane links confirmed in one request. */
export const STATIC_GALAXY_MAX_LANE_LINKS = 64;

/** Maximum systems created or erased in one spray stroke. */
export const STATIC_GALAXY_MAX_SPRAY_SYSTEMS = 200;

/** Absolute upper bound for coordinate values accepted by the Host. */
export const STATIC_GALAXY_MAX_COORDINATE = 1_000_000;

export interface StaticGalaxySystemMove {
    nodeKey: string;
    /** Target center in effective (canvas) coordinates. */
    x: number;
    y: number;
}

/**
 * Per-axis precise edit from the Inspector, expressed in raw file coordinates.
 * `range` rewrites both endpoints; `fixed` rewrites the single value.
 */
export type StaticGalaxyAxisUpdate =
    | { kind: 'fixed'; value: number }
    | { kind: 'range'; min: number; max: number };

export interface StaticGalaxyPositionUpdate {
    nodeKey: string;
    x?: StaticGalaxyAxisUpdate;
    y?: StaticGalaxyAxisUpdate;
    z?: StaticGalaxyAxisUpdate;
}

export interface StaticGalaxyHyperlaneUpdate {
    fromNodeKey: string;
    toNodeKey: string;
    /** True writes add_hyperlane; false writes remove_hyperlane. */
    connected: boolean;
}

export type StaticGalaxyEditRejectCode =
    | 'stale-revision'
    | 'version-mismatch'
    | 'unknown-node'
    | 'not-editable'
    | 'token-mismatch'
    | 'invalid-value'
    | 'parse-error'
    | 'read-only'
    | 'apply-failed';

// ─── Host -> Webview ────────────────────────────────────────────────────────

export type StaticGalaxyHostMessage =
    | { type: 'render'; revision: StaticGalaxyRevision; activeScenarioKey?: string }
    | { type: 'documentState'; state: StaticGalaxyDocumentState; dirty: boolean; message?: string }
    | { type: 'editAccepted'; requestId: string; revisionId: string }
    | {
        type: 'editRejected';
        requestId: string;
        code: StaticGalaxyEditRejectCode;
        message: string;
        revision?: StaticGalaxyRevision;
    }
    | { type: 'focusNode'; nodeKey: string }
    | { type: 'permissions'; canEdit: boolean; reason?: string; workshopFile: boolean };

// ─── Webview -> Host ────────────────────────────────────────────────────────

export type StaticGalaxyWebviewMessage =
    | { type: 'ready' }
    | {
        type: 'moveSystems';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        moves: StaticGalaxySystemMove[];
    }
    | {
        type: 'moveNebula';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        move: StaticGalaxySystemMove;
    }
    | {
        type: 'updatePosition';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        update: StaticGalaxyPositionUpdate;
    }
    | {
        type: 'updateNebulaRadius';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        nodeKey: string;
        radius: number;
    }
    | {
        type: 'setHyperlane';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        update: StaticGalaxyHyperlaneUpdate;
    }
    | {
        /** Confirms a chained lane drawing as one WorkspaceEdit (one undo step). */
        type: 'addHyperlanes';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        links: Array<{ fromNodeKey: string; toNodeKey: string }>;
    }
    | {
        /** Deletes the matching add_hyperlane declaration(s) from source. */
        type: 'deleteHyperlane';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        fromNodeKey: string;
        toNodeKey: string;
    }
    | {
        /** Spray stroke: insert new undefined random systems in one edit. */
        type: 'spraySystems';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        scenarioKey: string;
        systems: Array<{ id: string; x: number; y: number }>;
    }
    | {
        /** Erase stroke: delete undefined random systems (no name/initializer). */
        type: 'eraseSystems';
        requestId: string;
        revisionId: string;
        documentVersion: number;
        nodeKeys: string[];
    }
    | { type: 'goToSource'; revisionId: string; nodeKey: string }
    | { type: 'saveDocument' }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'requestWorkshopEdit' }
    | { type: 'copyToWorkspace' };

// ─── Type guards ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isCoordinateInRange(value: number): boolean {
    return Math.abs(value) <= STATIC_GALAXY_MAX_COORDINATE;
}

export function isStaticGalaxyAxis(value: unknown): value is StaticGalaxyAxis {
    if (!isRecord(value) || typeof value.kind !== 'string') return false;
    switch (value.kind) {
        case 'fixed':
            return isFiniteNumber(value.value) && isFiniteNumber(value.center);
        case 'range':
            return isFiniteNumber(value.min) && isFiniteNumber(value.max)
                && isFiniteNumber(value.center) && isFiniteNumber(value.width)
                && typeof value.reversed === 'boolean';
        case 'unresolved':
            return typeof value.raw === 'string' && typeof value.reason === 'string';
        default:
            return false;
    }
}

export function isStaticGalaxyPosition(value: unknown): value is StaticGalaxyPosition {
    if (!isRecord(value)) return false;
    if (!isStaticGalaxyAxis(value.x) || !isStaticGalaxyAxis(value.y)) return false;
    if (value.z !== undefined && !isStaticGalaxyAxis(value.z)) return false;
    return true;
}

export function isStaticGalaxyAxisUpdate(value: unknown): value is StaticGalaxyAxisUpdate {
    if (!isRecord(value) || typeof value.kind !== 'string') return false;
    switch (value.kind) {
        case 'fixed':
            return isFiniteNumber(value.value) && isCoordinateInRange(value.value);
        case 'range':
            return isFiniteNumber(value.min) && isFiniteNumber(value.max)
                && isCoordinateInRange(value.min) && isCoordinateInRange(value.max);
        default:
            return false;
    }
}

export function isStaticGalaxySystemMove(value: unknown): value is StaticGalaxySystemMove {
    if (!isRecord(value)) return false;
    return typeof value.nodeKey === 'string' && value.nodeKey.length > 0
        && isFiniteNumber(value.x) && isFiniteNumber(value.y)
        && isCoordinateInRange(value.x) && isCoordinateInRange(value.y);
}

export function isStaticGalaxyPositionUpdate(value: unknown): value is StaticGalaxyPositionUpdate {
    if (!isRecord(value)) return false;
    if (typeof value.nodeKey !== 'string' || value.nodeKey.length === 0) return false;
    if (value.x === undefined && value.y === undefined && value.z === undefined) return false;
    if (value.x !== undefined && !isStaticGalaxyAxisUpdate(value.x)) return false;
    if (value.y !== undefined && !isStaticGalaxyAxisUpdate(value.y)) return false;
    if (value.z !== undefined && !isStaticGalaxyAxisUpdate(value.z)) return false;
    return true;
}

export function isStaticGalaxyHyperlaneUpdate(value: unknown): value is StaticGalaxyHyperlaneUpdate {
    if (!isRecord(value)) return false;
    return typeof value.fromNodeKey === 'string' && value.fromNodeKey.length > 0
        && typeof value.toNodeKey === 'string' && value.toNodeKey.length > 0
        && value.fromNodeKey !== value.toNodeKey
        && typeof value.connected === 'boolean';
}

interface RequestEnvelope {
    requestId: string;
    revisionId: string;
    documentVersion: number;
}

function isValidRequestEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & RequestEnvelope {
    return typeof value.requestId === 'string' && value.requestId.length > 0
        && typeof value.revisionId === 'string' && value.revisionId.length > 0
        && typeof value.documentVersion === 'number' && Number.isInteger(value.documentVersion);
}

/**
 * Validates an inbound Webview message. Every field is narrowed explicitly;
 * unknown message types and malformed payloads are rejected.
 */
export function parseStaticGalaxyWebviewMessage(input: unknown): StaticGalaxyWebviewMessage | null {
    if (!isRecord(input) || typeof input.type !== 'string') return null;
    switch (input.type) {
        case 'ready':
        case 'saveDocument':
        case 'undo':
        case 'redo':
        case 'requestWorkshopEdit':
        case 'copyToWorkspace':
            return { type: input.type };
        case 'spraySystems': {
            if (!isValidRequestEnvelope(input)) return null;
            if (typeof input.scenarioKey !== 'string' || input.scenarioKey.length === 0) return null;
            if (!Array.isArray(input.systems) || input.systems.length === 0
                || input.systems.length > STATIC_GALAXY_MAX_SPRAY_SYSTEMS) return null;
            const systems: Array<{ id: string; x: number; y: number }> = [];
            const seenIds = new Set<string>();
            for (const sys of input.systems) {
                if (!isRecord(sys)) return null;
                if (typeof sys.id !== 'string' || !/^-?\d+$/.test(sys.id)) return null;
                if (!isFiniteNumber(sys.x) || !isFiniteNumber(sys.y)) return null;
                if (!isCoordinateInRange(sys.x) || !isCoordinateInRange(sys.y)) return null;
                if (seenIds.has(sys.id)) return null;
                seenIds.add(sys.id);
                systems.push({ id: sys.id, x: sys.x, y: sys.y });
            }
            return {
                type: 'spraySystems',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                scenarioKey: input.scenarioKey,
                systems,
            };
        }
        case 'eraseSystems': {
            if (!isValidRequestEnvelope(input)) return null;
            if (!Array.isArray(input.nodeKeys) || input.nodeKeys.length === 0
                || input.nodeKeys.length > STATIC_GALAXY_MAX_SPRAY_SYSTEMS) return null;
            if (!input.nodeKeys.every(k => typeof k === 'string' && k.length > 0)) return null;
            return {
                type: 'eraseSystems',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                nodeKeys: input.nodeKeys as string[],
            };
        }
        case 'goToSource':
            // An empty nodeKey means "open the source" (used by the empty state).
            if (typeof input.revisionId === 'string'
                && typeof input.nodeKey === 'string') {
                return { type: 'goToSource', revisionId: input.revisionId, nodeKey: input.nodeKey };
            }
            return null;
        case 'moveSystems': {
            if (!isValidRequestEnvelope(input)) return null;
            if (!Array.isArray(input.moves)) return null;
            if (input.moves.length === 0 || input.moves.length > STATIC_GALAXY_MAX_MOVES) return null;
            if (!input.moves.every(isStaticGalaxySystemMove)) return null;
            return {
                type: 'moveSystems',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                moves: input.moves,
            };
        }
        case 'moveNebula': {
            if (!isValidRequestEnvelope(input) || !isStaticGalaxySystemMove(input.move)) return null;
            return {
                type: 'moveNebula',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                move: input.move,
            };
        }
        case 'updatePosition': {
            if (!isValidRequestEnvelope(input)) return null;
            if (!isStaticGalaxyPositionUpdate(input.update)) return null;
            return {
                type: 'updatePosition',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                update: input.update,
            };
        }
        case 'updateNebulaRadius': {
            if (!isValidRequestEnvelope(input)) return null;
            if (typeof input.nodeKey !== 'string' || input.nodeKey.length === 0) return null;
            if (!isFiniteNumber(input.radius) || input.radius < 0 || !isCoordinateInRange(input.radius)) return null;
            return {
                type: 'updateNebulaRadius',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                nodeKey: input.nodeKey,
                radius: input.radius,
            };
        }
        case 'setHyperlane': {
            if (!isValidRequestEnvelope(input) || !isStaticGalaxyHyperlaneUpdate(input.update)) return null;
            return {
                type: 'setHyperlane',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                update: input.update,
            };
        }
        case 'addHyperlanes': {
            if (!isValidRequestEnvelope(input)) return null;
            if (!Array.isArray(input.links) || input.links.length === 0 || input.links.length > STATIC_GALAXY_MAX_LANE_LINKS) return null;
            const links: Array<{ fromNodeKey: string; toNodeKey: string }> = [];
            for (const link of input.links) {
                if (!isRecord(link)) return null;
                if (typeof link.fromNodeKey !== 'string' || link.fromNodeKey.length === 0) return null;
                if (typeof link.toNodeKey !== 'string' || link.toNodeKey.length === 0) return null;
                if (link.fromNodeKey === link.toNodeKey) return null;
                links.push({ fromNodeKey: link.fromNodeKey, toNodeKey: link.toNodeKey });
            }
            return {
                type: 'addHyperlanes',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                links,
            };
        }
        case 'deleteHyperlane': {
            if (!isValidRequestEnvelope(input)) return null;
            if (typeof input.fromNodeKey !== 'string' || input.fromNodeKey.length === 0) return null;
            if (typeof input.toNodeKey !== 'string' || input.toNodeKey.length === 0) return null;
            if (input.fromNodeKey === input.toNodeKey) return null;
            return {
                type: 'deleteHyperlane',
                requestId: input.requestId,
                revisionId: input.revisionId,
                documentVersion: input.documentVersion,
                fromNodeKey: input.fromNodeKey,
                toNodeKey: input.toNodeKey,
            };
        }
        default:
            return null;
    }
}
