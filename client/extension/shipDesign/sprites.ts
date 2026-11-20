import { decodeDds, decodeTga } from '../ddsDecoder';
import type { ShipIconDataSource } from '../shipIcon/shipIconDefinitions';
import type { ShipDesignIconData, ShipDesignViewData } from '../../shared/shipDesignProtocol';
import {
    definitionNumber,
    definitionString,
    parseDefinitionFile,
    type DefinitionBlock,
    type DefinitionNode,
} from './definitionNodes';
import { lookupShipDesignComponent, type ShipDesignCatalog } from './definitions';

interface SpriteDefinition {
    name: string;
    textureFile: string;
    frames?: number;
    sheet?: string;
    defaultFrame?: number;
}

interface DecodedIcon {
    dataUri: string;
    width?: number;
    height?: number;
}

const MAX_GFX_FILES = 500;
const MAX_DIRECTORY_VISITS = 4000;
const MAX_TEXTURE_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_ICON_CACHE = 256;
const SPRITE_BLOCKS = new Set([
    'spritetype', 'corneredtilespritetype', 'frameanimatedspritetype',
    'flagspritetype', 'textspritetype', 'progressbartype', 'portraittype',
]);

function key(value: string): string {
    return value.toLowerCase();
}

function collectSprites(fields: readonly DefinitionNode[], index: Map<string, SpriteDefinition>): void {
    const visit = (block: DefinitionBlock): void => {
        if (SPRITE_BLOCKS.has(key(block.key))) {
            const name = definitionString(block.fields, 'name');
            if (name && !index.has(key(name))) {
                const textureFile = definitionString(block.fields, 'texturefile')
                    ?? definitionString(block.fields, 'textureFile')
                    ?? definitionString(block.fields, 'masking_texture')
                    ?? '';
                const variables = new Map<string, number>();
                index.set(key(name), {
                    name,
                    textureFile,
                    frames: definitionNumber(block.fields, 'noOfFrames', variables)?.value,
                    sheet: definitionString(block.fields, 'sprite_sheet_sprite_type'),
                    defaultFrame: definitionNumber(block.fields, 'default_frame', variables)?.value,
                });
            }
        }
        for (const field of block.fields) if (field.kind === 'block') visit(field);
    };
    for (const field of fields) if (field.kind === 'block') visit(field);
}

export class ShipDesignSpriteResolver {
    private indexPromise: Promise<Map<string, SpriteDefinition>> | undefined;
    private readonly iconCache = new Map<string, Promise<ShipDesignIconData | undefined>>();
    private readonly textureCache = new Map<string, DecodedIcon | null>();
    private textureCacheBytes = 0;

    constructor(private readonly source: ShipIconDataSource & { readBinary(path: string): Promise<ArrayBuffer | undefined>; resolvePath(path: string): string | undefined }) {}

    private async collectFiles(directory: string): Promise<string[]> {
        const result: string[] = [];
        const queue = [directory];
        const visited = new Set<string>();
        while (queue.length && result.length < MAX_GFX_FILES && visited.size < MAX_DIRECTORY_VISITS) {
            const current = queue.shift();
            if (!current) continue;
            const folded = key(current);
            if (visited.has(folded)) continue;
            visited.add(folded);
            for (const file of await this.source.listFiles(current)) {
                if (file.toLowerCase().endsWith('.gfx')) result.push(file);
                else if (!file.toLowerCase().includes('.')) queue.push(file);
                if (result.length >= MAX_GFX_FILES) break;
            }
        }
        return result.sort();
    }

    private index(): Promise<Map<string, SpriteDefinition>> {
        if (!this.indexPromise) this.indexPromise = (async () => {
            const index = new Map<string, SpriteDefinition>();
            const files = [
                ...await this.collectFiles('interface'),
                ...await this.collectFiles('gfx'),
            ];
            for (const file of files.slice(0, MAX_GFX_FILES)) {
                const content = await this.source.readText(file);
                if (content !== undefined) collectSprites(parseDefinitionFile(content).fields, index);
            }
            return index;
        })().catch(error => {
            this.indexPromise = undefined;
            throw error;
        });
        return this.indexPromise;
    }

