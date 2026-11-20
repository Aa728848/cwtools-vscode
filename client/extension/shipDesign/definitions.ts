import {
    loadShipIconCatalog,
    type ShipIconCatalog,
    type ShipIconDataSource,
    type ShipSizeInfo,
} from '../shipIcon/shipIconDefinitions';
import { parseTechFile, type TechNode } from '../techTreeParser';
import {
    buildInlineScriptRegistry,
    expandInlineScriptFields,
    extractTargetingFields,
    normalizeInlineScriptKey,
    parseInlineScriptTemplate,
    resolveInlineText,
    evaluateInlineExpression,
    type ExtractedWeaponTargeting,
    type InlineScriptSourceGroup,
    type InlineScriptTemplate,
} from '../ai/targetWeightExtract';
import {
    collectDefinitionItemsDeep,
    definitionBlocks,
    definitionBoolean,
    definitionItems,
    definitionNumber,
    definitionNumericFields,
    definitionScalars,
    definitionString,
    firstDefinitionBlock,
    firstDefinitionScalar,
    mergeDefinitionVariables,
    parseDefinitionFile,
    type DefinitionBlock,
    type DefinitionNode,
    type DefinitionNumber,
} from './definitionNodes';

export interface ShipDesignResourceData {
    category?: string;
    cost: Record<string, DefinitionNumber>;
    upkeep: Record<string, DefinitionNumber>;
}

export interface ShipDesignAiWeightData {
    base: number;
    dynamic: boolean;
}

export interface ShipDesignComponentSlotData {
    name: string;
    template: string;
    locator?: string;
    rotation?: DefinitionNumber;
    position?: { x?: DefinitionNumber; y?: DefinitionNumber };
    side: boolean;
}

export interface ShipDesignSectionDefinition {
    key: string;
    shipSizes: string[];
    fitsOnSlots: string[];
    entity: string;
    shouldDrawComponents: boolean;
    compatibleWithAllShipSizes: boolean;
    componentSlots: ShipDesignComponentSlotData[];
    utilitySlots: Record<'small' | 'medium' | 'large' | 'aux', number>;
    aiTags: string[];
    aiWeight: ShipDesignAiWeightData;
    prerequisites: string[];
    resources?: ShipDesignResourceData;
    modifier: Record<string, DefinitionNumber>;
    shipModifier: Record<string, DefinitionNumber>;
}

export interface ShipDesignSlotTemplateDefinition {
    key: string;
    size: string;
    componentTypes: string[];
    fixed: boolean;
    entities: Record<string, string>;
}

export interface ShipDesignDamageData {
    accuracy?: DefinitionNumber;
    min?: DefinitionNumber;
    max?: DefinitionNumber;
}

export interface ShipDesignComponentDefinition {
    key: string;
    kind: 'weapon' | 'utility' | 'strike_craft' | 'unknown';
    size: string;
    weaponType?: string;
    componentSet?: string;
    icon?: string;
    iconFrame?: number;
    /** Game-root-relative file that defined the component, used to tell vanilla from mod content. */
    sourceFile?: string;
    prerequisites: string[];
    upgradesTo?: string;
    hidden: boolean;
    shouldAiUse: boolean;
    aiTags: string[];
    aiTagWeight: number;
    aiWeight: ShipDesignAiWeightData;
    classRestrictions: string[];
    sizeRestrictions: string[];
    blockedBy: string[];
    shipLimit?: DefinitionNumber;
    dynamicPotential: boolean;
    power?: DefinitionNumber;
    buildTime?: DefinitionNumber;
    sensorRange?: DefinitionNumber;
    resources?: ShipDesignResourceData;
    modifier: Record<string, DefinitionNumber>;
    shipModifier: Record<string, DefinitionNumber>;
    damage?: ShipDesignDamageData;
}

