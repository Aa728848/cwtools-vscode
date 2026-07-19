/**
 * worldgfx environment preset loader.
 *
 * Scans gfx/worldgfx/*.txt under the given search roots (mod roots first,
 * game directory last — first definition of a world id wins, matching PDX
 * override semantics), parses the Clausewitz gfx_settings block, and resolves
 * the referenced textures (skybox, LUTs, environment cubemap) to webview URIs.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from './ai/errorReporter';
import { resolveCaseInsensitivePath } from './fsCaseInsensitive';
import type { EnvironmentBackground, EnvironmentPreset } from '../webview/environmentTypes';

// ── Clausewitz-lite parser ───────────────────────────────────────────────────

type GfxScalar = string | number;
type GfxValue = GfxScalar | GfxObject | GfxValue[] | { hsv: number[] } | { rgb: number[] };
interface GfxObject { [key: string]: GfxValue | GfxValue[] }
interface GfxStatement { key: string; op: string; value: GfxValue }

interface Token {
    kind: 'lbrace' | 'rbrace' | 'op' | 'word' | 'number' | 'string';
    text: string;
}

function tokenize(content: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    const n = content.length;
    while (i < n) {
        const ch = content[i]!;
        if (ch === '#') {
            while (i < n && content[i] !== '\n') i++;
            continue;
        }
        if (/\s/.test(ch)) { i++; continue; }
        if (ch === '{') { tokens.push({ kind: 'lbrace', text: '{' }); i++; continue; }
        if (ch === '}') { tokens.push({ kind: 'rbrace', text: '}' }); i++; continue; }
        if (ch === '<' || ch === '>' || ch === '=' || ch === '!') {
            let op = ch;
            if (i + 1 < n && content[i + 1] === '=') { op += '='; i++; }
            tokens.push({ kind: 'op', text: op });
            i++;
            continue;
        }
        if (ch === '"') {
            let j = i + 1;
            let text = '';
            while (j < n && content[j] !== '"') { text += content[j]; j++; }
            tokens.push({ kind: 'string', text });
            i = j + 1;
            continue;
        }
        // number or bare word
        let j = i;
        while (j < n && !/[\s{}<>="#!]/.test(content[j]!)) j++;
        const text = content.slice(i, j);
        tokens.push({ kind: /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text) ? 'number' : 'word', text });
        i = j;
    }
    return tokens;
}

class Parser {
    private pos = 0;
    constructor(private readonly tokens: Token[]) { }

    parseDocument(): GfxStatement[] {
        const out: GfxStatement[] = [];
        while (!this.atEnd()) {
            const stmt = this.parseStatement();
            if (stmt) out.push(stmt);
        }
        return out;
    }

    private atEnd(): boolean {
        return this.pos >= this.tokens.length;
    }

    private peek(offset = 0): Token | undefined {
        return this.tokens[this.pos + offset];
    }

    private next(): Token | undefined {
        return this.tokens[this.pos++];
    }

    /** Parse "key op value" or a bare value inside array blocks. */
    private parseStatement(): GfxStatement | null {
        const keyTok = this.next();
        if (!keyTok) return null;
        if (keyTok.kind === 'rbrace') return null;

        const opTok = this.peek();
        if (opTok?.kind !== 'op') {
            // Stray token outside any assignment — skip it.
            return null;
        }
        this.next();
        const value = this.parseValue();
        return { key: keyTok.text, op: opTok.text, value };
    }

    private parseValue(): GfxValue {
        const tok = this.peek();
        if (!tok) return '';
        if (tok.kind === 'lbrace') return this.parseBlock();
        if (tok.kind === 'string') { this.next(); return tok.text; }
        if (tok.kind === 'number') { this.next(); return Number(tok.text); }
        // bare word; check for hsv { ... } / rgb { ... } tagged color blocks
        if (tok.kind === 'word') {
            const word = tok.text.toLowerCase();
            const after = this.peek(1);
            if ((word === 'hsv' || word === 'rgb') && after?.kind === 'lbrace') {
                this.next();
                const block = this.parseBlock();
                const values = Array.isArray(block) ? block.filter(v => typeof v === 'number') as number[] : [];
                return word === 'hsv' ? { hsv: values } : { rgb: values };
            }
            this.next();
            return tok.text;
        }
        // Unexpected token (operator/rbrace) — consume to avoid loops
        this.next();
        return '';
    }

    /** Block = '{' (statements | values) '}' */
    private parseBlock(): GfxObject | GfxValue[] {
        this.next(); // consume '{'
        const statements: GfxStatement[] = [];
        const values: GfxValue[] = [];
        let sawStatement = false;
        while (!this.atEnd() && this.peek()?.kind !== 'rbrace') {
            const start = this.pos;
            const keyTok = this.peek();
            const opTok = this.peek(1);
            if (keyTok && opTok?.kind === 'op' && (keyTok.kind === 'word' || keyTok.kind === 'number' || keyTok.kind === 'string')) {
                const stmt = this.parseStatement();
                if (stmt) { statements.push(stmt); sawStatement = true; }
            } else {
                values.push(this.parseValue());
            }
            if (this.pos === start) this.next(); // safety
        }
        if (this.peek()?.kind === 'rbrace') this.next();
        if (!sawStatement) return values;
        const obj: GfxObject = {};
        for (const stmt of statements) {
            const value: GfxValue = stmt.op === '=' ? stmt.value : { [stmt.op]: stmt.value };
            const existing = obj[stmt.key];
            if (existing === undefined) {
                obj[stmt.key] = value;
            } else if (Array.isArray(existing)) {
                (existing as GfxValue[]).push(value);
            } else {
                obj[stmt.key] = [existing as GfxValue, value];
            }
        }
        return obj;
    }
}

