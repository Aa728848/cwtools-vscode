/**
 * Ship Design 3D Asset & Entity Graph Resource Loader.
 *
 * Resolves entity graphs, meshes, attachments, and texture paths across
 * layered mod/vanilla roots with strict directory-visit, attachment-depth,
 * and bounded mesh/texture cache limits.
 */

import * as path from 'path';
import { isPathInsideOrEqual } from '../pathScope';
import type { ShipIconDataSource } from '../shipIcon/shipIconDefinitions';
import {
    buildEntityGraph,
    type EntityDefinition,
    type EntityGraph,
    type MeshDefinition,
    type MeshSettingOverride,
} from '../entityAssetParser';
import type {
    ShipDesignEntityAssetData,
    ShipDesignMeshSettingAssetData,
} from '../../shared/shipDesignProtocol';

export interface ShipDesignResourceSource extends ShipIconDataSource {
    readBinary(relativePath: string): Promise<ArrayBuffer | undefined>;
    resolvePath(relativePath: string): string | undefined;
}

/** A resolved file inside any workspace root is mod content; anything else resolved through the layers is vanilla. */
export function shipDesignContentOrigin(absolutePath: string | undefined, workspaceRoots: readonly string[]): 'vanilla' | 'mod' | undefined {
    if (!absolutePath) return undefined;
    return workspaceRoots.some(root => isPathInsideOrEqual(absolutePath, root)) ? 'mod' : 'vanilla';
}

export interface ShipDesignResolvedAsset {
    asset: ShipDesignEntityAssetData;
    warnings: string[];
}

const MAX_GRAPH_DIRECTORY_VISITS = 4000;
const MAX_ATTACH_DEPTH = 8;
const MAX_ATTACHES_PER_ENTITY = 128;
const MAX_TEXTURE_DIRECTORY_VISITS = 256;
const MAX_TEXTURES_PER_DIRECTORY = 512;
const MAX_MESH_CACHE = 64;
const MAX_TEXTURE_CACHE = 32;

function key(value: string): string {
    return value.toLowerCase();
}

function comparePaths(left: string, right: string): number {
    const a = key(left);
    const b = key(right);
    if (a !== b) return a < b ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
}

function textureExtension(path: string): boolean {
    return /\.(?:dds|tga|png|jpg|jpeg)$/i.test(path);
}

function findEntity(graph: EntityGraph, name: string): EntityDefinition | undefined {
    const direct = graph.entities.get(name);
    if (direct) return direct;
    const folded = key(name);
    for (const [candidate, entity] of graph.entities) if (key(candidate) === folded) return entity;
    return undefined;
}

function findMesh(graph: EntityGraph, name: string | undefined): MeshDefinition | undefined {
    if (!name) return undefined;
    const direct = graph.meshes.get(name);
    if (direct) return direct;
    const folded = key(name);
    for (const [candidate, mesh] of graph.meshes) if (key(candidate) === folded) return mesh;
    return undefined;
}

export class ShipDesignResourceLoader {
    private graphPromise: Promise<EntityGraph> | undefined;
    private readonly meshCache = new Map<string, Promise<string | undefined>>();
    private readonly textureCache = new Map<string, Promise<Record<string, string>>>();

    constructor(
        private readonly source: ShipDesignResourceSource,
        private readonly toUri: (absolutePath: string) => string,
    ) {}

    private async collectGraphFiles(): Promise<{ assetFiles: Array<{ path: string; content: string }>; gfxFiles: Array<{ path: string; content: string }> }> {
        const assetFiles: Array<{ path: string; content: string }> = [];
        const gfxFiles: Array<{ path: string; content: string }> = [];
        const queue = ['gfx'];
        const visited = new Set<string>();
        while (queue.length > 0 && visited.size < MAX_GRAPH_DIRECTORY_VISITS) {
            const directory = queue.shift();
            if (!directory) continue;
            const folded = key(directory);
            if (visited.has(folded)) continue;
            visited.add(folded);
            for (const file of await this.source.listFiles(directory)) {
                const lower = file.toLowerCase();
                if (lower.endsWith('.asset') || lower.endsWith('.gfx')) {
                    const content = await this.source.readText(file);
                    if (content === undefined) continue;
                    if (lower.endsWith('.asset')) assetFiles.push({ path: file, content });
                    else gfxFiles.push({ path: file, content });
                } else if (!lower.includes('.')) queue.push(file);
            }
        }
        assetFiles.sort((left, right) => comparePaths(left.path, right.path));
        gfxFiles.sort((left, right) => comparePaths(left.path, right.path));
        return { assetFiles, gfxFiles };
    }

    private graph(): Promise<EntityGraph> {
        if (!this.graphPromise) this.graphPromise = this.collectGraphFiles().then(files =>
            buildEntityGraph(files.assetFiles, files.gfxFiles));
        return this.graphPromise;
    }

    private meshBase64(meshPath: string): Promise<string | undefined> {
        const folded = key(meshPath);
        let cached = this.meshCache.get(folded);
        if (!cached) {
            cached = this.source.readBinary(meshPath).then(buffer => buffer === undefined
                ? undefined
                : Buffer.from(buffer).toString('base64')).catch(() => undefined);
            if (this.meshCache.size < MAX_MESH_CACHE) this.meshCache.set(folded, cached);
        }
        return cached;
    }