export interface ShipDesignSizeDetails {
    key: string;
    icon?: string;
    entity?: string;
    shipClass?: string;
    sectionSlots: Array<{ slot: string; locator: string }>;
    graphicalCultures: string[];
    maxHitpoints?: DefinitionNumber;
    maxSpeed?: DefinitionNumber;
    baseBuildtime?: DefinitionNumber;
    modifier: Record<string, DefinitionNumber>;
    shipModifier: Record<string, DefinitionNumber>;
    resources?: ShipDesignResourceData;
    requiredComponentSets: string[];
    shipRoles: string[];
    prerequisites: string[];
}

export interface ShipDesignComponentSetDefinition {
    key: string;
    required: boolean;
    core: boolean;
}

export interface ShipDesignCatalog {
    base: ShipIconCatalog;
    sections: Map<string, ShipDesignSectionDefinition>;
    slotTemplates: Map<string, ShipDesignSlotTemplateDefinition>;
    components: Map<string, ShipDesignComponentDefinition>;
    componentSets: Map<string, ShipDesignComponentSetDefinition>;
    shipSizeDetails: Map<string, ShipDesignSizeDetails>;
    technologies: Map<string, TechNode>;
    technologyPrerequisites: Map<string, string[]>;
    roles: string[];
    variables: Map<string, number>;
    warnings: string[];
}

interface SourceFile {
    path: string;
    content: string;
    fields: DefinitionNode[];
    variables: Map<string, number>;
}

const MAX_DIRECTORY_VISITS = 4000;
const DIRECTORIES = [
    'common/scripted_variables',
    'common/ship_sizes',
    'common/section_templates',
    'common/inline_scripts',
    'common/component_slot_templates',
    'common/component_templates',
    'common/component_sets',
    'common/technology',
] as const;

type DirectoryName = typeof DIRECTORIES[number];

function key(value: string): string {
    return value.toLowerCase();
}

function comparePaths(left: string, right: string): number {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

async function collectFiles(source: ShipIconDataSource, directory: string, warnings: string[]): Promise<string[]> {
    const result: string[] = [];
    const queue = [directory];
    const visited = new Set<string>();
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        const folded = key(current);
        if (visited.has(folded)) continue;
        visited.add(folded);
        if (visited.size > MAX_DIRECTORY_VISITS) {
            warnings.push('Directory scan limit reached while loading ' + directory);
            break;
        }
        for (const path of await source.listFiles(current)) {
            if (/\.(?:txt|csv)$/i.test(path)) result.push(path);
            else queue.push(path);
        }
    }
    return result.sort(comparePaths);
}

async function readFiles(source: ShipIconDataSource, paths: readonly string[]): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    for (const path of paths) {
        const content = await source.readText(path);
        if (content === undefined) continue;
        const parsed = parseDefinitionFile(content);
        files.push({ path, content, fields: parsed.fields, variables: parsed.variables });
    }
    return files;
}

function emptyResources(): ShipDesignResourceData {
    return { cost: {}, upkeep: {} };
}

function parseResources(fields: readonly DefinitionNode[]): ShipDesignResourceData | undefined {
    const resources = firstDefinitionBlock(fields, 'resources');
    if (!resources) return undefined;
    const result = emptyResources();
    result.category = definitionString(resources.fields, 'category');
    const cost = firstDefinitionBlock(resources.fields, 'cost');
    const upkeep = firstDefinitionBlock(resources.fields, 'upkeep');
    if (cost) result.cost = definitionNumericFields(cost.fields, new Map());
    if (upkeep) result.upkeep = definitionNumericFields(upkeep.fields, new Map());
    return result;
}

function resolveResources(resources: ShipDesignResourceData | undefined, variables: ReadonlyMap<string, number>): ShipDesignResourceData | undefined {
    if (!resources) return undefined;
    const resolve = (values: Record<string, DefinitionNumber>): Record<string, DefinitionNumber> => {
        const result: Record<string, DefinitionNumber> = {};
        for (const [name, number] of Object.entries(values)) {
            result[name] = { raw: number.raw, value: number.value ?? variables.get(key(number.raw)) };
        }
        return result;
    };
    return { category: resources.category, cost: resolve(resources.cost), upkeep: resolve(resources.upkeep) };
}