// ── Typed extraction ─────────────────────────────────────────────────────────

function asString(v: GfxValue | GfxValue[] | undefined): string | undefined {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    return undefined;
}

function asNumber(v: GfxValue | GfxValue[] | undefined): number | undefined {
    if (typeof v === 'number') return v;
    return undefined;
}

function asHsvTriplet(v: GfxValue | GfxValue[] | undefined): [number, number, number] | undefined {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'hsv' in v) {
        const arr = (v as { hsv: number[] }).hsv;
        if (arr.length >= 3) return [arr[0]!, arr[1]!, arr[2]!];
    }
    // plain { h s v } array form
    if (Array.isArray(v) && v.length >= 3 && typeof v[0] === 'number') {
        return [v[0] as number, v[1] as number, v[2] as number];
    }
    return undefined;
}

function isYes(v: GfxValue | GfxValue[] | undefined): boolean {
    return v === 'yes' || v === 'true' || v === 1;
}

function triggerToString(v: GfxValue | GfxValue[] | undefined): string | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(v)) {
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            const op = Object.keys(raw)[0];
            const val = (raw as GfxObject)[op!];
            parts.push(`${key} ${op} ${String(val)}`);
        } else if (raw !== undefined) {
            parts.push(`${key} = ${String(raw)}`);
        } else {
            parts.push(key);
        }
    }
    return parts.length > 0 ? parts.join(', ') : undefined;
}

function backgroundLabel(texturePath: string): string {
    const base = path.basename(texturePath).replace(/\.[^.]+$/, '');
    const m = /^sky_(.+)$/.exec(base);
    return (m?.[1] ?? base).toLowerCase();
}

/**
 * Parse one worldgfx .txt file into an EnvironmentPreset (texture paths are
 * left unresolved — caller resolves them against search roots).
 */
export function parseWorldGfxFile(content: string, fileName: string): EnvironmentPreset | null {
    let statements: GfxStatement[];
    try {
        statements = new Parser(tokenize(content)).parseDocument();
    } catch (error) {
        ErrorReporter.debug('WorldgfxPresets', `Failed to parse ${fileName}`, error);
        return null;
    }
    const root: GfxObject = {};
    for (const stmt of statements) {
        if (stmt.op === '=' && root[stmt.key] === undefined) root[stmt.key] = stmt.value;
    }
    const settings = root['gfx_settings'];
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
    const obj = settings as GfxObject;

    const world = asString(obj['world']);
    if (!world) return null;

    const backgrounds: EnvironmentBackground[] = [];
    const bgRaw = obj['galaxy_background'];
    const bgList = Array.isArray(bgRaw) ? bgRaw : bgRaw !== undefined ? [bgRaw] : [];
    for (const entry of bgList) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const bg = entry as GfxObject;
        const texture = asString(bg['texture']);
        if (!texture) continue;
        const bgItem: EnvironmentBackground = {
            texturePath: texture,
            ycocg: isYes(bg['ycocg']),
            label: backgroundLabel(texture),
        };
        const trigger = triggerToString(bg['trigger']);
        if (trigger) bgItem.trigger = trigger;
        backgrounds.push(bgItem);
    }

    const preset: EnvironmentPreset = {
        id: world,
        fileName,
        backgrounds,
    };
    const hsvShift = asHsvTriplet(obj['galaxy_background_hsv_shift']);
    if (hsvShift) preset.backgroundHsvShift = hsvShift;
    const bgLut = asString(obj['galaxy_background_lut']);
    if (bgLut) (preset as { backgroundLutPath?: string }).backgroundLutPath = bgLut;
    const colorLut = asString(obj['color_lut']);
    if (colorLut) (preset as { colorLutPath?: string }).colorLutPath = colorLut;
    const envMap = asString(obj['environment_map']);
    if (envMap) (preset as { environmentMapPath?: string }).environmentMapPath = envMap;
    const cubemapIntensity = asNumber(obj['cubemap_intensity']);
    if (cubemapIntensity !== undefined) preset.cubemapIntensity = cubemapIntensity;
    const ambient = asHsvTriplet(obj['ambient']);
    if (ambient) preset.ambientHsv = ambient;
    const cam1 = asHsvTriplet(obj['cam_light_1_diffuse']);
    if (cam1) preset.camLight1Hsv = cam1;
    const cam2 = asHsvTriplet(obj['cam_light_2_diffuse']);
    if (cam2) preset.camLight2Hsv = cam2;
    const cam3 = asHsvTriplet(obj['cam_light_3_diffuse']);
    if (cam3) preset.camLight3Hsv = cam3;
    const rim = asHsvTriplet(obj['rim_light_diffuse']);
    if (rim) preset.rimLightHsv = rim;
    const back = asHsvTriplet(obj['system_back_light_diffuse']);
    if (back) preset.systemBackLightHsv = back;
    const midGrey = asNumber(obj['tonemap_middlegrey']);
    if (midGrey !== undefined) preset.tonemapMiddleGrey = midGrey;
    const whiteLum = asNumber(obj['tonemap_whiteluminance']);
    if (whiteLum !== undefined) preset.tonemapWhiteLuminance = whiteLum;
    return preset;
}

