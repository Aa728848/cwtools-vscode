import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from './ai/errorReporter';
import { decodeDds, decodeTga } from './ddsDecoder';
import { resolveCaseInsensitivePath } from './fsCaseInsensitive';
import { parseParticleFile } from './particleAssetParser';
import { parsePdxParticleAliases, resolvePdxParticleEffect, type PdxParticleAlias } from './particleObjectTypeParser';
import type { ParticleEffect, ParticleTexturePayload, Subsystem } from '../webview/particleTypes';

const PARTICLE_RESOURCE_FILE_LIMIT_PER_ROOT = 5000;
const PARTICLE_SEARCH_ROOT_LIMIT = 16;
const TEXTURE_CACHE_LIMIT = 256;

interface TextureCacheEntry {
    mtimeMs: number;
    size: number;
    payload: Omit<ParticleTexturePayload, 'file'>;
}

export interface ResolvedParticleResources {
    effects: Record<string, ParticleEffect>;
    textures: Record<string, ParticleTexturePayload>;
    unresolved: string[];
}

const textureCache = new Map<string, TextureCacheEntry>();

function rememberTexture(filePath: string, entry: TextureCacheEntry): void {
    textureCache.delete(filePath);
    textureCache.set(filePath, entry);
    while (textureCache.size > TEXTURE_CACHE_LIMIT) {
        const oldest = textureCache.keys().next().value as string | undefined;
        if (!oldest) break;
        textureCache.delete(oldest);
    }
}

function readPngDimensions(data: Buffer): { width: number; height: number } | undefined {
    if (data.length < 24 || data.toString('ascii', 1, 4) !== 'PNG') return undefined;
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function decodeTexture(filePath: string): Omit<ParticleTexturePayload, 'file'> | undefined {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(filePath);
    } catch (error) {
        ErrorReporter.debug('ParticleResourceResolver', `Failed to stat texture ${filePath}`, error);
        textureCache.delete(filePath);
        return undefined;
    }
    const cached = textureCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        textureCache.delete(filePath);
        textureCache.set(filePath, cached);
        return cached.payload;
    }

    const ext = path.extname(filePath).toLowerCase();
    let payload: Omit<ParticleTexturePayload, 'file'> | undefined;
    if (ext === '.dds') payload = decodeDds(filePath) ?? undefined;
    else if (ext === '.tga') payload = decodeTga(filePath) ?? undefined;
    else if (ext === '.png') {
        try {
            const data = fs.readFileSync(filePath);
            const dimensions = readPngDimensions(data);
            payload = {
                dataUri: `data:image/png;base64,${data.toString('base64')}`,
                width: dimensions?.width ?? 1,
                height: dimensions?.height ?? 1,
            };
        } catch (error) {
            ErrorReporter.debug('ParticleResourceResolver', `Failed to read PNG texture ${filePath}`, error);
        }
    }
    if (payload) rememberTexture(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, payload });
    return payload;
}