function parseAiWeight(fields: readonly DefinitionNode[], variables: ReadonlyMap<string, number>): ShipDesignAiWeightData {
    const block = firstDefinitionBlock(fields, 'ai_weight');
    if (!block) return { base: 0, dynamic: false };
    const weight = definitionNumber(block.fields, 'weight', variables)
        ?? definitionNumber(block.fields, 'factor', variables);
    const dynamic = block.fields.some(field => field.kind === 'block')
        || block.fields.some(field => field.kind === 'scalar' && !['weight', 'factor'].includes(key(field.key)));
    return { base: weight?.value ?? 0, dynamic };
}

function parseModifier(fields: readonly DefinitionNode[], name: string, variables: ReadonlyMap<string, number>): Record<string, DefinitionNumber> {
    const block = firstDefinitionBlock(fields, name);
    return block ? definitionNumericFields(block.fields, variables) : {};
}

function parseSection(block: DefinitionBlock, variables: ReadonlyMap<string, number>): ShipDesignSectionDefinition | undefined {
    const sectionKey = definitionString(block.fields, 'key');
    if (!sectionKey) return undefined;
    const utility = {
        small: definitionNumber(block.fields, 'small_utility_slots', variables)?.value ?? 0,
        medium: definitionNumber(block.fields, 'medium_utility_slots', variables)?.value ?? 0,
        large: definitionNumber(block.fields, 'large_utility_slots', variables)?.value ?? 0,
        aux: definitionNumber(block.fields, 'aux_utility_slots', variables)?.value ?? 0,
    };
    const componentSlots: ShipDesignComponentSlotData[] = [];
    for (const slot of definitionBlocks(block.fields, 'component_slot')) {
        const name = definitionString(slot.fields, 'name');
        const template = definitionString(slot.fields, 'template');
        if (!name || !template) continue;
        const position = firstDefinitionBlock(slot.fields, 'position');
        componentSlots.push({
            name,
            template,
            locator: definitionString(slot.fields, 'locatorname'),
            rotation: definitionNumber(slot.fields, 'rotation', variables),
            position: position ? {
                x: definitionNumber(position.fields, 'x', variables),
                y: definitionNumber(position.fields, 'y', variables),
            } : undefined,
            side: definitionBoolean(slot.fields, 'is_side_slot') ?? false,
        });
    }
    return {
        key: sectionKey,
        shipSizes: definitionScalars(block.fields, 'ship_size').map(value => value.value),
        fitsOnSlots: definitionScalars(block.fields, 'fits_on_slot').map(value => value.value),
        entity: definitionString(block.fields, 'entity') ?? '',
        shouldDrawComponents: definitionBoolean(block.fields, 'should_draw_components') ?? true,
        compatibleWithAllShipSizes: definitionBoolean(block.fields, 'compatible_with_all_ship_sizes') ?? false,
        componentSlots,
        utilitySlots: utility,
        aiTags: definitionItems(firstDefinitionBlock(block.fields, 'ai_tags')),
        aiWeight: parseAiWeight(block.fields, variables),
        prerequisites: collectDefinitionItemsDeep(firstDefinitionBlock(block.fields, 'prerequisites')),
        resources: resolveResources(parseResources(block.fields), variables),
        modifier: parseModifier(block.fields, 'modifier', variables),
        shipModifier: parseModifier(block.fields, 'ship_modifier', variables),
    };
}

function parseSlotTemplate(block: DefinitionBlock): ShipDesignSlotTemplateDefinition | undefined {
    const size = definitionString(block.fields, 'size');
    const componentTypes = definitionScalars(block.fields, 'component').map(value => value.value);
    if (!size || componentTypes.length === 0) return undefined;
    const entities: Record<string, string> = {};
    const entityBlock = firstDefinitionBlock(block.fields, 'entities');
    if (entityBlock) {
        for (const field of entityBlock.fields) {
            if (field.kind === 'scalar') entities[key(field.key)] = field.value;
        }
    }
    return {
        key: block.key,
        size,
        componentTypes,
        fixed: definitionBoolean(block.fields, 'is_fixed') ?? false,
        entities,
    };
}

