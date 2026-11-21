/**
 * Shared Wire Protocol & Runtime Validators for the Global Ship Design Workbench.
 *
 * Single source of truth for typed snapshots, edit operations, asset payloads,
 * and inbound Webview-to-Host message validation (`parseShipDesignRequest`).
 */

import type { EnvironmentPreset } from '../webview/environmentTypes';
import {
    fields,
    isArrayOf,
    isBoolean,
    isFiniteNumber,
    isIntegerInRange,
    isOneOf,
    isRecord,
    isString,
    isStringArray,
    optional,
    parseProtocolMessage,
    type MessageValidator,
} from './protocolValidation';

export interface ShipDesignSourceRangeData {
    start: number;
    end: number;
    startLine: number;
    endLine: number;
}

export interface ShipDesignDiagnosticData {
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    designId?: string;
    sectionId?: string;
    slotId?: string;
    source?: ShipDesignSourceRangeData;
}

export interface ShipDesignComponentData {
    id: string;
    slot: string;
    template: string;
    source: ShipDesignSourceRangeData;
}

export interface ShipDesignSectionData {
    id: string;
    designId: string;
    occurrence: number;
    slot: string;
    template: string;
    components: ShipDesignComponentData[];
    source: ShipDesignSourceRangeData;
}

export interface ShipDesignData {
    id: string;
    occurrence: number;
    name: string;
    shipSize?: string;
    graphicalCulture?: string;
    roles?: string;
    sections: ShipDesignSectionData[];
    requiredComponents: string[];
    growthStageCount: number;
    loadoutReadOnlyReason?: string;
    metadata: Record<string, string | boolean>;
    source: ShipDesignSourceRangeData;
}