    private cacheTexture(path: string, icon: DecodedIcon | null): void {
        const size = icon?.dataUri.length ?? 0;
        while (this.textureCacheBytes + size > MAX_TEXTURE_CACHE_BYTES && this.textureCache.size) {
            const oldest = this.textureCache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.textureCacheBytes -= this.textureCache.get(oldest)?.dataUri.length ?? 0;
            this.textureCache.delete(oldest);
        }
        this.textureCache.set(path, icon);
        this.textureCacheBytes += size;
    }

    private async decode(relativePath: string, absolutePath: string): Promise<DecodedIcon | null> {
        const folded = key(absolutePath);
        if (this.textureCache.has(folded)) return this.textureCache.get(folded) ?? null;
        let result: DecodedIcon | null = null;
        try {
            if (/\.dds$/i.test(absolutePath)) result = decodeDds(absolutePath);
            else if (/\.tga$/i.test(absolutePath)) result = decodeTga(absolutePath);
            else if (/\.(?:png|jpe?g)$/i.test(absolutePath)) {
                const data = await this.source.readBinary(relativePath);
                if (data) result = {
                    dataUri: 'data:image/' + (/\.png$/i.test(absolutePath) ? 'png' : 'jpeg') + ';base64,' + Buffer.from(data).toString('base64'),
                };
            }
        } catch { result = null; }
        this.cacheTexture(folded, result);
        return result;
    }

    resolve(name: string, requestedFrame?: number): Promise<ShipDesignIconData | undefined> {
        const cacheKey = key(name) + ':' + (requestedFrame ?? 0);
        let cached = this.iconCache.get(cacheKey);
        if (!cached) {
            cached = this.resolveUncached(name, requestedFrame).catch(() => undefined);
            if (this.iconCache.size < MAX_ICON_CACHE) this.iconCache.set(cacheKey, cached);
        }
        return cached;
    }

    private async resolveUncached(name: string, requestedFrame?: number): Promise<ShipDesignIconData | undefined> {
        if (!name) return undefined;
        const index = await this.index();
        const sprite = index.get(key(name));
        if (!sprite) return { key: name, frame: 1, frames: 1 };
        const sheet = sprite.sheet ? index.get(key(sprite.sheet)) : undefined;
        const frames = Math.max(1, Math.floor(sprite.frames ?? sheet?.frames ?? 1));
        const frame = Math.min(frames, Math.max(1, Math.floor(requestedFrame ?? sprite.defaultFrame ?? 1)));
        const result: ShipDesignIconData = { key: name, frame, frames };
        const textureFile = sprite.textureFile || sheet?.textureFile || '';
        if (!textureFile) return result;
        const absolute = this.source.resolvePath(textureFile);
        if (!absolute) return result;
        const decoded = await this.decode(textureFile, absolute);
        if (decoded) {
            result.uri = decoded.dataUri;
            result.width = decoded.width;
            result.height = decoded.height;
        }
        return result;
    }
}

export async function resolveShipDesignViewIcons(
    view: ShipDesignViewData,
    catalog: ShipDesignCatalog,
    resolver: ShipDesignSpriteResolver,
): Promise<void> {
    for (const section of view.sections) {
        for (const slot of section.slots) {
            if (!slot.selected) continue;
            const component = lookupShipDesignComponent(catalog, slot.selected);
            if (component?.icon) slot.icon = await resolver.resolve(component.icon, component.iconFrame);
        }
    }
    for (const slot of view.requiredSlots) {
        if (!slot.selected) continue;
        const component = lookupShipDesignComponent(catalog, slot.selected);
        if (component?.icon) slot.icon = await resolver.resolve(component.icon, component.iconFrame);
    }
}