function parseCsvPower(content: string): Map<string, number> {
    const result = new Map<string, number>();
    let columns: string[] | undefined;
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const cells = line.split(';').map(cell => cell.trim());
        const name = (cells[0] ?? '').replace(/^"|"$/g, '');
        if (name === 'key') {
            columns = cells;
            continue;
        }
        if (!columns || !name) continue;
        const powerIndex = columns.indexOf('power');
        if (powerIndex < 0) continue;
        const value = Number.parseFloat(cells[powerIndex] ?? '');
        if (Number.isFinite(value) && !result.has(key(name))) result.set(key(name), value);
    }
    return result;
}

function componentKind(rootKey: string): ShipDesignComponentDefinition['kind'] {
    const folded = key(rootKey);
    if (folded.includes('weapon_component')) return 'weapon';
    if (folded.includes('utility_component')) return 'utility';
    if (folded.includes('strike_craft_component')) return 'strike_craft';
    return 'unknown';
}

function parseInlineGeneralFields(text: string): Map<string, string> {
    const fields = new Map<string, string>();
    let depth = 0;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        const match = /^([A-Za-z_][\w.]*)\s*=\s*(.+)$/.exec(line);
        if (depth === 0 && match) {
            const field = match[1]?.toLowerCase();
            const value = match[2]?.trim();
            if (field && value && !value.endsWith('{') && !fields.has(field)) fields.set(field, value);
        }
        for (const ch of line) {
            if (ch === '{') depth++;
            else if (ch === '}') depth = Math.max(0, depth - 1);
        }
    }
    return fields;
}

interface InlineComponentDetails {
    size?: string;
    icon?: string;
    componentSet?: string;
    power?: DefinitionNumber;
}

function resolveInlineComponentDetails(
    entry: ExtractedWeaponTargeting,
    registry: ReadonlyMap<string, InlineScriptTemplate>,
    fieldRegistry: ReadonlyMap<string, ReadonlyMap<string, string>>,
    variables: ReadonlyMap<string, number>,
): InlineComponentDetails {
    const call = entry.inlineCalls?.[0];
    if (!call) return {};
    const template = registry.get(call.script);
    const fields = fieldRegistry.get(call.script) ?? new Map<string, string>();
    const inlineText = (field: string): string | undefined =>
        resolveInlineText(fields.get(field) ?? template?.bindings.get(field), call.params);
    const rawPower = fields.get('power') ?? template?.bindings.get('power');
    const power = rawPower === undefined ? undefined : evaluateInlineExpression(rawPower, call.params, variables);
    return {
        size: inlineText('size'),
        icon: inlineText('icon'),
        componentSet: inlineText('component_set'),
        power: power === undefined ? undefined : { raw: rawPower ?? '', value: power },
    };
}