export interface ShipDesignDocumentSnapshot {
    documentVersion: number;
    generation: number;
    designs: ShipDesignData[];
    selectedDesignId?: string;
    diagnostics: ShipDesignDiagnosticData[];
    dirty: boolean;
    saving: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface ShipDesignStatValue {
    status: 'known' | 'partial' | 'unknown';
    value?: number;
    unit?: string;
    sources: string[];
    unresolved: string[];
}

export interface ShipDesignStatsData {
    designId: string;
    values: Record<string, ShipDesignStatValue>;
    resources: Record<string, ShipDesignStatValue>;
}

export interface ShipDesignIconData {
    key: string;
    uri?: string;
    frame: number;
    frames: number;
    width?: number;
    height?: number;
}

export interface ShipDesignSlotData {
    id: string;
    sectionId: string;
    name: string;
    kind: 'weapon' | 'utility' | 'strike_craft' | 'unknown';
    size: string;
    template: string;
    componentTypes: string[];
    locator?: string;
    fixed: boolean;
    selected?: string;
    icon?: ShipDesignIconData;
    compatible: boolean;
    reasons: string[];
    position?: { x?: number; y?: number; rotation?: number };
}

/** One required (core) component position, keyed by the ship size's `required_component_set`. */
export interface ShipDesignRequiredSlotData {
    id: string;
    componentSet?: string;
    selected?: string;
    icon?: ShipDesignIconData;
    /** True when the slot has a component set, so compatible replacements can be listed. */
    editable: boolean;
}

export interface ShipDesignSectionViewData {
    section: ShipDesignSectionData;
    entity: string;
    shouldDrawComponents: boolean;
    slots: ShipDesignSlotData[];
}

export interface ShipDesignModelNodeData {
    id: string;
    kind: 'root' | 'section' | 'component';
    entityName?: string;
    meshFile?: string;
    parentId?: string;
    locatorName?: string;
    sectionId?: string;
    slotId?: string;
    warnings: string[];
}

export interface ShipDesignViewData {
    designId: string;
    shipSize: string;
    culture: string;
    cultures: string[];
    roles: string[];
    availableSectionSlots: string[];
    sections: ShipDesignSectionViewData[];
    model: ShipDesignModelNodeData[];
    requiredSlots: ShipDesignRequiredSlotData[];
    diagnostics: ShipDesignDiagnosticData[];
    /** Incremented by the Host when cached model resources must be rebuilt from scratch. */
    assetRevision?: number;
}

/**
 * Stable identity of every model node including its ancestry. A changed key means the node and,
 * through the composed parent key, all of its descendants must be rebuilt; unchanged keys are reused.
 */
export function shipDesignModelNodeKeys(model: readonly ShipDesignModelNodeData[]): Map<string, string> {
    const byId = new Map<string, ShipDesignModelNodeData>();
    for (const node of model) if (!byId.has(node.id)) byId.set(node.id, node);
    const keys = new Map<string, string>();
    const resolve = (node: ShipDesignModelNodeData, depth: number): string => {
        const cached = keys.get(node.id);
        if (cached !== undefined) return cached;
        const own = JSON.stringify([
            node.kind, node.entityName ?? '', node.meshFile ?? '', node.locatorName ?? '',
            node.sectionId ?? '', node.slotId ?? '', node.parentId ?? '',
        ]);
        const parent = node.parentId === undefined || depth >= 8 ? undefined : byId.get(node.parentId);
        const key = parent && parent !== node ? own + '>' + resolve(parent, depth + 1) : own;
        keys.set(node.id, key);
        return key;
    };
    for (const node of byId.values()) resolve(node, 0);
    return keys;
}

export type ShipDesignTechnologyScope =
    | { kind: 'all' }
    | { kind: 'starting' }
    | { kind: 'custom'; technologies: string[] };

export interface ShipDesignGenerateOptions {
    role: string;
    technology: ShipDesignTechnologyScope;
    enforcePower: boolean;
}

export type ShipDesignLoadoutSection = {
    slot: string;
    template: string;
    components: Array<{ slot: string; template: string }>;
};

export type ShipDesignOperation =
    | { kind: 'set-field'; designId: string; field: string; value: string | boolean | null }
    | { kind: 'set-section-template'; sectionId: string; template: string }
    | { kind: 'set-component'; sectionId: string; slot: string; template: string | null }
    | { kind: 'drop-component'; sectionId: string; slot: string; template: string }
    | { kind: 'add-section'; designId: string; slot: string; template: string }
    | { kind: 'remove-section'; sectionId: string }
    | { kind: 'set-required-components'; designId: string; components: string[] }
    | { kind: 'set-required-component'; designId: string; slotId: string; template: string }
    | { kind: 'fill-empty-slots'; designId: string; componentKey: string; replaceEquipped?: boolean }
    | { kind: 'replace-loadout'; designId: string; sections: ShipDesignLoadoutSection[]; requiredComponents: string[]; autoGenerated: boolean }
    | { kind: 'create-design'; name: string; shipSize: string; graphicalCulture?: string }
    | { kind: 'duplicate-design'; designId: string; newName: string }
    | { kind: 'delete-design'; designId: string };

const isSourceRange = (value: unknown): boolean => isRecord(value)
    && isIntegerInRange(0, Number.MAX_SAFE_INTEGER)(value.start)
    && isIntegerInRange(0, Number.MAX_SAFE_INTEGER)(value.end)
    && isIntegerInRange(1, Number.MAX_SAFE_INTEGER)(value.startLine)
    && isIntegerInRange(1, Number.MAX_SAFE_INTEGER)(value.endLine);

const isOperation = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.kind !== 'string') return false;
    switch (value.kind) {
        case 'set-field':
            return isString(value.designId) && isString(value.field)
                && (value.value === null || isString(value.value) || isBoolean(value.value));
        case 'set-section-template':
            return isString(value.sectionId) && isString(value.template);
        case 'set-component':
            return isString(value.sectionId) && isString(value.slot)
                && (value.template === null || isString(value.template));
        case 'drop-component':
            return isString(value.sectionId) && isString(value.slot) && isString(value.template);
        case 'add-section':
            return isString(value.designId) && isString(value.slot) && isString(value.template);
        case 'remove-section':
            return isString(value.sectionId);
        case 'set-required-components':
            return isString(value.designId) && isStringArray(value.components);
        case 'set-required-component':
            return isString(value.designId) && isString(value.slotId) && isString(value.template);
        case 'fill-empty-slots':
            return isString(value.designId) && isString(value.componentKey) && optional(isBoolean)(value.replaceEquipped);
        case 'replace-loadout':
            return isString(value.designId) && isBoolean(value.autoGenerated)
                && isStringArray(value.requiredComponents)
                && Array.isArray(value.sections) && value.sections.every(section => isRecord(section)
                    && isString(section.slot) && isString(section.template)
                    && Array.isArray(section.components) && section.components.every(component => isRecord(component)
                        && isString(component.slot) && isString(component.template)));
        case 'create-design':
            return isString(value.name) && isString(value.shipSize) && optional(isString)(value.graphicalCulture);
        case 'duplicate-design':
            return isString(value.designId) && isString(value.newName);
        case 'delete-design':
            return isString(value.designId);
        default:
            return false;
    }
};

const isTechnologyScope = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.kind !== 'string') return false;
    if (value.kind === 'all' || value.kind === 'starting') return true;
    return value.kind === 'custom' && isStringArray(value.technologies);
};

const isGenerateOptions = (value: unknown): boolean => isRecord(value)
    && isString(value.role) && isTechnologyScope(value.technology) && isBoolean(value.enforcePower);