    private textures(directory: string): Promise<Record<string, string>> {
        const folded = key(directory);
        let cached = this.textureCache.get(folded);
        if (!cached) {
            cached = this.scanTextures(directory).catch(() => ({}));
            if (this.textureCache.size < MAX_TEXTURE_CACHE) this.textureCache.set(folded, cached);
        }
        return cached;
    }

    private async scanTextures(directory: string): Promise<Record<string, string>> {
        const result: Record<string, string> = {};
        const queue = [directory];
        const visited = new Set<string>();
        let count = 0;
        while (queue.length > 0 && visited.size < MAX_TEXTURE_DIRECTORY_VISITS && count < MAX_TEXTURES_PER_DIRECTORY) {
            const current = queue.shift();
            if (!current) continue;
            const folded = key(current);
            if (visited.has(folded)) continue;
            visited.add(folded);
            for (const file of await this.source.listFiles(current)) {
                if (textureExtension(file)) {
                    const absolute = this.source.resolvePath(file);
                    if (!absolute) continue;
                    const uri = this.toUri(absolute);
                    const basename = path.posix.basename(file);
                    result[file] = uri;
                    result[file.toLowerCase()] = uri;
                    result[basename] = uri;
                    result[basename.toLowerCase()] = uri;
                    count++;
                    if (count >= MAX_TEXTURES_PER_DIRECTORY) break;
                } else if (!path.posix.basename(file).includes('.')) queue.push(file);
            }
        }
        return result;
    }

    private convertMeshSettings(settings: readonly MeshSettingOverride[]): ShipDesignMeshSettingAssetData[] {
        return settings.map(setting => ({
            index: setting.index,
            name: setting.name,
            textureDiffuse: setting.textureDiffuse,
            textureNormal: setting.textureNormal,
            textureSpecular: setting.textureSpecular,
            shader: setting.shader,
        }));
    }

    private async resolveEntity(
        graph: EntityGraph,
        entityName: string,
        parentTextures: Record<string, string>,
        depth: number,
        ancestors: ReadonlySet<string>,
        warnings: string[],
    ): Promise<ShipDesignEntityAssetData | undefined> {
        if (depth >= MAX_ATTACH_DEPTH) {
            warnings.push('Attach depth limit reached at ' + entityName + '.');
            return undefined;
        }
        const folded = key(entityName);
        if (ancestors.has(folded)) {
            warnings.push('Attach cycle skipped at ' + entityName + '.');
            return undefined;
        }
        const entity = findEntity(graph, entityName);
        if (!entity) {
            warnings.push('Entity not found: ' + entityName + '.');
            return undefined;
        }
        const mesh = findMesh(graph, entity.pdxmesh);
        if (entity.pdxmesh && !mesh) warnings.push('Mesh definition not found: ' + entity.pdxmesh + '.');
        const textureMap: Record<string, string> = { ...parentTextures };
        let meshBase64: string | undefined;
        let meshUri: string | undefined;
        if (mesh) {
            // Stream meshes through a Webview resource URI: large hulls (tens of MB) exceed the
            // in-memory binary limit and would also bloat postMessage as base64.
            const absolute = this.source.resolvePath(mesh.file);
            if (absolute) meshUri = this.toUri(absolute);
            else meshBase64 = await this.meshBase64(mesh.file);
            if (!meshUri && !meshBase64) warnings.push('Mesh file not readable: ' + mesh.file + '.');
            Object.assign(textureMap, await this.textures(path.posix.dirname(mesh.file)));
        }
        const state = entity.defaultState
            ? entity.states.find(candidate => key(candidate.name) === key(entity.defaultState ?? ''))
            : undefined;
        const meshSettings = [
            ...this.convertMeshSettings(mesh?.meshSettings ?? []),
            ...this.convertMeshSettings(entity.meshSettings),
            ...this.convertMeshSettings(state?.meshSettings ?? []),
        ];
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(folded);
        const attaches: ShipDesignEntityAssetData['attaches'] = [];
        const definitions = entity.attaches.slice(0, MAX_ATTACHES_PER_ENTITY);
        if (entity.attaches.length > definitions.length) warnings.push('Attach count truncated at ' + entity.name + '.');
        for (const attach of definitions) {
            const child = await this.resolveEntity(graph, attach.entityName, textureMap, depth + 1, nextAncestors, warnings);
            if (child) attaches.push({ locatorName: attach.locatorName, entity: child });
        }
        const scale = (entity.scale ?? 1) * (mesh?.scale ?? 1);
        return {
            name: entity.name,
            meshUri,
            meshBase64,
            scale: scale === 1 ? undefined : scale,
            locators: [...entity.locators, ...state?.locators ?? []].map(locator => ({
                name: locator.name,
                position: locator.position,
                rotation: locator.rotation,
                scale: locator.scale,
                parentJoint: locator.parentJoint,
            })),
            meshSettings,
            attaches,
            textureMap,
        };
    }

    async load(entityName: string): Promise<ShipDesignResolvedAsset> {
        const warnings: string[] = [];
        const graph = await this.graph();
        const asset = await this.resolveEntity(graph, entityName, {}, 0, new Set(), warnings);
        if (!asset) throw new Error(warnings.join(' ') || 'Unable to resolve entity ' + entityName + '.');
        return { asset, warnings };
    }
}
