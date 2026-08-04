/**
 * Entity Asset Parser
 *
 * Parses .asset and .gfx files to build an EntityGraph mapping
 * entity names → mesh references → file paths, including locator
 * overrides, attach definitions, and state definitions.
 *
 * Uses the shared pdxTokenizer for Clausewitz script parsing.
 */
import { tokenize, type Token } from './pdxTokenizer';

// ── Data Structures ──────────────────────────────────────────────────────────

export interface LocatorOverride {
    name: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    parentJoint?: string;
    scale?: number;
    stateName?: string;
    line: number;
}

export interface AttachDefinition {
    locatorName: string;
    entityName: string;
    getStateFromParent?: boolean;
}

export interface MeshSettingOverride {
    index?: number;
    name?: string;
    textureDiffuse?: string;
    textureNormal?: string;
    textureSpecular?: string;
    shader?: string;
}

export interface StateDefinition {
    name: string;
    locators: LocatorOverride[];
    meshSettings: MeshSettingOverride[];
    particleEvents: StateParticleEvent[];
    animation?: string;
    stateTime?: number;
    looping?: boolean;
}

export interface StateParticleEvent {
    kind: 'event' | 'start_event';
    time: number;
    node?: string;
    particle: string;
    keepParticle?: boolean;
    triggerOnce?: boolean;
    line: number;
}

export interface EntityDefinition {
    name: string;
    pdxmesh?: string;
    scale?: number;
    defaultState?: string;
    states: StateDefinition[];
    locators: LocatorOverride[];
    attaches: AttachDefinition[];
    meshSettings: MeshSettingOverride[];
    clone?: string;
    getStateFromParent?: boolean;
    line: number;
    endLine: number;
    filePath: string;
}

export interface MeshDefinition {
    name: string;
    file: string;         // relative path like "gfx/models/ships/xxx.mesh"
    scale?: number;
    meshSettings: MeshSettingOverride[];
    animations?: Record<string, string>;
}

export interface EntityGraph {
    entities: Map<string, EntityDefinition>;
    meshes: Map<string, MeshDefinition>;
    animations: Map<string, string>;
}

// ── Token Stream Helpers ─────────────────────────────────────────────────────

/**
 * Simple recursive descent parser over a flat token array.
 * Tracks position with a mutable index reference.
 */
interface ParseCtx {
    tokens: Token[];
    pos: number;
    constants: Record<string, number>;
}

function extractConstants(tokens: Token[]): Record<string, number> {
    const constants: Record<string, number> = {};
    for (let i = 0; i < tokens.length - 2; i++) {
        const t = tokens[i]!;
        if (t.value.startsWith('@')) {
            const eq = tokens[i + 1]!;
            if (eq.value === '=') {
                const val = tokens[i + 2]!;
                constants[t.value] = parseFloat(val.value);
            }
        }
    }
    return constants;
}

function peek(ctx: ParseCtx): Token | undefined {
    return ctx.tokens[ctx.pos];
}

function advance(ctx: ParseCtx): Token | undefined {
    return ctx.tokens[ctx.pos++];
}

function expect(ctx: ParseCtx, value: string): void {
    const t = advance(ctx);
    if (!t || t.value !== value) {
        throw new Error(`Expected '${value}', got '${t?.value}' at line ${t?.line ?? '?'}`);
    }
}

function skipBlock(ctx: ParseCtx): void {
    let depth = 1;
    while (ctx.pos < ctx.tokens.length && depth > 0) {
        const t = advance(ctx)!;
        if (t.value === '{') depth++;
        if (t.value === '}') depth--;
    }
}

function parseNumber(ctx: ParseCtx): number {
    const t = advance(ctx);
    if (!t) return 0;
    if (t.value.startsWith('@')) {
        return ctx.constants[t.value] ?? 1.0;
    }
    return parseFloat(t.value);
}

function parseFloat3(ctx: ParseCtx): [number, number, number] {
    expect(ctx, '{');
    const x = parseNumber(ctx);
    const y = parseNumber(ctx);
    const z = parseNumber(ctx);
    expect(ctx, '}');
    return [x, y, z];
}

// ── Entity Parsing ───────────────────────────────────────────────────────────

