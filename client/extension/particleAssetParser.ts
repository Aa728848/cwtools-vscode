import { tokenize, TokenType, type Token } from './pdxTokenizer';
import type {
    AnimatedValue,
    AnimationCurve,
    Force,
    NumberStyle,
    ParticleColor,
    ParticleDiagnostic,
    ParticleEffect,
    ParticleParseResult,
    ParticleTexture,
    ParticleUnknown,
    ParticleVector,
    Range,
    Scalar,
    Span,
    Subsystem,
} from '../webview/particleTypes';

interface ParseCtx {
    tokens: Token[];
    pos: number;
    text: string;
    diagnostics: ParticleDiagnostic[];
    constants: Record<string, number>;
}

const SUBSYSTEM_SCALAR_KEYS: Record<string, keyof Subsystem> = {
    mass: 'mass',
    start: 'start',
    duration: 'duration',
    life: 'life',
    emission: 'emission',
    emission_pulse_duration: 'emissionPulseDuration',
    emission_pulse_silence: 'emissionPulseSilence',
    velocity: 'velocity',
    velocity_yaw: 'velocityYaw',
    velocity_pitch: 'velocityPitch',
    emitter_yaw: 'emitterYaw',
    emitter_pitch: 'emitterPitch',
    size: 'size',
    rotation: 'rotation',
    rotation_speed: 'rotationSpeed',
    rotation_speed_yaw: 'rotationSpeedYaw',
    rotation_speed_pitch: 'rotationSpeedPitch',
    rotation_speed_roll: 'rotationSpeedRoll',
    particle_yaw: 'particleYaw',
    particle_pitch: 'particlePitch',
    particle_roll: 'particleRoll',
    sphere_emitter_radius: 'sphereEmitterRadius',
    sphere_emitter_yaw: 'sphereEmitterYaw',
    sphere_emitter_pitch: 'sphereEmitterPitch',
    box_emitter_x: 'boxEmitterX',
    box_emitter_y: 'boxEmitterY',
    box_emitter_z: 'boxEmitterZ',
};

const SUBSYSTEM_NUMBER_KEYS: Record<string, keyof Subsystem> = {
    max_amount: 'maxAmount',
    slave_particles: 'slaveParticles',
    spritesheet_animation_loop: 'spritesheetAnimationLoop',
};

const SUBSYSTEM_STRING_KEYS: Record<string, keyof Subsystem> = {
    name: 'name',
    emitter_type: 'emitterType',
    sort: 'sort',
    force: 'force',
};

const SUBSYSTEM_BOOL_KEYS: Record<string, keyof Subsystem> = {
    invert: 'invert',
    trail: 'trail',
    local_space: 'localSpace',
    billboard: 'billboard',
    hide: 'hide',
    spritesheet_animation: 'spritesheetAnimation',
};

function peek(ctx: ParseCtx, offset = 0): Token | undefined {
    return ctx.tokens[ctx.pos + offset];
}

function advance(ctx: ParseCtx): Token {
    return ctx.tokens[ctx.pos++] ?? ctx.tokens[ctx.tokens.length - 1]!;
}

function extractConstants(tokens: Token[]): Record<string, number> {
    const constants: Record<string, number> = {};
    for (let i = 0; i < tokens.length - 2; i++) {
        const key = tokens[i]!;
        if (key.value.startsWith('@') && tokens[i + 1]?.type === TokenType.Equals) {
            const value = tokens[i + 2]!;
            const parsed = parseFloat(value.value);
            if (!Number.isNaN(parsed)) {
                constants[key.value] = parsed;
            }
        }
    }
    return constants;
}