function uniqueRoots(searchRoots: string[]): string[] {
    const seen = new Set<string>();
    return searchRoots.filter(root => {
        const key = path.resolve(root).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function particleResourceFiles(root: string, limit: number): Promise<string[]> {
    // CWT defines both particle and particle_type under game/gfx, not only
    // game/gfx/particles. Prioritize the conventional particles directory.
    const baseDir = path.join(root, 'gfx');
    if (!fs.existsSync(baseDir)) return [];
    const result: string[] = [];
    const stack = [baseDir];
    while (stack.length > 0 && result.length < limit) {
        const dir = stack.pop()!;
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (error) {
            ErrorReporter.debug('ParticleResourceResolver', `Failed to scan particle directory ${dir}`, error);
            continue;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        const directories = entries.filter(entry => entry.isDirectory());
        directories.sort((a, b) => {
            const aPriority = dir === baseDir && a.name.toLowerCase() === 'particles' ? 0 : 1;
            const bPriority = dir === baseDir && b.name.toLowerCase() === 'particles' ? 0 : 1;
            return aPriority - bPriority || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        for (let i = directories.length - 1; i >= 0; i--) {
            stack.push(path.join(dir, directories[i]!.name));
        }
        for (const entry of entries) {
            const extension = path.extname(entry.name).toLowerCase();
            if (entry.isFile() && (extension === '.asset' || extension === '.gfx')) {
                result.push(path.join(dir, entry.name));
                if (result.length >= limit) break;
            }
        }
    }
    return result;
}

function terminalParticleTypeNames(wanted: Set<string>, aliases: ReadonlyMap<string, PdxParticleAlias>): Set<string> {
    const result = new Set<string>();
    for (const name of wanted) {
        const visiting = new Set<string>();
        let current = name;
        while (!visiting.has(current)) {
            visiting.add(current);
            const alias = aliases.get(current);
            if (!alias || alias.type === current) break;
            current = alias.type;
        }
        result.add(current);
    }
    return result;
}

function resolveTexturePath(texturePath: string, searchRoots: string[], documentPath: string): string | undefined {
    const normalized = texturePath.trim().replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, '');
    const candidates: string[] = [];
    if (path.isAbsolute(texturePath)) candidates.push(texturePath);
    for (const root of searchRoots) candidates.push(path.join(root, normalized));
    candidates.push(path.join(path.dirname(documentPath), normalized));

    const withFallbackExtensions = (candidate: string): string[] => {
        if (/\.(dds|png|tga)$/i.test(candidate)) {
            return [candidate, candidate.replace(/\.(dds|png|tga)$/i, '.png'), candidate.replace(/\.(dds|png|tga)$/i, '.tga')];
        }
        return [`${candidate}.dds`, `${candidate}.png`, `${candidate}.tga`];
    };
    for (const candidate of candidates.flatMap(withFallbackExtensions)) {
        const resolved = fs.existsSync(candidate) ? candidate : resolveCaseInsensitivePath(candidate);
        if (resolved) return resolved;
    }
    return undefined;
}

function collectTextureFiles(effect: ParticleEffect, output: Set<string>): void {
    const collectSubsystem = (subsystem: Subsystem): void => {
        if (subsystem.texture?.file) output.add(subsystem.texture.file);
        for (const child of subsystem.childsystems ?? []) collectSubsystem(child);
    };
    for (const subsystem of effect.subsystems) collectSubsystem(subsystem);
}

export async function resolveNamedParticleResources(
    effectNames: Iterable<string>,
    searchRoots: string[],
    documentPath: string,
): Promise<ResolvedParticleResources> {
    const wanted = new Set([...effectNames].map(name => name.trim()).filter(Boolean));
    const unresolved = new Set(wanted);
    const effects: Record<string, ParticleEffect> = {};
    const rawEffects = new Map<string, ParticleEffect>();
    const aliases = new Map<string, PdxParticleAlias>();
    const roots = uniqueRoots(searchRoots).slice(0, PARTICLE_SEARCH_ROOT_LIMIT);
    const files: string[] = [];
    for (const root of roots) {
        files.push(...await particleResourceFiles(root, PARTICLE_RESOURCE_FILE_LIMIT_PER_ROOT));
    }

    // First index public pdxparticle names from .gfx objectTypes blocks.
    const gfxContents = new Map<string, string>();
    for (const filePath of files) {
        if (path.extname(filePath).toLowerCase() !== '.gfx') continue;
        let content: string;
        try {
            content = await fs.promises.readFile(filePath, 'utf8');
            gfxContents.set(filePath, content);
        } catch (error) {
            ErrorReporter.debug('ParticleResourceResolver', `Failed to read particle object types ${filePath}`, error);
            continue;
        }
        try {
            for (const alias of parsePdxParticleAliases(content)) {
                if (!aliases.has(alias.name)) aliases.set(alias.name, alias);
            }
        } catch (error) {
            ErrorReporter.debug('ParticleResourceResolver', `Failed to parse particle object types ${filePath}`, error);
        }
    }

    // Then resolve the aliases' particle_type targets from particle blocks.
    const missingTypes = terminalParticleTypeNames(wanted, aliases);
    for (const filePath of files) {
        if (missingTypes.size === 0) break;
        let content = gfxContents.get(filePath);
        if (content === undefined) {
            try {
                content = await fs.promises.readFile(filePath, 'utf8');
            } catch (error) {
                ErrorReporter.debug('ParticleResourceResolver', `Failed to read particle asset ${filePath}`, error);
                continue;
            }
        }
        if (![...missingTypes].some(name => content.includes(name)) || !/(^|[^\w])particle\s*=/m.test(content)) continue;
        try {
            for (const effect of parseParticleFile(content, filePath).effects) {
                if (!missingTypes.has(effect.name) || rawEffects.has(effect.name)) continue;
                rawEffects.set(effect.name, effect);
                missingTypes.delete(effect.name);
            }
        } catch (error) {
            ErrorReporter.debug('ParticleResourceResolver', `Failed to parse particle asset ${filePath}`, error);
        }
    }

    for (const name of wanted) {
        const effect = resolvePdxParticleEffect(name, aliases, rawEffects);
        if (!effect) continue;
        effects[name] = effect;
        unresolved.delete(name);
    }

    const textureFiles = new Set<string>();
    for (const effect of Object.values(effects)) collectTextureFiles(effect, textureFiles);
    const textures: Record<string, ParticleTexturePayload> = {};
    for (const file of [...textureFiles].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
        const resolved = resolveTexturePath(file, roots, documentPath);
        if (!resolved) continue;
        const decoded = decodeTexture(resolved);
        if (decoded) textures[file] = { file, ...decoded };
    }

    return { effects, textures, unresolved: [...unresolved].sort() };
}