function parseComponent(
    block: DefinitionBlock,
    variables: ReadonlyMap<string, number>,
    inlineKey?: string,
    inlineDetails?: InlineComponentDetails,
): ShipDesignComponentDefinition | undefined {
    const componentKey = inlineKey ?? definitionString(block.fields, 'key');
    if (!componentKey) return undefined;
    const damage = firstDefinitionBlock(block.fields, 'damage_per_day');
    const damageRange = damage ? firstDefinitionBlock(damage.fields, 'damage') : undefined;
    return {
        key: componentKey,
        kind: componentKind(block.key),
        size: definitionString(block.fields, 'size') ?? inlineDetails?.size ?? '',
        weaponType: definitionItems(firstDefinitionBlock(block.fields, 'tags'))
            .find(tag => key(tag).startsWith('weapon_type_')),
        componentSet: definitionString(block.fields, 'component_set') ?? inlineDetails?.componentSet,
        icon: definitionString(block.fields, 'icon') ?? inlineDetails?.icon,
        iconFrame: definitionNumber(block.fields, 'icon_frame', variables)?.value,
        prerequisites: collectDefinitionItemsDeep(firstDefinitionBlock(block.fields, 'prerequisites')),
        upgradesTo: definitionString(block.fields, 'upgrades_to'),
        hidden: definitionBoolean(block.fields, 'hidden') ?? false,
        shouldAiUse: definitionBoolean(block.fields, 'should_ai_use') ?? true,
        aiTags: definitionItems(firstDefinitionBlock(block.fields, 'ai_tags')),
        aiTagWeight: definitionNumber(block.fields, 'ai_tag_weight', variables)?.value ?? 0,
        aiWeight: parseAiWeight(block.fields, variables),
        classRestrictions: definitionItems(firstDefinitionBlock(block.fields, 'class_restriction')),
        sizeRestrictions: definitionItems(firstDefinitionBlock(block.fields, 'size_restriction')),
        blockedBy: definitionItems(firstDefinitionBlock(block.fields, 'blocked_by')),
        shipLimit: definitionNumber(block.fields, 'ship_limit', variables),
        dynamicPotential: firstDefinitionBlock(block.fields, 'potential') !== undefined
            || firstDefinitionBlock(block.fields, 'valid_for_country') !== undefined,
        power: definitionNumber(block.fields, 'power', variables) ?? inlineDetails?.power,
        buildTime: definitionNumber(block.fields, 'build_time', variables),
        sensorRange: definitionNumber(block.fields, 'sensor_range', variables),
        resources: resolveResources(parseResources(block.fields), variables),
        modifier: parseModifier(block.fields, 'modifier', variables),
        shipModifier: parseModifier(block.fields, 'ship_modifier', variables),
        damage: damage ? {
            accuracy: definitionNumber(damage.fields, 'accuracy', variables),
            min: damageRange ? definitionNumber(damageRange.fields, 'min', variables) : undefined,
            max: damageRange ? definitionNumber(damageRange.fields, 'max', variables) : undefined,
        } : undefined,
    };
}

function parseShipSize(
    block: DefinitionBlock,
    variables: ReadonlyMap<string, number>,
): ShipDesignSizeDetails {
    const sectionSlots: Array<{ slot: string; locator: string }> = [];
    const sectionSlotBlock = firstDefinitionBlock(block.fields, 'section_slots');
    if (sectionSlotBlock) {
        for (const field of sectionSlotBlock.fields) {
            if (field.kind !== 'block') continue;
            const locator = definitionString(field.fields, 'locator');
            if (locator) sectionSlots.push({ slot: field.key, locator });
        }
    }
    const cultureBlock = firstDefinitionBlock(block.fields, 'graphical_culture');
    const cultureScalar = definitionString(block.fields, 'graphical_culture');
    const graphicalCultures = cultureBlock
        ? definitionItems(cultureBlock)
        : cultureScalar && !['yes', 'no'].includes(key(cultureScalar)) ? [cultureScalar] : [];
    return {
        key: block.key,
        icon: definitionString(block.fields, 'icon'),
        entity: definitionString(block.fields, 'entity'),
        shipClass: definitionString(block.fields, 'class'),
        sectionSlots,
        graphicalCultures,
        maxHitpoints: definitionNumber(block.fields, 'max_hitpoints', variables),
        maxSpeed: definitionNumber(block.fields, 'max_speed', variables),
        baseBuildtime: definitionNumber(block.fields, 'base_buildtime', variables),
        modifier: parseModifier(block.fields, 'modifier', variables),
        shipModifier: parseModifier(block.fields, 'ship_modifier', variables),
        resources: resolveResources(parseResources(block.fields), variables),
        requiredComponentSets: definitionScalars(block.fields, 'required_component_set').map(value => value.value),
        shipRoles: definitionItems(firstDefinitionBlock(block.fields, 'ship_roles')),
        prerequisites: collectDefinitionItemsDeep(firstDefinitionBlock(block.fields, 'prerequisites')),
    };
}

