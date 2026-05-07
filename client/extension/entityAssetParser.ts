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
    animation?: string;
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
    line: number;
    endLine: number;
    filePath: string;
}

export interface MeshDefinition {
    name: string;
    file: string;         // relative path like "gfx/models/ships/xxx.mesh"
    scale?: number;
    meshSettings: MeshSettingOverride[];
}

export interface EntityGraph {
    entities: Map<string, EntityDefinition>;
    meshes: Map<string, MeshDefinition>;
}

// ── Token Stream Helpers ─────────────────────────────────────────────────────

/**
 * Simple recursive descent parser over a flat token array.
 * Tracks position with a mutable index reference.
 */
interface ParseCtx {
    tokens: Token[];
    pos: number;
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

function parseFloat3(ctx: ParseCtx): [number, number, number] {
    expect(ctx, '{');
    const x = parseFloat(advance(ctx)?.value ?? '0');
    const y = parseFloat(advance(ctx)?.value ?? '0');
    const z = parseFloat(advance(ctx)?.value ?? '0');
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
            case 'scale': loc.scale = parseFloat(advance(ctx)!.value); break;
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

function parseStateBlock(ctx: ParseCtx): StateDefinition {
    const state: StateDefinition = { name: '', locators: [], meshSettings: [] };
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
            case 'locator': state.locators.push(parseLocatorBlock(ctx, state.name)); break;
            case 'meshsettings': state.meshSettings.push(parseMeshSettingBlock(ctx)); break;
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
            case 'scale': entity.scale = parseFloat(advance(ctx)!.value); break;
            case 'default_state': entity.defaultState = advance(ctx)!.value.replace(/"/g, ''); break;
            case 'locator': entity.locators.push(parseLocatorBlock(ctx)); break;
            case 'state': entity.states.push(parseStateBlock(ctx)); break;
            case 'attach': entity.attaches.push(...parseAttachBlock(ctx)); break;
            case 'meshsettings': entity.meshSettings.push(parseMeshSettingBlock(ctx)); break;
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
            case 'scale': mesh.scale = parseFloat(advance(ctx)!.value); break;
            case 'meshsettings': mesh.meshSettings.push(parseMeshSettingBlock(ctx)); break;
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
export function parseAssetFile(content: string, filePath: string): EntityDefinition[] {
    const tokens = tokenize(content);
    const ctx: ParseCtx = { tokens, pos: 0 };
    const entities: EntityDefinition[] = [];

    while (ctx.pos < ctx.tokens.length) {
        const t = peek(ctx)!;
        if (t.value === 'entity') {
            advance(ctx); // skip 'entity'
            const eq = peek(ctx);
            if (eq?.value === '=') {
                advance(ctx); // skip '='
                entities.push(parseEntityBlock(ctx, filePath));
            }
        } else {
            advance(ctx);
        }
    }

    return entities;
}

/**
 * Parse a single .gfx file content and extract pdxmesh definitions.
 */
export function parseGfxFile(content: string): MeshDefinition[] {
    const tokens = tokenize(content);
    const ctx: ParseCtx = { tokens, pos: 0 };
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

    // Parse all .asset files for entity definitions
    for (const { path, content } of assetFiles) {
        try {
            const entities = parseAssetFile(content, path);
            for (const ent of entities) {
                if (ent.name) graph.entities.set(ent.name, ent);
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