function parseLocatorBlock(ctx: ParseCtx, stateName?: string): LocatorOverride {
    const loc: LocatorOverride = { name: '', line: peek(ctx)?.line ?? 0 };
    if (stateName) loc.stateName = stateName;
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        switch (key) {
            case 'name': loc.name = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'position': loc.position = parseFloat3(ctx); break;
            case 'rotation': loc.rotation = parseFloat3(ctx); break;
            case 'parent_joint': loc.parentJoint = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'scale': loc.scale = parseNumber(ctx); break;
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    expect(ctx, '}');
    return loc;
}

function parseMeshSettingBlock(ctx: ParseCtx): MeshSettingOverride {
    const ms: MeshSettingOverride = {};
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        switch (key) {
            case 'index': ms.index = parseInt(advance(ctx)!.value); break;
            case 'name': ms.name = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'texture_diffuse': ms.textureDiffuse = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'texture_normal': ms.textureNormal = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'texture_specular': ms.textureSpecular = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'shader': ms.shader = advance(ctx)!.value.replace(/"/g, ''); break;
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    expect(ctx, '}');
    return ms;
}

function parseYesNo(ctx: ParseCtx): boolean {
    return (advance(ctx)?.value.replace(/"/g, '').toLowerCase() ?? '') === 'yes';
}

function parseStateEventBlock(ctx: ParseCtx, kind: StateParticleEvent['kind']): StateParticleEvent | undefined {
    const event: StateParticleEvent = {
        kind,
        time: 0,
        particle: '',
        line: peek(ctx)?.line ?? 0,
    };
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        if (peek(ctx)?.value !== '=') continue;
        advance(ctx);
        switch (key) {
            case 'time': event.time = parseNumber(ctx); break;
            case 'node': event.node = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'particle': event.particle = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'keep_particle': event.keepParticle = parseYesNo(ctx); break;
            case 'trigger_once': event.triggerOnce = parseYesNo(ctx); break;
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    expect(ctx, '}');
    return event.particle ? event : undefined;
}

function parseStateBlock(ctx: ParseCtx): StateDefinition {
    const state: StateDefinition = { name: '', locators: [], meshSettings: [], particleEvents: [] };
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        switch (key) {
            case 'name': state.name = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'animation': state.animation = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'state_time': state.stateTime = parseNumber(ctx); break;
            case 'looping': state.looping = parseYesNo(ctx); break;
            case 'locator': state.locators.push(parseLocatorBlock(ctx, state.name)); break;
            case 'meshsettings': state.meshSettings.push(parseMeshSettingBlock(ctx)); break;
            case 'event': {
                const event = parseStateEventBlock(ctx, 'event');
                if (event) state.particleEvents.push(event);
                break;
            }
            case 'start_event': {
                const event = parseStateEventBlock(ctx, 'start_event');
                if (event) state.particleEvents.push(event);
                break;
            }
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    expect(ctx, '}');
    return state;
}

function parseAttachBlock(ctx: ParseCtx): AttachDefinition[] {
    const attaches: AttachDefinition[] = [];
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const locName = advance(ctx)!.value.replace(/"/g, '');
        if (locName === '}') break;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        const entityName = advance(ctx)!.value.replace(/"/g, '');
        attaches.push({ locatorName: locName, entityName });
    }
    if (peek(ctx)?.value === '}') advance(ctx);
    return attaches;
}

function parseAnimationBlock(ctx: ParseCtx): { id: string; type: string } {
    const anim = { id: '', type: '' };
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        switch (key) {
            case 'id':
            case 'name':
                anim.id = advance(ctx)!.value.replace(/"/g, '');
                break;
            case 'type':
            case 'file':
                anim.type = advance(ctx)!.value.replace(/"/g, '');
                break;
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    expect(ctx, '}');
    return anim;
}

function parseEntityBlock(ctx: ParseCtx, filePath: string): EntityDefinition {
    const startLine = peek(ctx)?.line ?? 0;
    const entity: EntityDefinition = {
        name: '', states: [], locators: [], attaches: [],
        meshSettings: [], line: startLine, endLine: 0, filePath,
    };
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        switch (key) {
            case 'name': entity.name = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'pdxmesh': entity.pdxmesh = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'clone': entity.clone = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'scale': entity.scale = parseNumber(ctx); break;
            case 'default_state': entity.defaultState = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'locator': entity.locators.push(parseLocatorBlock(ctx)); break;
            case 'state': entity.states.push(parseStateBlock(ctx)); break;
            case 'attach': entity.attaches.push(...parseAttachBlock(ctx)); break;
            case 'meshsettings': entity.meshSettings.push(parseMeshSettingBlock(ctx)); break;
            case 'get_state_from_parent': {
                const val = advance(ctx)!.value.replace(/"/g, '').toLowerCase();
                entity.getStateFromParent = val === 'yes';
                break;
            }
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    entity.endLine = peek(ctx)?.line ?? entity.line;
    if (peek(ctx)?.value === '}') advance(ctx);
    return entity;
}

// ── GFX / pdxmesh Parsing ────────────────────────────────────────────────────

function parsePdxMeshBlock(ctx: ParseCtx): MeshDefinition {
    const mesh: MeshDefinition = { name: '', file: '', meshSettings: [] };
    expect(ctx, '{');
    while (peek(ctx) && peek(ctx)!.value !== '}') {
        const key = advance(ctx)!.value;
        if (key === '=') continue;
        const eq = peek(ctx);
        if (eq?.value !== '=') continue;
        advance(ctx); // skip '='
        switch (key) {
            case 'name': mesh.name = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'file': mesh.file = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'scale': mesh.scale = parseNumber(ctx); break;
            case 'meshsettings': mesh.meshSettings.push(parseMeshSettingBlock(ctx)); break;
            case 'animation': {
                const anim = parseAnimationBlock(ctx);
                if (anim.id && anim.type) {
                    if (!mesh.animations) mesh.animations = {};
                    mesh.animations[anim.id] = anim.type;
                }
                break;
            }
            default: {
                const next = peek(ctx);
                if (next?.value === '{') { advance(ctx); skipBlock(ctx); }
                else advance(ctx);
            }
        }
    }
    if (peek(ctx)?.value === '}') advance(ctx);
    return mesh;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a single .asset file content and extract entity definitions.
 */
export function parseAssetFile(content: string, filePath: string): { entities: EntityDefinition[], animations: Record<string, string> } {
    const tokens = tokenize(content);
    const constants = extractConstants(tokens);
    const ctx: ParseCtx = { tokens, pos: 0, constants };
    const entities: EntityDefinition[] = [];
    const animations: Record<string, string> = {};

    while (ctx.pos < ctx.tokens.length) {
        const t = peek(ctx)!;
        if (t.value === 'entity') {
            advance(ctx); // skip 'entity'
            const eq = peek(ctx);
            if (eq?.value === '=') {
                advance(ctx); // skip '='
                entities.push(parseEntityBlock(ctx, filePath));
            }
        } else if (t.value === 'animation') {
            advance(ctx);
            const eq = peek(ctx);
            if (eq?.value === '=') {
                advance(ctx);
                const anim = parseAnimationBlock(ctx);
                if (anim.id && anim.type) {
                    animations[anim.id] = anim.type;
                }
            }
        } else {
            advance(ctx);
        }
    }

    return { entities, animations };
}

/**
 * Parse a single .gfx file content and extract pdxmesh definitions.
 */
export function parseGfxFile(content: string): MeshDefinition[] {
    const tokens = tokenize(content);
    const constants = extractConstants(tokens);
    const ctx: ParseCtx = { tokens, pos: 0, constants };
    const meshes: MeshDefinition[] = [];

    while (ctx.pos < ctx.tokens.length) {
        const t = peek(ctx)!;
        if (t.value === 'pdxmesh') {
            advance(ctx); // skip 'pdxmesh'
            const eq = peek(ctx);
            if (eq?.value === '=') {
                advance(ctx); // skip '='
                meshes.push(parsePdxMeshBlock(ctx));
            }
        } else {
            advance(ctx);
        }
    }

    return meshes;
}

/**
 * Build an EntityGraph from multiple .asset and .gfx file contents.
 */
export function buildEntityGraph(
    assetFiles: Array<{ path: string; content: string }>,
    gfxFiles: Array<{ path: string; content: string }>,
): EntityGraph {
    const graph: EntityGraph = {
        entities: new Map(),
        meshes: new Map(),
        animations: new Map(),
    };

    // Parse all .gfx files for mesh definitions
    for (const { content } of gfxFiles) {
        try {
            const meshes = parseGfxFile(content);
            for (const m of meshes) {
                if (m.name) graph.meshes.set(m.name, m);
            }
        } catch (e) {
            console.warn(`Failed to parse .gfx file: ${e}`);
        }
    }

    // Parse all .asset files for entity and animation definitions
    for (const { path, content } of assetFiles) {
        try {
            const parsed = parseAssetFile(content, path);
            for (const ent of parsed.entities) {
                if (ent.name) graph.entities.set(ent.name, ent);
            }
            for (const [id, file] of Object.entries(parsed.animations)) {
                graph.animations.set(id, file);
            }
        } catch (e) {
            console.warn(`Failed to parse .asset file ${path}: ${e}`);
        }
    }

    // Resolve clone inheritance
    for (const [, entity] of graph.entities) {
        if (entity.clone) {
            const parent = graph.entities.get(entity.clone);
            if (parent) {
                if (!entity.pdxmesh) entity.pdxmesh = parent.pdxmesh;
                if (entity.scale === undefined) entity.scale = parent.scale;
                if (entity.states.length === 0) entity.states = [...parent.states];
                if (entity.locators.length === 0) entity.locators = [...parent.locators];
                if (entity.attaches.length === 0) entity.attaches = [...parent.attaches];
                if (entity.meshSettings.length === 0) entity.meshSettings = [...parent.meshSettings];
            }
        }
    }

    return graph;
}