function lineOfOffset(text: string, offset: number): number {
    let line = 1;
    const limit = Math.max(0, Math.min(offset, text.length));
    for (let i = 0; i < limit; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

function makeSpan(ctx: ParseCtx, startOffset: number, endOffset: number): Span {
    const safeStart = Math.max(0, Math.min(startOffset, ctx.text.length));
    const safeEnd = Math.max(safeStart, Math.min(endOffset, ctx.text.length));
    return {
        line: lineOfOffset(ctx.text, safeStart),
        endLine: lineOfOffset(ctx.text, safeEnd),
        startOffset: safeStart,
        endOffset: safeEnd,
    };
}

function spanFromTokens(ctx: ParseCtx, start: Token, end: Token): Span {
    return makeSpan(ctx, start.startOffset, end.endOffset);
}

function styleOf(raw: string): NumberStyle {
    if (/^[+-]?\d+$/.test(raw)) return 'int';
    if (/^[+-]?\d+\.\d$/.test(raw)) return 'fixed1';
    if (/^[+-]?\d+\.\d{2}$/.test(raw)) return 'fixed2';
    if (/^[+-]?\d+\.\d{3}$/.test(raw)) return 'fixed3';
    if (/^[+-]?\d+\.\d{4}$/.test(raw)) return 'fixed4';
    if (/^[+-]?\d+\.\d{5}$/.test(raw)) return 'fixed5';
    if (/^[+-]?\d+\.\d{6}$/.test(raw)) return 'fixed6';
    return 'raw';
}

function tokenNumber(ctx: ParseCtx, token: Token | undefined): number {
    if (!token) return 0;
    if (token.value.startsWith('@')) return ctx.constants[token.value] ?? 1;
    const parsed = parseFloat(token.value.replace(/%$/, ''));
    return Number.isFinite(parsed) ? parsed : 0;
}

function tokenText(token: Token | undefined): string {
    return token?.value.replace(/^"|"$/g, '') ?? '';
}

function expect(ctx: ParseCtx, value: string): Token {
    const token = advance(ctx);
    if (token.value !== value) {
        throw new Error(`Expected '${value}', got '${token.value}' at line ${token.line}`);
    }
    return token;
}

function skipBlock(ctx: ParseCtx): Token {
    let depth = 1;
    let last = peek(ctx) ?? ctx.tokens[ctx.tokens.length - 1]!;
    while (ctx.pos < ctx.tokens.length && depth > 0) {
        const token = advance(ctx);
        last = token;
        if (token.type === TokenType.LBrace) depth++;
        else if (token.type === TokenType.RBrace) depth--;
    }
    return last;
}

function skipValueRaw(ctx: ParseCtx, key: Token): ParticleUnknown {
    const start = key.startOffset;
    const next = peek(ctx);
    let end = key.endOffset;
    if (next?.type === TokenType.LBrace) {
        advance(ctx);
        end = skipBlock(ctx).endOffset;
    } else if (next) {
        end = advance(ctx).endOffset;
    }
    return {
        key: key.value,
        raw: ctx.text.slice(start, end),
        span: makeSpan(ctx, start, end),
    };
}

function readAnimatedValue(ctx: ParseCtx): AnimatedValue {
    const first = advance(ctx);
    const raw = first.value;
    let end = first;
    let curve: string | undefined;
    const suffixes: string[] = [];
    while (peek(ctx)?.type === TokenType.Comma) {
        advance(ctx);
        const curveToken = advance(ctx);
        if (curve === undefined) curve = curveToken.value;
        else suffixes.push(curveToken.value);
        end = curveToken;
    }
    if (curve === undefined && peek(ctx)?.type === TokenType.Identifier && first.type === TokenType.Number) {
        // Fallback for providers/files that collapse "1.0,curve" into adjacent tokens.
        const maybeCurve = peek(ctx)!;
        if (maybeCurve.startOffset === first.endOffset) {
            curve = advance(ctx).value;
            end = maybeCurve;
        }
    }
    return {
        value: tokenNumber(ctx, first),
        curve,
        suffixes: suffixes.length ? suffixes : undefined,
        rawStyle: styleOf(raw),
        raw,
        span: spanFromTokens(ctx, first, end),
    };
}

function readRange(ctx: ParseCtx): Range {
    const start = expect(ctx, '{');
    const values: AnimatedValue[] = [];
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        if (peek(ctx)!.type === TokenType.Comma) {
            advance(ctx);
            continue;
        }
        if (peek(ctx)!.type === TokenType.Number || peek(ctx)!.type === TokenType.Identifier) {
            values.push(readAnimatedValue(ctx));
        } else {
            advance(ctx);
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    const first = values[0] ?? { value: 0, rawStyle: 'int', raw: '0', span: spanFromTokens(ctx, start, start) };
    const second = values[1] ?? first;
    const range: Range = {
        a: first,
        b: second,
        span: spanFromTokens(ctx, start, end),
    };
    if (values.length > 2) {
        range.extras = values.slice(2);
    }
    return range;
}

function readScalar(ctx: ParseCtx): Scalar {
    if (peek(ctx)?.type === TokenType.LBrace) return readRange(ctx);
    return readAnimatedValue(ctx);
}

function readString(ctx: ParseCtx): { value: string; span: Span } {
    const token = advance(ctx);
    return { value: tokenText(token), span: spanFromTokens(ctx, token, token) };
}

function readCommaStringList(ctx: ParseCtx): { value: string; span: Span } {
    const first = advance(ctx);
    const values = [tokenText(first)];
    let end = first;
    while (peek(ctx)?.type === TokenType.Comma) {
        advance(ctx);
        const next = peek(ctx);
        if (!next || next.type === TokenType.EOF || next.type === TokenType.RBrace) break;
        end = advance(ctx);
        values.push(tokenText(end));
    }
    return { value: values.filter(Boolean).join(','), span: spanFromTokens(ctx, first, end) };
}

function readNumber(ctx: ParseCtx): { value: number; span: Span; rawStyle: NumberStyle; raw: string } {
    const token = advance(ctx);
    return {
        value: tokenNumber(ctx, token),
        span: spanFromTokens(ctx, token, token),
        rawStyle: styleOf(token.value),
        raw: token.value,
    };
}

function readBool(ctx: ParseCtx): { value: boolean; span: Span } {
    const token = advance(ctx);
    const value = /^(yes|true|1)$/i.test(token.value);
    return { value, span: spanFromTokens(ctx, token, token) };
}

function ensureSpans<T extends { spans?: Record<string, Span> }>(target: T): Record<string, Span> {
    target.spans ??= {};
    return target.spans;
}

function parseVectorBlock(ctx: ParseCtx): ParticleVector {
    const start = expect(ctx, '{');
    const vector: ParticleVector = { unknown: [], fieldOrder: [] };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        vector.fieldOrder!.push(key.value);
        if (key.value === 'x' || key.value === 'y' || key.value === 'z') {
            vector[key.value] = readScalar(ctx);
        } else {
            vector.unknown!.push(skipValueRaw(ctx, key));
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    vector.span = spanFromTokens(ctx, start, end);
    return vector;
}

function parseColorBlock(ctx: ParseCtx): ParticleColor {
    const start = expect(ctx, '{');
    const color: ParticleColor = { keys: {}, unknown: [], fieldOrder: [] };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        color.fieldOrder!.push(key.value);
        const channel =
            key.value === 'x' || key.value === 'r' ? 'r' :
            key.value === 'y' || key.value === 'g' ? 'g' :
            key.value === 'z' || key.value === 'b' ? 'b' :
            key.value === 'alpha' ? 'alpha' : undefined;
        if (channel) {
            color[channel] = readScalar(ctx);
            color.keys![channel] = key.value;
        } else {
            color.unknown!.push(skipValueRaw(ctx, key));
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    color.span = spanFromTokens(ctx, start, end);
    return color;
}

function parseTextureBlock(ctx: ParseCtx): ParticleTexture {
    const start = expect(ctx, '{');
    const texture: ParticleTexture = { file: '', spans: {}, unknown: [], fieldOrder: [], numberStyles: {} };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        texture.fieldOrder!.push(key.value);
        switch (key.value) {
            case 'file': {
                const value = readString(ctx);
                texture.file = value.value;
                texture.spans!.file = value.span;
                break;
            }
            case 'x':
            case 'y': {
                const value = readNumber(ctx);
                texture[key.value] = value.value;
                texture.spans![key.value] = value.span;
                texture.numberStyles![key.value] = value.rawStyle;
                break;
            }
            case 'shader': {
                const value = readString(ctx);
                texture.shader = value.value;
                texture.spans!.shader = value.span;
                break;
            }
            default:
                texture.unknown!.push(skipValueRaw(ctx, key));
                break;
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    texture.span = spanFromTokens(ctx, start, end);
    return texture;
}

function parseFloatArrayBlock(ctx: ParseCtx): { values: number[]; span: Span } {
    const start = expect(ctx, '{');
    const values: number[] = [];
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const token = advance(ctx);
        if (token.type === TokenType.Number || token.type === TokenType.Identifier) {
            values.push(tokenNumber(ctx, token));
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    return { values, span: spanFromTokens(ctx, start, end) };
}

function parseSubsystemBlock(ctx: ParseCtx, keyToken: Token): Subsystem {
    const start = expect(ctx, '{');
    const subsystem: Subsystem = { unknown: [], childsystems: [], spans: {}, fieldOrder: [], numberStyles: {} };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        subsystem.fieldOrder!.push(key.value);
        try {
            if (key.value in SUBSYSTEM_SCALAR_KEYS) {
                const prop = SUBSYSTEM_SCALAR_KEYS[key.value]!;
                (subsystem as Record<string, unknown>)[prop] = readScalar(ctx);
            } else if (key.value in SUBSYSTEM_NUMBER_KEYS) {
                const prop = SUBSYSTEM_NUMBER_KEYS[key.value]!;
                const value = readNumber(ctx);
                (subsystem as Record<string, unknown>)[prop] = value.value;
                ensureSpans(subsystem)[String(prop)] = value.span;
                subsystem.numberStyles![String(prop)] = value.rawStyle;
            } else if (key.value in SUBSYSTEM_STRING_KEYS) {
                const prop = SUBSYSTEM_STRING_KEYS[key.value]!;
                const value = key.value === 'force' ? readCommaStringList(ctx) : readString(ctx);
                (subsystem as Record<string, unknown>)[prop] = value.value;
                ensureSpans(subsystem)[String(prop)] = value.span;
            } else if (key.value in SUBSYSTEM_BOOL_KEYS) {
                const prop = SUBSYSTEM_BOOL_KEYS[key.value]!;
                const value = readBool(ctx);
                (subsystem as Record<string, unknown>)[prop] = value.value;
                ensureSpans(subsystem)[String(prop)] = value.span;
            } else {
                switch (key.value) {
                    case 'texture':
                        subsystem.texture = parseTextureBlock(ctx);
                        break;
                    case 'color':
                    case 'subsystem_color':
                        subsystem.color = parseColorBlock(ctx);
                        break;
                    case 'position':
                        subsystem.position = parseVectorBlock(ctx);
                        break;
                    case 'childsystem':
                        subsystem.childsystems!.push(parseSubsystemBlock(ctx, key));
                        break;
                    default:
                        subsystem.unknown!.push(skipValueRaw(ctx, key));
                        break;
                }
            }
        } catch (error) {
            ctx.diagnostics.push({
                severity: 'warning',
                line: key.line,
                message: `Could not parse subsystem field "${key.value}": ${error instanceof Error ? error.message : String(error)}`,
            });
            subsystem.unknown!.push(skipValueRaw(ctx, key));
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    subsystem.span = makeSpan(ctx, keyToken.startOffset, end.endOffset);
    return subsystem;
}

function parseAnimationBlock(ctx: ParseCtx, keyToken: Token): AnimationCurve {
    const start = expect(ctx, '{');
    const animation: AnimationCurve = {
        name: '',
        start: 0,
        duration: 1,
        minValue: 0,
        maxValue: 1,
        points: [],
        op: 'MUL',
        time: 'life',
        spans: {},
        fieldOrder: [],
        numberStyles: {},
        unknown: [],
    };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        animation.fieldOrder!.push(key.value);
        switch (key.value) {
            case 'name': {
                const value = readString(ctx);
                animation.name = value.value;
                animation.spans!.name = value.span;
                break;
            }
            case 'start':
            case 'duration':
            case 'minValue':
            case 'maxValue': {
                const value = readNumber(ctx);
                (animation as unknown as Record<string, unknown>)[key.value] = value.value;
                animation.spans![key.value] = value.span;
                animation.numberStyles![key.value] = value.rawStyle;
                break;
            }
            case 'repeat': {
                const value = readBool(ctx);
                animation.repeat = value.value;
                animation.spans!.repeat = value.span;
                break;
            }
            case 'op':
            case 'time': {
                const value = readString(ctx);
                (animation as unknown as Record<string, unknown>)[key.value] = value.value;
                animation.spans![key.value] = value.span;
                break;
            }
            case 'curve': {
                const { values, span } = parseFloatArrayBlock(ctx);
                animation.points = [];
                for (let i = 0; i < values.length; i += 2) {
                    animation.points.push({ x: values[i] ?? 0, y: values[i + 1] ?? 0 });
                }
                animation.spans!.curve = span;
                break;
            }
            default:
                animation.unknown!.push(skipValueRaw(ctx, key));
                break;
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    animation.span = makeSpan(ctx, keyToken.startOffset, end.endOffset);
    return animation;
}

function parseForceBlock(ctx: ParseCtx, keyToken: Token): Force {
    const start = expect(ctx, '{');
    const force: Force = { name: '', type: 'planar', spans: {}, fieldOrder: [], numberStyles: {}, unknown: [] };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        force.fieldOrder!.push(key.value);
        switch (key.value) {
            case 'name':
            case 'type': {
                const value = readString(ctx);
                (force as unknown as Record<string, unknown>)[key.value] = value.value;
                force.spans![key.value] = value.span;
                break;
            }
            case 'position':
            case 'direction': {
                const { values, span } = parseFloatArrayBlock(ctx);
                force[key.value] = [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0];
                force.spans![key.value] = span;
                break;
            }
            case 'local_force': {
                const value = readBool(ctx);
                force.localForce = value.value;
                force.spans!.localForce = value.span;
                break;
            }
            case 'yaw': {
                const value = readNumber(ctx);
                force.yaw = value.value;
                force.spans!.yaw = value.span;
                force.numberStyles!.yaw = value.rawStyle;
                break;
            }
            case 'division': {
                const value = readNumber(ctx);
                force.division = value.value;
                force.spans!.division = value.span;
                force.numberStyles!.division = value.rawStyle;
                break;
            }
            case 'amount':
                force.amount = readScalar(ctx);
                break;
            default:
                force.unknown!.push(skipValueRaw(ctx, key));
                break;
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    force.span = makeSpan(ctx, keyToken.startOffset, end.endOffset);
    return force;
}

function parseEffectBlock(ctx: ParseCtx, keyToken: Token): ParticleEffect {
    const start = expect(ctx, '{');
    const effect: ParticleEffect = {
        name: '',
        subsystems: [],
        animations: [],
        forces: [],
        spans: {},
        fieldOrder: [],
        numberStyles: {},
        unknown: [],
    };
    while (peek(ctx) && peek(ctx)!.type !== TokenType.RBrace && peek(ctx)!.type !== TokenType.EOF) {
        const key = advance(ctx);
        if (peek(ctx)?.type !== TokenType.Equals) {
            continue;
        }
        advance(ctx);
        effect.fieldOrder!.push(key.value);
        try {
            switch (key.value) {
                case 'name': {
                    const value = readString(ctx);
                    effect.name = value.value;
                    effect.spans!.name = value.span;
                    break;
                }
                case 'scale': {
                    const value = readNumber(ctx);
                    effect.scale = value.value;
                    effect.spans!.scale = value.span;
                    effect.numberStyles!.scale = value.rawStyle;
                    break;
                }
                case 'type':
                    // Some historical files wrap the real particle type through this field.
                    effect.unknown!.push(skipValueRaw(ctx, key));
                    break;
                case 'subsystem':
                    effect.subsystems.push(parseSubsystemBlock(ctx, key));
                    break;
                case 'animation':
                    effect.animations.push(parseAnimationBlock(ctx, key));
                    break;
                case 'force':
                    effect.forces.push(parseForceBlock(ctx, key));
                    break;
                default:
                    effect.unknown!.push(skipValueRaw(ctx, key));
                    break;
            }
        } catch (error) {
            ctx.diagnostics.push({
                severity: 'warning',
                line: key.line,
                message: `Could not parse particle field "${key.value}": ${error instanceof Error ? error.message : String(error)}`,
            });
            effect.unknown!.push(skipValueRaw(ctx, key));
        }
    }
    const end = peek(ctx)?.type === TokenType.RBrace ? advance(ctx) : start;
    effect.span = makeSpan(ctx, keyToken.startOffset, end.endOffset);
    if (!effect.name) effect.name = `particle_${effect.span.line}`;
    return effect;
}

export function parseParticleFile(text: string, filePath = ''): ParticleParseResult {
    const tokens = tokenize(text, { comma: true });
    const ctx: ParseCtx = {
        tokens,
        pos: 0,
        text,
        diagnostics: [],
        constants: extractConstants(tokens),
    };
    const effects: ParticleEffect[] = [];

    while (ctx.pos < ctx.tokens.length) {
        const token = peek(ctx);
        if (!token || token.type === TokenType.EOF) break;
        if (
            token.value === 'particle' &&
            peek(ctx, 1)?.type === TokenType.Equals &&
            peek(ctx, 2)?.type === TokenType.LBrace
        ) {
            const key = advance(ctx);
            advance(ctx);
            try {
                effects.push(parseEffectBlock(ctx, key));
            } catch (error) {
                ctx.diagnostics.push({
                    severity: 'error',
                    line: key.line,
                    message: `Could not parse particle block in ${filePath || 'asset'}: ${error instanceof Error ? error.message : String(error)}`,
                });
                if (peek(ctx)?.type === TokenType.LBrace) {
                    advance(ctx);
                    skipBlock(ctx);
                }
            }
        } else {
            advance(ctx);
        }
    }

    return { effects, diagnostics: ctx.diagnostics };
}
