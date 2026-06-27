import type {
    AnimatedValue,
    AnimationCurve,
    Force,
    NumberStyle,
    ParticleColor,
    ParticleEffect,
    ParticleTexture,
    ParticleUnknown,
    ParticleVector,
    Range,
    Scalar,
    Span,
    Subsystem,
} from '../webview/particleTypes';
import { isAnimatedValue, isRange } from '../webview/particleTypes';

const INDENT = '\t';

type FieldPathSegment = string | number;

interface FieldDescriptor {
    prop: keyof Subsystem;
    key: string;
    kind: 'scalar' | 'number' | 'string' | 'bool';
}

const SUBSYSTEM_FIELDS: FieldDescriptor[] = [
    { prop: 'name', key: 'name', kind: 'string' },
    { prop: 'maxAmount', key: 'max_amount', kind: 'number' },
    { prop: 'slaveParticles', key: 'slave_particles', kind: 'number' },
    { prop: 'emitterType', key: 'emitter_type', kind: 'string' },
    { prop: 'sort', key: 'sort', kind: 'string' },
    { prop: 'invert', key: 'invert', kind: 'bool' },
    { prop: 'trail', key: 'trail', kind: 'bool' },
    { prop: 'localSpace', key: 'local_space', kind: 'bool' },
    { prop: 'billboard', key: 'billboard', kind: 'bool' },
    { prop: 'hide', key: 'hide', kind: 'bool' },
    { prop: 'mass', key: 'mass', kind: 'scalar' },
    { prop: 'start', key: 'start', kind: 'scalar' },
    { prop: 'duration', key: 'duration', kind: 'scalar' },
    { prop: 'life', key: 'life', kind: 'scalar' },
    { prop: 'emission', key: 'emission', kind: 'scalar' },
    { prop: 'emissionPulseDuration', key: 'emission_pulse_duration', kind: 'scalar' },
    { prop: 'emissionPulseSilence', key: 'emission_pulse_silence', kind: 'scalar' },
    { prop: 'spritesheetAnimation', key: 'spritesheet_animation', kind: 'bool' },
    { prop: 'spritesheetAnimationLoop', key: 'spritesheet_animation_loop', kind: 'number' },
    { prop: 'velocity', key: 'velocity', kind: 'scalar' },
    { prop: 'velocityYaw', key: 'velocity_yaw', kind: 'scalar' },
    { prop: 'velocityPitch', key: 'velocity_pitch', kind: 'scalar' },
    { prop: 'emitterYaw', key: 'emitter_yaw', kind: 'scalar' },
    { prop: 'emitterPitch', key: 'emitter_pitch', kind: 'scalar' },
    { prop: 'size', key: 'size', kind: 'scalar' },
    { prop: 'rotation', key: 'rotation', kind: 'scalar' },
    { prop: 'rotationSpeed', key: 'rotation_speed', kind: 'scalar' },
    { prop: 'rotationSpeedYaw', key: 'rotation_speed_yaw', kind: 'scalar' },
    { prop: 'rotationSpeedPitch', key: 'rotation_speed_pitch', kind: 'scalar' },
    { prop: 'rotationSpeedRoll', key: 'rotation_speed_roll', kind: 'scalar' },
    { prop: 'particleYaw', key: 'particle_yaw', kind: 'scalar' },
    { prop: 'particlePitch', key: 'particle_pitch', kind: 'scalar' },
    { prop: 'particleRoll', key: 'particle_roll', kind: 'scalar' },
    { prop: 'sphereEmitterRadius', key: 'sphere_emitter_radius', kind: 'scalar' },
    { prop: 'sphereEmitterYaw', key: 'sphere_emitter_yaw', kind: 'scalar' },
    { prop: 'sphereEmitterPitch', key: 'sphere_emitter_pitch', kind: 'scalar' },
    { prop: 'boxEmitterX', key: 'box_emitter_x', kind: 'scalar' },
    { prop: 'boxEmitterY', key: 'box_emitter_y', kind: 'scalar' },
    { prop: 'boxEmitterZ', key: 'box_emitter_z', kind: 'scalar' },
    { prop: 'force', key: 'force', kind: 'string' },
];

export function formatNumber(value: number, style: NumberStyle = 'raw'): string {
    if (!Number.isFinite(value)) return '0';
    switch (style) {
        case 'int':
            return String(Math.round(value));
        case 'fixed1':
            return value.toFixed(1);
        case 'fixed2':
            return value.toFixed(2);
        case 'fixed3':
            return value.toFixed(3);
        case 'fixed4':
            return value.toFixed(4);
        case 'fixed5':
            return value.toFixed(5);
        case 'fixed6':
            return value.toFixed(6);
        default:
            if (Math.abs(value) >= 1000 || Math.abs(value) < 0.0001 && value !== 0) {
                return Number(value.toPrecision(6)).toString();
            }
            return Number(value.toFixed(6)).toString();
    }
}