export type ShipDesignRequest =
    | { type: 'ready' }
    | { type: 'select-design'; designId: string }
    | { type: 'open-workspace-design'; uri: string; designId: string }
    | { type: 'set-preview-culture'; culture: string }
    | { type: 'request-slot-candidates'; sectionId: string; slot: string; includeIncompatible: boolean }
    | { type: 'request-section-candidates'; designId: string; sectionSlot: string; includeIncompatible: boolean }
    | { type: 'request-required-candidates'; designId: string; slotId: string }
    | { type: 'request-compatible-slots'; designId: string; componentKey: string }
    | { type: 'apply-operation'; expectedVersion: number; operation: ShipDesignOperation }
    | { type: 'generate-draft'; expectedVersion: number; designId: string; options: ShipDesignGenerateOptions }
    | { type: 'undo' }
    | { type: 'redo' }
    | { type: 'save' }
    | { type: 'discard' }
    | { type: 'open-source'; designId: string; range?: ShipDesignSourceRangeData };

const validators: Record<ShipDesignRequest['type'], MessageValidator> = {
    'ready': fields(),
    'select-design': fields({ designId: isString }),
    'open-workspace-design': fields({ uri: isString, designId: isString }),
    'set-preview-culture': fields({ culture: isString }),
    'request-slot-candidates': fields({ sectionId: isString, slot: isString, includeIncompatible: isBoolean }),
    'request-section-candidates': fields({ designId: isString, sectionSlot: isString, includeIncompatible: isBoolean }),
    'request-required-candidates': fields({ designId: isString, slotId: isString }),
    'request-compatible-slots': fields({ designId: isString, componentKey: isString }),
    'apply-operation': fields({ expectedVersion: isIntegerInRange(0, Number.MAX_SAFE_INTEGER), operation: isOperation }),
    'generate-draft': fields({ expectedVersion: isIntegerInRange(0, Number.MAX_SAFE_INTEGER), designId: isString, options: isGenerateOptions }),
    'undo': fields(),
    'redo': fields(),
    'save': fields(),
    'discard': fields(),
    'open-source': fields({ designId: isString }, { range: isSourceRange }),
};

export function parseShipDesignRequest(input: unknown): ShipDesignRequest | null {
    return parseProtocolMessage<ShipDesignRequest>(input, validators);
}

export interface ShipDesignLocatorAssetData {
    name: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: number;
    parentJoint?: string;
}

export interface ShipDesignMeshSettingAssetData {
    index?: number;
    name?: string;
    textureDiffuse?: string;
    textureNormal?: string;
    textureSpecular?: string;
    shader?: string;
}

export interface ShipDesignEntityAssetData {
    name: string;
    meshUri?: string;
    meshBase64?: string;
    scale?: number;
    locators: ShipDesignLocatorAssetData[];
    meshSettings: ShipDesignMeshSettingAssetData[];
    attaches: Array<{ locatorName: string; entity: ShipDesignEntityAssetData }>;
    textureMap: Record<string, string>;
}

/** A component offered by the library; `tier` is its 1-based position in the `upgrades_to` chain. */
export interface ShipDesignCandidateData {
    key: string;
    label: string;
    compatible: boolean;
    reasons: string[];
    icon?: ShipDesignIconData;
    tier?: number;
    upgradesTo?: string;
    /** Where the definition file resolves: a workspace (mod) root or the vanilla game. */
    origin?: 'vanilla' | 'mod';
}

export type ShipDesignResponse =
    | { type: 'snapshot'; snapshot: ShipDesignDocumentSnapshot }
    | { type: 'document-state'; dirty: boolean; saving: boolean; saved: boolean; canUndo: boolean; canRedo: boolean }
    | { type: 'slot-candidates'; sectionId: string; slot: string; candidates: ShipDesignCandidateData[] }
    | { type: 'section-candidates'; designId: string; sectionSlot: string; candidates: Array<{ key: string; label: string; compatible: boolean; reasons: string[] }> }
    | { type: 'required-candidates'; designId: string; slotId: string; candidates: ShipDesignCandidateData[] }
    /** Slots where the armed component can be placed and would change the loadout. */
    | { type: 'compatible-slots'; designId: string; componentKey: string; slotIds: string[] }
    | { type: 'workspace-designs'; designs: Array<{ uri: string; designId: string; name: string; displayName: string; filePath: string; selected: boolean; current: boolean }> }
    | { type: 'catalog-options'; shipSizes: string[]; roles: string[]; cultures: string[]; technologies: string[]; displayNames: Record<string, string> }
    | { type: 'environments'; presets: EnvironmentPreset[]; workerUri?: string }
    | { type: 'model-asset'; generation: number; nodeId: string; asset?: ShipDesignEntityAssetData; error?: string }
    | { type: 'view'; view: ShipDesignViewData }
    | { type: 'stats'; stats: ShipDesignStatsData }
    | { type: 'generation-explanation'; designId: string; lines: string[] }
    | { type: 'error'; message: string };

export const isShipDesignStatValue = (value: unknown): boolean => isRecord(value)
    && isOneOf(['known', 'partial', 'unknown'] as const)(value.status)
    && optional(isFiniteNumber)(value.value)
    && optional(isString)(value.unit)
    && isArrayOf(isString)(value.sources)
    && isArrayOf(isString)(value.unresolved);