function setUnique<T>(map: Map<string, T>, name: string, value: T, path: string, warnings: string[]): void {
    const folded = key(name);
    if (map.has(folded)) {
        warnings.push(path + ': duplicate definition ' + name + ' ignored');
        return;
    }
    map.set(folded, value);
}

export function lookupShipSizeInfo(catalog: ShipDesignCatalog, name: string): ShipSizeInfo | undefined {
    const folded = key(name);
    for (const [candidate, info] of catalog.base.shipSizes) {
        if (key(candidate) === folded) return info;
    }
    const details = catalog.shipSizeDetails.get(folded);
    return details ? {
        name: details.key,
        icon: details.icon,
        entity: details.entity,
        shipClass: details.shipClass,
        sectionSlots: details.sectionSlots,
        graphicalCultures: details.graphicalCultures,
    } : undefined;
}

export function lookupShipDesignSection(catalog: ShipDesignCatalog, name: string): ShipDesignSectionDefinition | undefined {
    return catalog.sections.get(key(name));
}

export function lookupShipDesignComponent(catalog: ShipDesignCatalog, name: string): ShipDesignComponentDefinition | undefined {
    return catalog.components.get(key(name));
}

export function lookupShipDesignSlotTemplate(catalog: ShipDesignCatalog, name: string): ShipDesignSlotTemplateDefinition | undefined {
    return catalog.slotTemplates.get(key(name));
}

