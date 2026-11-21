/**
 * Ship Design Slot Layout, Compatibility, and Candidate Queries.
 *
 * Pure projection layer that builds section/required slot views, validates
 * size/type/class/restriction drop compatibility, lists ordered candidate
 * tiers, and computes batch fill or replacement operations.
 */

import type {
    ShipDesignData,
    ShipDesignDiagnosticData,
    ShipDesignModelNodeData,
    ShipDesignOperation,
    ShipDesignRequiredSlotData,
    ShipDesignSectionData,
    ShipDesignSlotData,
    ShipDesignViewData,
} from '../../shared/shipDesignProtocol';
import {
    lookupShipDesignComponent,
    lookupShipDesignSection,
    lookupShipDesignSlotTemplate,
    lookupShipSizeInfo,
    type ShipDesignCatalog,
    type ShipDesignComponentDefinition,
    type ShipDesignSectionDefinition,
    type ShipDesignSlotTemplateDefinition,
} from './definitions';

export interface ShipDesignCompatibility {
    compatible: boolean;
    reasons: string[];
}

export interface ShipDesignFillResult {
    operations: ShipDesignOperation[];
    filledSlotIds: string[];
    skipped: Array<{ slotId: string; reasons: string[] }>;
}

function key(value: string): string {
    return value.toLowerCase();
}

function includes(values: readonly string[], value: string | undefined): boolean {
    return value !== undefined && values.some(candidate => key(candidate) === key(value));
}