const FORCE_QUOTED_KEYS = new Set(['name', 'file', 'shader', 'op', 'time', 'emitter_type', 'sort', 'type']);

function quoteValue(value: string, force = false): string {
    if (value.length === 0) return '""';
    return force || /[\s#{}=]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function shouldForceQuote(key: string): boolean {
    return FORCE_QUOTED_KEYS.has(key);
}

function formatAnimatedNumber(value: AnimatedValue): string {
    const rawNumber = value.raw?.replace(/%$/, '');
    if (rawNumber && Number.isFinite(Number(rawNumber)) && Number(rawNumber) === value.value) {
        return value.raw!;
    }
    if (value.raw && !Number.isFinite(Number(rawNumber))) {
        return value.raw;
    }
    return formatNumber(value.value, value.rawStyle);
}

export function serializeAnimatedValue(value: AnimatedValue): string {
    const text = formatAnimatedNumber(value);
    const suffixes = [value.curve, ...(value.suffixes ?? [])].filter((item): item is string => !!item);
    return suffixes.length ? `${text},${suffixes.join(',')}` : text;
}

export function serializeRange(value: Range): string {
    const parts = [serializeAnimatedValue(value.a), serializeAnimatedValue(value.b)];
    for (const extra of value.extras ?? []) {
        parts.push(serializeAnimatedValue(extra));
    }
    return `{ ${parts.join(' ')} }`;
}

export function serializeScalar(value: Scalar): string {
    return isRange(value) ? serializeRange(value) : serializeAnimatedValue(value);
}

export function replaceFieldSpan(text: string, span: Span, replacement: string): string {
    return `${text.slice(0, span.startOffset)}${replacement}${text.slice(span.endOffset)}`;
}

function line(depth: number, key: string, value: string): string {
    return `${INDENT.repeat(depth)}${key}=${value}`;
}

function block(depth: number, key: string, body: string[]): string[] {
    return [
        `${INDENT.repeat(depth)}${key}={`,
        ...body,
        `${INDENT.repeat(depth)}}`,
    ];
}

function serializeUnknownEntry(item: ParticleUnknown, depth: number): string[] {
    const indent = INDENT.repeat(depth);
    const raw = item.raw.trim();
    if (!raw) return [];
    return raw.split(/\r?\n/).map(part => `${indent}${part.trimEnd()}`);
}

function orderedLines(
    fieldOrder: string[] | undefined,
    known: Record<string, () => string[]>,
    defaultOrder: string[],
    unknown: ParticleUnknown[] | undefined,
    depth: number,
): string[] {
    const body: string[] = [];
    const emittedKnown = new Set<string>();
    const emittedUnknown = new Set<number>();

    const emitKnown = (key: string): boolean => {
        const factory = known[key];
        if (!factory || emittedKnown.has(key)) return false;
        body.push(...factory());
        emittedKnown.add(key);
        return true;
    };
    const emitUnknown = (key: string): boolean => {
        const index = (unknown ?? []).findIndex((item, i) => !emittedUnknown.has(i) && item.key === key);
        if (index < 0) return false;
        const item = (unknown ?? [])[index];
        if (!item) return false;
        body.push(...serializeUnknownEntry(item, depth));
        emittedUnknown.add(index);
        return true;
    };

    for (const key of fieldOrder ?? []) {
        if (emitKnown(key)) continue;
        emitUnknown(key);
    }
    for (const key of defaultOrder) emitKnown(key);
    (unknown ?? []).forEach((item, index) => {
        if (!emittedUnknown.has(index)) body.push(...serializeUnknownEntry(item, depth));
    });
    return body;
}

function serializeVector(vector: ParticleVector | undefined, key: string, depth: number): string[] {
    if (!vector) return [];
    const known: Record<string, () => string[]> = {
        x: () => vector.x ? [line(depth + 1, 'x', serializeScalar(vector.x))] : [],
        y: () => vector.y ? [line(depth + 1, 'y', serializeScalar(vector.y))] : [],
        z: () => vector.z ? [line(depth + 1, 'z', serializeScalar(vector.z))] : [],
    };
    const body = orderedLines(vector.fieldOrder, known, ['x', 'y', 'z'], vector.unknown, depth + 1);
    return block(depth, key, body);
}

function serializeColor(color: ParticleColor | undefined, depth: number, key = 'color'): string[] {
    if (!color) return [];
    const keys = color.keys ?? {};
    const keyToChannel: Record<string, keyof Pick<ParticleColor, 'r' | 'g' | 'b' | 'alpha'>> = {
        [keys.r ?? 'x']: 'r',
        [keys.g ?? 'y']: 'g',
        [keys.b ?? 'z']: 'b',
        [keys.alpha ?? 'alpha']: 'alpha',
    };
    const known: Record<string, () => string[]> = {};
    for (const [sourceKey, channel] of Object.entries(keyToChannel)) {
        known[sourceKey] = () => color[channel] ? [line(depth + 1, sourceKey, serializeScalar(color[channel]!))] : [];
    }
    const body = orderedLines(color.fieldOrder, known, Object.keys(keyToChannel), color.unknown, depth + 1);
    return block(depth, key, body);
}

function serializeTexture(texture: ParticleTexture | undefined, depth: number): string[] {
    if (!texture) return [];
    const known: Record<string, () => string[]> = {
        file: () => texture.file ? [line(depth + 1, 'file', quoteValue(texture.file, shouldForceQuote('file')))] : [],
        x: () => texture.x !== undefined ? [line(depth + 1, 'x', formatNumber(texture.x, texture.numberStyles?.x ?? 'int'))] : [],
        y: () => texture.y !== undefined ? [line(depth + 1, 'y', formatNumber(texture.y, texture.numberStyles?.y ?? 'int'))] : [],
        shader: () => texture.shader ? [line(depth + 1, 'shader', quoteValue(texture.shader, shouldForceQuote('shader')))] : [],
    };
    const body = orderedLines(texture.fieldOrder, known, ['file', 'x', 'y', 'shader'], texture.unknown, depth + 1);
    return block(depth, 'texture', body);
}

export function serializeSubsystem(subsystem: Subsystem, depth = 1, key = 'subsystem'): string {
    const known: Record<string, () => string[]> = {};
    for (const field of SUBSYSTEM_FIELDS) {
        known[field.key] = () => {
            const value = subsystem[field.prop] as unknown;
            if (value === undefined) return [];
            if (field.kind === 'scalar') {
                return [line(depth + 1, field.key, serializeScalar(value as Scalar))];
            }
            if (field.kind === 'bool') {
                return [line(depth + 1, field.key, value ? 'yes' : 'no')];
            }
            if (field.kind === 'number') {
                const style = subsystem.numberStyles?.[String(field.prop)] ?? (field.key.includes('amount') ? 'int' : 'raw');
                return [line(depth + 1, field.key, formatNumber(value as number, style))];
            }
            return [line(depth + 1, field.key, quoteValue(String(value), shouldForceQuote(field.key)))];
        };
    }
    known.texture = () => serializeTexture(subsystem.texture, depth + 1);
    known.color = () => serializeColor(subsystem.color, depth + 1, 'color');
    known.subsystem_color = () => serializeColor(subsystem.color, depth + 1, 'subsystem_color');
    known.position = () => serializeVector(subsystem.position, 'position', depth + 1);
    known.childsystem = () => (subsystem.childsystems ?? []).map(child => serializeSubsystem(child, depth + 1, 'childsystem'));
    const body = orderedLines(
        subsystem.fieldOrder,
        known,
        [
            ...SUBSYSTEM_FIELDS.map(field => field.key),
            'texture',
            subsystem.fieldOrder?.includes('subsystem_color') ? 'subsystem_color' : 'color',
            'position',
            'childsystem',
        ],
        subsystem.unknown,
        depth + 1,
    );
    return block(depth, key, body).join('\n');
}

export function serializeAnimation(animation: AnimationCurve, depth = 1): string {
    const known: Record<string, () => string[]> = {
        name: () => [line(depth + 1, 'name', quoteValue(animation.name, shouldForceQuote('name')))],
        start: () => [line(depth + 1, 'start', formatNumber(animation.start, animation.numberStyles?.start))],
        duration: () => [line(depth + 1, 'duration', formatNumber(animation.duration, animation.numberStyles?.duration))],
        repeat: () => animation.repeat !== undefined ? [line(depth + 1, 'repeat', animation.repeat ? 'yes' : 'no')] : [],
        minValue: () => [line(depth + 1, 'minValue', formatNumber(animation.minValue, animation.numberStyles?.minValue))],
        maxValue: () => [line(depth + 1, 'maxValue', formatNumber(animation.maxValue, animation.numberStyles?.maxValue))],
        curve: () => {
            if (animation.points.length === 0) return [];
            const values = animation.points.flatMap(point => [formatNumber(point.x), formatNumber(point.y)]);
            return [line(depth + 1, 'curve', `{ ${values.join(' ')} }`)];
        },
        op: () => [line(depth + 1, 'op', quoteValue(animation.op, shouldForceQuote('op')))],
        time: () => [line(depth + 1, 'time', quoteValue(animation.time, shouldForceQuote('time')))],
    };
    const body = orderedLines(
        animation.fieldOrder,
        known,
        ['name', 'start', 'duration', 'repeat', 'minValue', 'maxValue', 'curve', 'op', 'time'],
        animation.unknown,
        depth + 1,
    );
    return block(depth, 'animation', body).join('\n');
}

export function serializeForce(force: Force, depth = 1): string {
    const known: Record<string, () => string[]> = {
        name: () => [line(depth + 1, 'name', quoteValue(force.name, shouldForceQuote('name')))],
        type: () => [line(depth + 1, 'type', quoteValue(force.type, shouldForceQuote('type')))],
        position: () => force.position ? [line(depth + 1, 'position', `{ ${force.position.map(v => formatNumber(v)).join(' ')} }`)] : [],
        direction: () => force.direction ? [line(depth + 1, 'direction', `{ ${force.direction.map(v => formatNumber(v)).join(' ')} }`)] : [],
        local_force: () => force.localForce !== undefined ? [line(depth + 1, 'local_force', force.localForce ? 'yes' : 'no')] : [],
        yaw: () => force.yaw !== undefined ? [line(depth + 1, 'yaw', formatNumber(force.yaw, force.numberStyles?.yaw))] : [],
        division: () => force.division !== undefined ? [line(depth + 1, 'division', formatNumber(force.division, force.numberStyles?.division ?? 'int'))] : [],
        amount: () => force.amount ? [line(depth + 1, 'amount', serializeScalar(force.amount))] : [],
    };
    const body = orderedLines(
        force.fieldOrder,
        known,
        ['name', 'type', 'position', 'direction', 'local_force', 'yaw', 'division', 'amount'],
        force.unknown,
        depth + 1,
    );
    return block(depth, 'force', body).join('\n');
}

export function serializeEffect(effect: ParticleEffect): string {
    const known: Record<string, () => string[]> = {
        name: () => [line(1, 'name', quoteValue(effect.name, shouldForceQuote('name')))],
        scale: () => effect.scale !== undefined ? [line(1, 'scale', formatNumber(effect.scale, effect.numberStyles?.scale))] : [],
        subsystem: () => effect.subsystems.map(subsystem => serializeSubsystem(subsystem, 1)),
        animation: () => effect.animations.map(animation => serializeAnimation(animation, 1)),
        force: () => effect.forces.map(force => serializeForce(force, 1)),
    };
    const body = orderedLines(
        effect.fieldOrder,
        known,
        ['name', 'scale', 'subsystem', 'animation', 'force'],
        effect.unknown,
        1,
    );
    return block(0, 'particle', body).join('\n');
}

export function parseFieldPath(path: Array<string | number>): FieldPathSegment[] {
    return path.map(segment => {
        if (typeof segment === 'number') return segment;
        const numeric = Number(segment);
        return Number.isInteger(numeric) && String(numeric) === segment ? numeric : segment;
    });
}

export function getByFieldPath(root: unknown, rawPath: Array<string | number>): unknown {
    let current: unknown = root;
    for (const segment of parseFieldPath(rawPath)) {
        if (current === undefined || current === null) return undefined;
        current = (current as Record<string, unknown>)[String(segment)];
    }
    return current;
}

export function setByFieldPath(root: unknown, rawPath: Array<string | number>, value: unknown): boolean {
    const path = parseFieldPath(rawPath);
    if (path.length === 0) return false;
    let current = root as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i]!;
        let next = current[String(segment)] as Record<string, unknown> | undefined;
        if (next === undefined || next === null) {
            next = typeof path[i + 1] === 'number' ? [] as unknown as Record<string, unknown> : {};
            current[String(segment)] = next;
        }
        current = next;
    }
    const last = path[path.length - 1]!;
    current[String(last)] = value;
    return true;
}

export function findEditableSpan(value: unknown): Span | undefined {
    if (isAnimatedValue(value as Scalar)) return (value as AnimatedValue).span;
    if (isRange(value as Scalar)) return (value as Range).span;
    return undefined;
}

export function serializeFieldValue(value: unknown, numberStyle?: NumberStyle, forceQuote = false): string | undefined {
    if (isAnimatedValue(value as Scalar) || isRange(value as Scalar)) {
        return serializeScalar(value as Scalar);
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (typeof value === 'number') return formatNumber(value, numberStyle);
    if (typeof value === 'string') return quoteValue(value, forceQuote);
    if (Array.isArray(value) && value.every(item => typeof item === 'number')) {
        return `{ ${value.map(item => formatNumber(item)).join(' ')} }`;
    }
    return undefined;
}