export async function loadShipDesignCatalog(source: ShipIconDataSource): Promise<ShipDesignCatalog> {
    const warnings: string[] = [];
    const base = await loadShipIconCatalog(source);
    const groups = new Map<DirectoryName, SourceFile[]>();
    const variables = new Map<string, number>();
    for (const directory of DIRECTORIES) {
        const paths = await collectFiles(source, directory, warnings);
        const files = await readFiles(source, paths);
        groups.set(directory, files);
        if (directory === 'common/scripted_variables') {
            for (const file of files) mergeDefinitionVariables(variables, file.variables);
        }
    }
    const fileVariables = (file: SourceFile): Map<string, number> =>
        new Map([...variables, ...file.variables]);

    const catalog: ShipDesignCatalog = {
        base,
        sections: new Map(),
        slotTemplates: new Map(),
        components: new Map(),
        componentSets: new Map(),
        shipSizeDetails: new Map(),
        technologies: new Map(),
        technologyPrerequisites: new Map(),
        roles: [],
        variables,
        warnings: [...base.warnings, ...warnings],
    };

    for (const file of groups.get('common/ship_sizes') ?? []) {
        for (const field of file.fields) {
            if (field.kind !== 'block') continue;
            if (!lookupShipSizeInfo(catalog, field.key) && !firstDefinitionBlock(field.fields, 'section_slots')
                && !definitionString(field.fields, 'entity') && !definitionString(field.fields, 'class')) continue;
            setUnique(catalog.shipSizeDetails, field.key, parseShipSize(field, fileVariables(file)), file.path, catalog.warnings);
        }
    }
    for (const file of groups.get('common/section_templates') ?? []) {
        for (const field of file.fields) {
            if (field.kind !== 'block') continue;
            const section = parseSection(field, fileVariables(file));
            if (section) setUnique(catalog.sections, section.key, section, file.path, catalog.warnings);
        }
    }
    const inlineGroups: InlineScriptSourceGroup[] = [];
    const inlineFieldRegistry = new Map<string, Map<string, string>>();
    for (const file of [...(groups.get('common/inline_scripts') ?? [])].reverse()) {
        inlineFieldRegistry.set(
            normalizeInlineScriptKey(file.path.replace(/^common\/inline_scripts\//i, '')),
            parseInlineGeneralFields(file.content),
        );
        inlineGroups.push({
            source: 'workspace',
            file: normalizeInlineScriptKey(file.path.replace(/^common\/inline_scripts\//i, '')),
            template: parseInlineScriptTemplate(file.content),
        });
    }
    const inlineRegistry = buildInlineScriptRegistry(inlineGroups);

    for (const file of groups.get('common/component_slot_templates') ?? []) {
        for (const field of file.fields) {
            if (field.kind !== 'block') continue;
            const slot = parseSlotTemplate(field);
            if (slot) setUnique(catalog.slotTemplates, slot.key, slot, file.path, catalog.warnings);
        }
    }
    for (const file of groups.get('common/component_templates') ?? []) {
        const inlineEntries = extractTargetingFields(file.content);
        for (const entry of inlineEntries) expandInlineScriptFields(entry, inlineRegistry, fileVariables(file));
        const inlineIds = inlineEntries.filter(entry => (entry.inlineCalls?.length ?? 0) > 0);
        let inlineIndex = 0;
        for (const field of file.fields) {
            if (field.kind !== 'block' || !key(field.key).includes('component_template')) continue;
            const hasInline = firstDefinitionBlock(field.fields, 'inline_script') !== undefined;
            const directKey = definitionString(field.fields, 'key');
            let inlineKey: string | undefined;
            if (hasInline && (!directKey || directKey.includes('$'))) {
                inlineKey = inlineIds[inlineIndex]?.componentId || undefined;
                inlineIndex++;
                if (!inlineKey) catalog.warnings.push(file.path + ': unable to resolve inline component key for ' + field.key + '.');
            }
            const inlineEntry = inlineKey ? inlineIds[inlineIndex - 1] : undefined;
            const inlineDetails = inlineEntry ? resolveInlineComponentDetails(inlineEntry, inlineRegistry, inlineFieldRegistry, fileVariables(file)) : undefined;
            const component = parseComponent(field, fileVariables(file), inlineKey, inlineDetails);
            if (component) {
                component.sourceFile = file.path;
                setUnique(catalog.components, component.key, component, file.path, catalog.warnings);
            }
        }
    }
    for (const file of groups.get('common/component_templates') ?? []) {
        if (!file.path.toLowerCase().endsWith('.csv')) continue;
        for (const [componentKey, power] of parseCsvPower(file.content)) {
            const component = catalog.components.get(componentKey);
            if (component && !component.power) component.power = { raw: 'CSV power', value: power };
        }
    }
    for (const file of groups.get('common/component_sets') ?? []) {
        for (const field of file.fields) {
            if (field.kind !== 'block' || key(field.key) !== 'component_set') continue;
            const name = definitionString(field.fields, 'key');
            if (!name) continue;
            setUnique(catalog.componentSets, name, {
                key: name,
                required: definitionBoolean(field.fields, 'required_component_set') ?? false,
                core: definitionBoolean(field.fields, 'is_core_component_set') ?? false,
            }, file.path, catalog.warnings);
        }
    }
    for (const file of groups.get('common/technology') ?? []) {
        const graph = parseTechFile(file.content, file.path);
        for (const node of graph.nodes) setUnique(catalog.technologies, node.id, node, file.path, catalog.warnings);
        for (const edge of graph.edges) {
            const folded = key(edge.target);
            const current = catalog.technologyPrerequisites.get(folded) ?? [];
            if (!current.some(item => key(item) === key(edge.source))) current.push(edge.source);
            catalog.technologyPrerequisites.set(folded, current);
        }
    }

    const roles = new Set<string>();
    for (const section of catalog.sections.values()) for (const role of section.aiTags) roles.add(role);
    for (const component of catalog.components.values()) for (const role of component.aiTags) roles.add(role);
    for (const size of catalog.shipSizeDetails.values()) for (const role of size.shipRoles) roles.add(role);
    catalog.roles = [...roles].sort(comparePaths);
    return catalog;
}