// ── Filesystem loading ───────────────────────────────────────────────────────

const MAX_WORLDGFX_FILES = 64;

function resolveTexture(relPath: string, searchRoots: string[]): string | undefined {
    const normalized = relPath.trim().replace(/[\\/]+/g, path.sep).replace(/^[\\/]+/, '');
    for (const root of searchRoots) {
        const candidate = path.join(root, normalized);
        if (fs.existsSync(candidate)) return candidate;
        const resolved = resolveCaseInsensitivePath(candidate);
        if (resolved) return resolved;
    }
    return undefined;
}

/**
 * Load all worldgfx presets visible from the given search roots.
 * `toUri` converts an absolute filesystem path to a webview URI.
 */
export function loadEnvironmentPresets(
    searchRoots: string[],
    toUri: (fsPath: string) => string,
): EnvironmentPreset[] {
    const byId = new Map<string, EnvironmentPreset>();

    for (const root of searchRoots) {
        const dir = path.join(root, 'gfx', 'worldgfx');
        let files: string[];
        try {
            files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.txt'));
        } catch {
            continue;
        }
        for (const file of files.slice(0, MAX_WORLDGFX_FILES)) {
            const full = path.join(dir, file);
            let content: string;
            try {
                content = fs.readFileSync(full, 'utf8');
            } catch (error) {
                ErrorReporter.debug('WorldgfxPresets', `Failed to read ${full}`, error);
                continue;
            }
            const preset = parseWorldGfxFile(content, file);
            if (!preset || byId.has(preset.id)) continue;

            // Resolve texture paths → webview URIs
            for (const bg of preset.backgrounds) {
                const resolved = resolveTexture(bg.texturePath, searchRoots);
                if (resolved) bg.textureUri = toUri(resolved);
            }
            const raw = preset as { backgroundLutPath?: string; colorLutPath?: string; environmentMapPath?: string };
            if (raw.backgroundLutPath) {
                const r = resolveTexture(raw.backgroundLutPath, searchRoots);
                if (r) preset.backgroundLutUri = toUri(r);
                delete raw.backgroundLutPath;
            }
            if (raw.colorLutPath) {
                const r = resolveTexture(raw.colorLutPath, searchRoots);
                if (r) preset.colorLutUri = toUri(r);
                delete raw.colorLutPath;
            }
            if (raw.environmentMapPath) {
                const r = resolveTexture(raw.environmentMapPath, searchRoots);
                if (r) preset.environmentMapUri = toUri(r);
                delete raw.environmentMapPath;
            }
            byId.set(preset.id, preset);
        }
    }

    const presets = [...byId.values()];
    presets.sort((a, b) => {
        const rank = (p: EnvironmentPreset) =>
            p.id === 'default' ? 0 : p.id === 'ship_designer' ? 1 : 2;
        const ra = rank(a), rb = rank(b);
        return ra !== rb ? ra - rb : a.id.localeCompare(b.id);
    });
    return presets;
}