function compareNames(left: string, right: string): number {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function equippedComponents(design: ShipDesignData): Array<{ key: string; componentId: string; sectionId: string; slot: string }> {
    return design.sections.flatMap(section => section.components.map(component => ({
        key: component.template,
        componentId: component.id,
        sectionId: section.id,
        slot: component.slot,
    })));
}

export function shipDesignComponentCompatibility(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    slot: ShipDesignSlotData,
    component: ShipDesignComponentDefinition,
): ShipDesignCompatibility {
    const reasons: string[] = [];
    const typeMatches = slot.componentTypes.some(type => key(type) === 'any')
        || slot.componentTypes.some(type => key(type) === key(component.kind));
    if (!typeMatches) reasons.push('Component type ' + component.kind + ' does not fit ' + slot.kind + ' slot.');
    if (slot.size !== 'any' && key(slot.size) !== key(component.size)) {
        reasons.push('Component size ' + component.size + ' does not fit ' + slot.size + ' slot.');
    }
    if (component.hidden) reasons.push('Component is hidden.');

    const shipSize = lookupShipSizeInfo(catalog, design.shipSize ?? '');
    if (component.classRestrictions.length > 0 && !includes(component.classRestrictions, shipSize?.shipClass)) {
        reasons.push('Ship class ' + (shipSize?.shipClass ?? 'unknown') + ' is not allowed.');
    }
    if (component.sizeRestrictions.length > 0 && !includes(component.sizeRestrictions, design.shipSize)) {
        reasons.push('Ship size ' + (design.shipSize ?? 'unknown') + ' is not allowed.');
    }

    const equipped = equippedComponents(design);
    const current = equipped.find(other => other.sectionId === slot.sectionId && key(other.slot) === key(slot.name));
    for (const other of equipped) {
        if (other.componentId === current?.componentId) continue;
        if (includes(component.blockedBy, other.key)) reasons.push('Blocked by equipped ' + other.key + '.');
        const otherDefinition = lookupShipDesignComponent(catalog, other.key);
        if (otherDefinition && includes(otherDefinition.blockedBy, component.key)) {
            reasons.push('Blocks equipped ' + other.key + '.');
        }
    }
    const limit = component.shipLimit?.value;
    if (limit !== undefined) {
        const count = equipped.filter(other => key(other.key) === key(component.key) && other.componentId !== current?.componentId).length;
        if (count >= limit) reasons.push('Ship limit ' + limit + ' is already reached.');
    }
    return { compatible: reasons.length === 0, reasons };
}

export function shipDesignDropCompatibility(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    slot: ShipDesignSlotData,
    component: ShipDesignComponentDefinition,
): ShipDesignCompatibility {
    if (slot.fixed) return { compatible: false, reasons: ['Component slot is fixed.'] };
    return shipDesignComponentCompatibility(catalog, design, slot, component);
}

function utilitySlot(size: 'small' | 'medium' | 'large' | 'aux', index: number): ShipDesignSlotTemplateDefinition {
    return {
        key: 'utility',
        size,
        componentTypes: ['utility'],
        fixed: false,
        entities: {},
    };
}

function viewForSlot(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    section: ShipDesignSectionData,
    index: number,
    name: string,
    template: ShipDesignSlotTemplateDefinition,
    locator?: string,
    position?: ShipDesignSlotData['position'],
): ShipDesignSlotData {
    const id = section.id + '/slot:' + index;
    const selected = section.components.find(component => key(component.slot) === key(name))?.template;
    const definition = selected ? lookupShipDesignComponent(catalog, selected) : undefined;
    const slot: ShipDesignSlotData = {
        id,
        sectionId: section.id,
        name,
        kind: template.key === 'utility'
            ? 'utility'
            : template.componentTypes.includes('strike_craft') && !template.componentTypes.includes('weapon')
                ? 'strike_craft'
                : 'weapon',
        size: template.size,
        template: template.key,
        componentTypes: template.componentTypes,
        locator,
        fixed: template.fixed,
        selected,
        compatible: true,
        reasons: [],
        position,
    };
    if (selected && !definition) {
        slot.compatible = false;
        slot.reasons.push('Unknown component ' + selected + '.');
    } else if (definition) {
        const compatibility = shipDesignComponentCompatibility(catalog, design, slot, definition);
        slot.compatible = compatibility.compatible;
        slot.reasons = compatibility.reasons;
    }
    return slot;
}

export function buildShipDesignSectionSlots(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    section: ShipDesignSectionData,
): ShipDesignSlotData[] {
    const definition = lookupShipDesignSection(catalog, section.template);
    if (!definition) return [];
    const slots: ShipDesignSlotData[] = [];
    for (const componentSlot of definition.componentSlots) {
        const template = lookupShipDesignSlotTemplate(catalog, componentSlot.template);
        if (!template) continue;
        slots.push(viewForSlot(catalog, design, section, slots.length, componentSlot.name, template, componentSlot.locator, {
            x: componentSlot.position?.x?.value,
            y: componentSlot.position?.y?.value,
            rotation: componentSlot.rotation?.value,
        }));
    }
    for (const size of ['small', 'medium', 'large', 'aux'] as const) {
        const count = Math.max(0, Math.floor(definition.utilitySlots[size]));
        for (let index = 1; index <= count; index++) {
            const name = size.toUpperCase() + '_UTILITY_' + index;
            slots.push(viewForSlot(catalog, design, section, slots.length, name, utilitySlot(size, index)));
        }
    }
    return slots;
}

export function shipDesignSectionCompatibility(
    section: ShipDesignSectionDefinition,
    shipSize: string,
    sectionSlot: string,
): ShipDesignCompatibility {
    const reasons: string[] = [];
    if (!section.compatibleWithAllShipSizes && section.shipSizes.length > 0 && !includes(section.shipSizes, shipSize)) {
        reasons.push('Section does not support ship size ' + shipSize + '.');
    }
    if (!includes(section.fitsOnSlots, sectionSlot)) reasons.push('Section does not fit ' + sectionSlot + '.');
    return { compatible: reasons.length === 0, reasons };
}

export function shipDesignSectionCandidates(
    catalog: ShipDesignCatalog,
    shipSize: string,
    sectionSlot: string,
    includeIncompatible = false,
): Array<{ section: ShipDesignSectionDefinition; compatibility: ShipDesignCompatibility }> {
    const result: Array<{ section: ShipDesignSectionDefinition; compatibility: ShipDesignCompatibility }> = [];
    for (const section of catalog.sections.values()) {
        const compatibility = shipDesignSectionCompatibility(section, shipSize, sectionSlot);
        if (includeIncompatible || compatibility.compatible) result.push({ section, compatibility });
    }
    return result.sort((left, right) => compareNames(left.section.key, right.section.key));
}

export function shipDesignComponentCandidates(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    slot: ShipDesignSlotData,
    includeIncompatible = false,
): Array<{ component: ShipDesignComponentDefinition; compatibility: ShipDesignCompatibility }> {
    const result: Array<{ component: ShipDesignComponentDefinition; compatibility: ShipDesignCompatibility }> = [];
    for (const component of catalog.components.values()) {
        const compatibility = shipDesignComponentCompatibility(catalog, design, slot, component);
        if (includeIncompatible || compatibility.compatible) result.push({ component, compatibility });
    }
    return result.sort((left, right) => compareNames(left.component.key, right.component.key));
}

/**
 * Required component positions: one per ship-size `required_component_set` (in declaration order),
 * then any remaining `required_component` entries. Slot IDs are stable for a given design source.
 */
export function buildShipDesignRequiredSlots(catalog: ShipDesignCatalog, design: ShipDesignData): ShipDesignRequiredSlotData[] {
    const details = catalog.shipSizeDetails.get(key(design.shipSize ?? ''));
    const remaining = design.requiredComponents.map(value => ({ key: value, set: lookupShipDesignComponent(catalog, value)?.componentSet }));
    const slots: ShipDesignRequiredSlotData[] = [];
    for (const set of details?.requiredComponentSets ?? []) {
        if (slots.some(slot => slot.componentSet !== undefined && key(slot.componentSet) === key(set))) continue;
        const index = remaining.findIndex(entry => entry.set !== undefined && key(entry.set) === key(set));
        const selected = index >= 0 ? remaining.splice(index, 1)[0]?.key : undefined;
        slots.push({ id: 'required:set:' + key(set), componentSet: set, selected, editable: true });
    }
    remaining.forEach((entry, index) => slots.push({
        id: 'required:extra:' + index,
        componentSet: entry.set,
        selected: entry.key,
        editable: entry.set !== undefined,
    }));
    return slots;
}

export function shipDesignRequiredCompatibility(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    slot: ShipDesignRequiredSlotData,
    component: ShipDesignComponentDefinition,
): ShipDesignCompatibility {
    const reasons: string[] = [];
    if (!slot.componentSet || key(component.componentSet ?? '') !== key(slot.componentSet)) {
        reasons.push('Component set ' + (component.componentSet ?? '(none)') + ' does not match ' + (slot.componentSet ?? '(none)') + '.');
    }
    if (component.hidden) reasons.push('Component is hidden.');
    const shipSize = lookupShipSizeInfo(catalog, design.shipSize ?? '');
    if (component.classRestrictions.length > 0 && !includes(component.classRestrictions, shipSize?.shipClass)) {
        reasons.push('Ship class ' + (shipSize?.shipClass ?? 'unknown') + ' is not allowed.');
    }
    if (component.sizeRestrictions.length > 0 && !includes(component.sizeRestrictions, design.shipSize)) {
        reasons.push('Ship size ' + (design.shipSize ?? 'unknown') + ' is not allowed.');
    }
    return { compatible: reasons.length === 0, reasons };
}

export function shipDesignRequiredCandidates(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    slot: ShipDesignRequiredSlotData,
): ShipDesignComponentDefinition[] {
    if (!slot.componentSet) return [];
    return [...catalog.components.values()]
        .filter(component => shipDesignRequiredCompatibility(catalog, design, slot, component).compatible)
        .sort((left, right) => compareNames(left.key, right.key));
}

/** Replaces the slot's current component (or appends one for an empty set) in the required list. */
export function replaceShipDesignRequiredComponent(
    design: ShipDesignData,
    slot: ShipDesignRequiredSlotData,
    template: string,
): string[] {
    const components = [...design.requiredComponents];
    const index = slot.selected === undefined ? -1 : components.findIndex(value => key(value) === key(slot.selected ?? ''));
    if (index >= 0) components[index] = template;
    else components.push(template);
    return components;
}

interface ResolvedEntity {
    entityName: string;
    meshFile?: string;
    warning?: string;
}

function entityEntry(catalog: ShipDesignCatalog, name: string): { name: string; pdxmesh?: string } | undefined {
    const folded = key(name);
    for (const [candidate, pdxmesh] of catalog.base.entityToPdxMesh) {
        if (key(candidate) === folded) return { name: candidate, pdxmesh };
    }
    return undefined;
}

function meshFile(catalog: ShipDesignCatalog, pdxmesh: string | undefined): string | undefined {
    if (!pdxmesh) return undefined;
    const folded = key(pdxmesh);
    for (const [candidate, file] of catalog.base.pdxMeshToFile) {
        if (key(candidate) === folded) return file;
    }
    return undefined;
}

export function resolveShipDesignCultureEntity(
    catalog: ShipDesignCatalog,
    culture: string,
    requested: string,
): ResolvedEntity {
    if (!requested) return { entityName: '', warning: 'No entity was specified.' };
    const candidates = culture ? [culture + '_' + requested, requested] : [requested];
    for (const candidate of candidates) {
        const entry = entityEntry(catalog, candidate);
        if (entry) return { entityName: entry.name, meshFile: meshFile(catalog, entry.pdxmesh) };
    }
    return {
        entityName: requested,
        warning: 'Entity ' + candidates.join(' or ') + ' was not found.',
    };
}

function modelNode(
    id: string,
    kind: ShipDesignModelNodeData['kind'],
    entity: ResolvedEntity,
    extra: Partial<ShipDesignModelNodeData> = {},
): ShipDesignModelNodeData {
    return {
        id,
        kind,
        entityName: entity.entityName || undefined,
        meshFile: entity.meshFile,
        warnings: entity.warning ? [entity.warning] : [],
        ...extra,
    };
}

export function buildShipDesignView(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    previewCulture?: string,
): ShipDesignViewData {
    const diagnostics: ShipDesignDiagnosticData[] = [];
    const cultures = [...catalog.base.graphicalCultures].sort(compareNames);
    const culture = previewCulture || design.graphicalCulture
        || (cultures.includes('humanoid_01') ? 'humanoid_01' : cultures[0] ?? '');
    const shipSize = design.shipSize ?? '';
    const shipInfo = lookupShipSizeInfo(catalog, shipSize);
    if (!shipInfo) diagnostics.push({
        severity: 'warning',
        code: 'unknown-ship-size',
        message: 'Unknown ship size ' + (shipSize || '(missing)') + '.',
        designId: design.id,
    });
    const hasRootEntity = Boolean(shipInfo?.entity);
    const rootEntity: ResolvedEntity = hasRootEntity
        ? resolveShipDesignCultureEntity(catalog, culture, shipInfo?.entity ?? '')
        : { entityName: '' };
    const root = modelNode('root', 'root', rootEntity, {
        warnings: [
            ...rootEntity.warning ? [rootEntity.warning] : [],
            ...shipInfo && (hasRootEntity || design.sections.length > 0)
                ? [] : ['Ship size has neither a root entity nor visible sections.'],
        ],
    });
    const model: ShipDesignModelNodeData[] = [root];
    const sections = [];

    for (const section of design.sections) {
        const definition = lookupShipDesignSection(catalog, section.template);
        if (!definition) {
            diagnostics.push({
                severity: 'warning',
                code: 'unknown-section',
                message: 'Unknown section template ' + section.template + '.',
                designId: design.id,
                sectionId: section.id,
                source: section.source,
            });
            sections.push({ section, entity: '', shouldDrawComponents: false, slots: [] });
            continue;
        }
        const compatibility = shipDesignSectionCompatibility(definition, shipSize, section.slot);
        if (!compatibility.compatible) diagnostics.push({
            severity: 'warning',
            code: 'incompatible-section',
            message: compatibility.reasons.join(' '),
            designId: design.id,
            sectionId: section.id,
            source: section.source,
        });
        const slots = buildShipDesignSectionSlots(catalog, design, section);
        for (const slot of slots) {
            if (!slot.compatible) diagnostics.push({
                severity: 'warning',
                code: 'incompatible-component',
                message: slot.name + ': ' + slot.reasons.join(' '),
                designId: design.id,
                sectionId: section.id,
                slotId: slot.id,
            });
        }
        sections.push({
            section,
            entity: definition.entity,
            shouldDrawComponents: definition.shouldDrawComponents,
            slots,
        });

        const sectionEntity = resolveShipDesignCultureEntity(catalog, culture, definition.entity);
        const sectionLocator = hasRootEntity
            ? shipInfo?.sectionSlots.find(candidate => key(candidate.slot) === key(section.slot))?.locator
            : undefined;
        const warnings = [...sectionEntity.warning ? [sectionEntity.warning] : []];
        if (hasRootEntity && !sectionLocator) warnings.push('No root locator is defined for section slot ' + section.slot + '.');
        model.push(modelNode(section.id, 'section', sectionEntity, {
            parentId: 'root',
            locatorName: sectionLocator,
            sectionId: section.id,
            warnings,
        }));
        if (!definition.shouldDrawComponents) continue;

        for (const slot of slots) {
            if (!slot.selected || slot.kind === 'utility') continue;
            const component = lookupShipDesignComponent(catalog, slot.selected);
            if (!component) continue;
            const template = lookupShipDesignSlotTemplate(catalog, slot.template);
            const requestedEntity = component.weaponType && template
                ? template.entities[key(component.weaponType)]
                : undefined;
            if (!requestedEntity) {
                diagnostics.push({
                    severity: 'info',
                    code: 'component-entity-unavailable',
                    message: 'No visible entity mapping for ' + component.key + ' in ' + slot.name + '.',
                    designId: design.id,
                    sectionId: section.id,
                    slotId: slot.id,
                });
                continue;
            }
            const componentEntity = resolveShipDesignCultureEntity(catalog, culture, requestedEntity);
            const warnings = [...componentEntity.warning ? [componentEntity.warning] : []];
            if (!slot.locator) warnings.push('No component locator is defined for ' + slot.name + '.');
            model.push(modelNode(slot.id, 'component', componentEntity, {
                parentId: section.id,
                locatorName: slot.locator,
                sectionId: section.id,
                slotId: slot.id,
                warnings,
            }));
        }
    }

    for (const node of model) {
        for (const warning of node.warnings) diagnostics.push({
            severity: 'warning',
            code: 'model-resolution',
            message: warning,
            designId: design.id,
            sectionId: node.sectionId,
            slotId: node.slotId,
        });
    }
    return {
        designId: design.id,
        shipSize,
        culture,
        cultures,
        roles: catalog.roles,
        availableSectionSlots: shipInfo?.sectionSlots.map(slot => slot.slot) ?? [],
        sections,
        model,
        requiredSlots: buildShipDesignRequiredSlots(catalog, design),
        diagnostics,
    };
}

export function fillShipDesignEmptySlots(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    componentKey: string,
): ShipDesignFillResult {
    return fillShipDesignSlots(catalog, design, componentKey, { replaceEquipped: false });
}

/**
 * Equips one component in every compatible slot. Slots are filled in order against a working copy,
 * so ship limits and blocked-by rules see the components placed earlier in the same fill.
 * Fixed slots are never touched; equipped slots are replaced only when `replaceEquipped` is set.
 */
export function fillShipDesignSlots(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    componentKey: string,
    options: { replaceEquipped: boolean },
): ShipDesignFillResult {
    const component = lookupShipDesignComponent(catalog, componentKey);
    if (!component) return {
        operations: [],
        filledSlotIds: [],
        skipped: [{ slotId: '', reasons: ['Unknown component ' + componentKey + '.'] }],
    };
    const operations: ShipDesignOperation[] = [];
    const filledSlotIds: string[] = [];
    const skipped: Array<{ slotId: string; reasons: string[] }> = [];
    const working: ShipDesignData = { ...design, sections: design.sections.map(section => ({ ...section, components: section.components.map(item => ({ ...item })) })) };
    const view = buildShipDesignView(catalog, design);
    for (const section of view.sections) {
        const workingSection = working.sections.find(candidate => candidate.id === section.section.id);
        for (const slot of section.slots) {
            if (slot.selected && (!options.replaceEquipped || key(slot.selected) === key(component.key))) continue;
            const compatibility = shipDesignDropCompatibility(catalog, working, slot, component);
            if (!compatibility.compatible) {
                skipped.push({ slotId: slot.id, reasons: compatibility.reasons });
                continue;
            }
            operations.push({
                kind: 'set-component',
                sectionId: section.section.id,
                slot: slot.name,
                template: component.key,
            });
            filledSlotIds.push(slot.id);
            const existing = workingSection?.components.find(item => key(item.slot) === key(slot.name));
            if (existing) existing.template = component.key;
            else workingSection?.components.push({ id: slot.id + '/fill', slot: slot.name, template: component.key, source: section.section.source });
        }
    }
    return { operations, filledSlotIds, skipped };
}

/** Slot IDs where `component` passes drop validation and is not already equipped. */
export function shipDesignPlaceableSlotIds(
    catalog: ShipDesignCatalog,
    design: ShipDesignData,
    component: ShipDesignComponentDefinition,
): string[] {
    return buildShipDesignView(catalog, design).sections
        .flatMap(section => section.slots)
        .filter(slot => !(slot.selected && key(slot.selected) === key(component.key))
            && shipDesignDropCompatibility(catalog, design, slot, component).compatible)
        .map(slot => slot.id);
}

const componentTierCache = new WeakMap<ShipDesignCatalog, Map<string, number>>();

/** 1-based depth of each component in its `upgrades_to` chain; cycles and very long chains are bounded. */
export function shipDesignComponentTiers(catalog: ShipDesignCatalog): Map<string, number> {
    const cached = componentTierCache.get(catalog);
    if (cached) return cached;
    const predecessors = new Map<string, string[]>();
    for (const component of catalog.components.values()) {
        if (!component.upgradesTo) continue;
        const target = key(component.upgradesTo);
        const list = predecessors.get(target) ?? [];
        list.push(key(component.key));
        predecessors.set(target, list);
    }
    const tiers = new Map<string, number>();
    const resolve = (name: string, depth: number): number => {
        const known = tiers.get(name);
        if (known !== undefined) return known;
        if (depth >= 32) return 1;
        const tier = 1 + Math.max(0, ...(predecessors.get(name) ?? []).map(previous => resolve(previous, depth + 1)));
        tiers.set(name, tier);
        return tier;
    };
    for (const component of catalog.components.values()) resolve(key(component.key), 0);
    componentTierCache.set(catalog, tiers);
    return tiers;
}
