import type { AnimationCurve, Force, ParticleEffect, Scalar, Subsystem } from './particleTypes';
import { isRange } from './particleTypes';
import { evalCurve } from './curveEditor';

export interface ParticleInstanceData {
    count: number;
    positions: Float32Array;
    sizes: Float32Array;
    rotations: Float32Array;
    colors: Float32Array;
    frames: Float32Array;
}

interface ForceMap {
    [name: string]: Force;
}

function scalarValue(value: Scalar | undefined, fallback: number, progress: number, seed: number, curves: Map<string, AnimationCurve>): number {
    if (!value) return fallback;
    if (isRange(value)) {
        const base = animatedValue(value.a, progress, curves);
        const variance = Math.abs(animatedValue(value.b, progress, curves));
        return base + (seeded(seed, 11) * 2 - 1) * variance;
    }
    return animatedValue(value, progress, curves);
}

function animatedValue(value: Scalar, progress: number, curves: Map<string, AnimationCurve>): number {
    if (isRange(value)) return animatedValue(value.a, progress, curves);
    const primaryCurve = value.raw && !isNumericCellText(value.raw) ? curves.get(value.raw) : undefined;
    if (primaryCurve) return animationCurveValue(primaryCurve, progress);
    const curve = value.curve ? curves.get(value.curve) : undefined;
    if (!curve) return value.value;
    const rawCurveValue = rawAnimationCurveValue(curve, progress);
    if (curve.op === 'MUL' || curve.op === 'mul') return value.value * rawCurveValue;
    return curve.minValue + (curve.maxValue - curve.minValue) * rawCurveValue;
}

function isNumericCellText(text: string): boolean {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(text.trim());
}

function animationCurveValue(curve: AnimationCurve, progress: number): number {
    const rawCurveValue = rawAnimationCurveValue(curve, progress);
    if (curve.op === 'MUL' || curve.op === 'mul') return rawCurveValue;
    return curve.minValue + (curve.maxValue - curve.minValue) * rawCurveValue;
}

function rawAnimationCurveValue(curve: AnimationCurve, progress: number): number {
    const localT = Math.max(0, Math.min(1, progress));
    return evalCurve(curve.points, localT);
}

function seeded(seed: number, salt: number): number {
    let value = (seed + 0x9e3779b9 + salt * 2654435761) >>> 0;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return ((value >>> 0) % 10000) / 10000;
}

function degToRad(value: number): number {
    return value * Math.PI / 180;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function directionFromYawPitch(yawDeg: number, pitchDeg: number): [number, number, number] {
    const yaw = degToRad(yawDeg);
    const pitch = degToRad(pitchDeg);
    const cp = Math.cos(pitch);
    return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

function normalize3(vector: [number, number, number], fallback: [number, number, number] = [0, 1, 0]): [number, number, number] {
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    if (length <= 0.00001) return fallback;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function makeBuffer(capacity: number): ParticleInstanceData {
    return {
        count: 0,
        positions: new Float32Array(capacity * 3),
        sizes: new Float32Array(capacity),
        rotations: new Float32Array(capacity),
        colors: new Float32Array(capacity * 4),
        frames: new Float32Array(capacity),
    };
}

export class ParticleSystemSim {
    readonly subsystem: Subsystem;
    readonly capacity: number;
    readonly buffer: ParticleInstanceData;

    private readonly curves: Map<string, AnimationCurve>;
    private readonly forces: ForceMap;
    private readonly active: boolean[];
    private readonly age: Float32Array;
    private readonly life: Float32Array;
    private readonly seed: Uint32Array;
    private readonly px: Float32Array;
    private readonly py: Float32Array;
    private readonly pz: Float32Array;
    private readonly vx: Float32Array;
    private readonly vy: Float32Array;
    private readonly vz: Float32Array;
    private readonly rot: Float32Array;
    private readonly rotSpeed: Float32Array;
    private systemAge = 0;
    private emissionAcc = 0;
    private burstDone = false;

    constructor(subsystem: Subsystem, animations: AnimationCurve[], forces: Force[]) {
        this.subsystem = subsystem;
        this.capacity = Math.max(1, Math.min(2048, subsystem.maxAmount ?? 128));
        this.buffer = makeBuffer(this.capacity);
        this.curves = new Map(animations.map(curve => [curve.name, curve]));
        this.forces = Object.fromEntries(forces.map(force => [force.name, force]));
        this.active = new Array<boolean>(this.capacity).fill(false);
        this.age = new Float32Array(this.capacity);
        this.life = new Float32Array(this.capacity);
        this.seed = new Uint32Array(this.capacity);
        this.px = new Float32Array(this.capacity);
        this.py = new Float32Array(this.capacity);
        this.pz = new Float32Array(this.capacity);
        this.vx = new Float32Array(this.capacity);
        this.vy = new Float32Array(this.capacity);
        this.vz = new Float32Array(this.capacity);
        this.rot = new Float32Array(this.capacity);
        this.rotSpeed = new Float32Array(this.capacity);
        this.reset();
    }

    reset(): void {
        this.systemAge = 0;
        this.emissionAcc = 0;
        this.burstDone = false;
        this.active.fill(false);
        this.buffer.count = 0;
    }

    update(dt: number): void {
        const step = Math.min(0.05, Math.max(0, dt));
        this.systemAge += step;
        this.spawn(step);
        this.integrate(step);
        this.writeInstances();
    }

    private spawn(dt: number): void {
        if (this.subsystem.hide) return;
        const start = scalarValue(this.subsystem.start, 0, 0, 3, this.curves);
        if (this.systemAge < start) return;
        const duration = scalarValue(this.subsystem.duration, -1, 0, 4, this.curves);
        const emission = scalarValue(this.subsystem.emission, duration === 0 ? this.capacity : 24, 0, 7, this.curves);
        if (duration === 0) {
            if (this.burstDone) return;
            this.burstDone = true;
            for (let i = 0; i < Math.min(this.capacity, Math.max(1, Math.round(emission))); i++) this.spawnOne();
            return;
        }
        if (duration >= 0 && this.systemAge > start + duration) return;

        const pulseDuration = scalarValue(this.subsystem.emissionPulseDuration, 0, 0, 5, this.curves);
        const pulseSilence = scalarValue(this.subsystem.emissionPulseSilence, 0, 0, 6, this.curves);
        if (pulseDuration > 0 && pulseSilence > 0) {
            const phase = (this.systemAge - start) % (pulseDuration + pulseSilence);
            if (phase > pulseDuration) return;
        }

        this.emissionAcc += Math.max(0, emission) * dt;
        const count = Math.min(64, Math.floor(this.emissionAcc));
        this.emissionAcc -= count;
        for (let i = 0; i < count; i++) this.spawnOne();
    }

    private spawnOne(): void {
        const index = this.active.findIndex(value => !value);
        if (index < 0) return;
        const seed = ((index + 1) * 2654435761 + Math.floor(this.systemAge * 1000)) >>> 0;
        this.active[index] = true;
        this.seed[index] = seed;
        this.age[index] = 0;
        this.life[index] = Math.max(0.05, scalarValue(this.subsystem.life, 1, 0, seed, this.curves));

        const pos = this.initialPosition(seed);
        this.px[index] = pos[0];
        this.py[index] = pos[1];
        this.pz[index] = pos[2];

        const yaw = scalarValue(this.subsystem.velocityYaw, 0, 0, seed + 1, this.curves) +
            scalarValue(this.subsystem.emitterYaw, 0, 0, seed + 2, this.curves);
        const pitch = scalarValue(this.subsystem.velocityPitch, 0, 0, seed + 3, this.curves) +
            scalarValue(this.subsystem.emitterPitch, 0, 0, seed + 4, this.curves);
        const dir = directionFromYawPitch(yaw, pitch);
        const speed = scalarValue(this.subsystem.velocity, 1, 0, seed + 5, this.curves);
        this.vx[index] = dir[0] * speed;
        this.vy[index] = dir[1] * speed;
        this.vz[index] = dir[2] * speed;
        this.rot[index] = degToRad(scalarValue(this.subsystem.rotation, 0, 0, seed + 6, this.curves));
        this.rotSpeed[index] = degToRad(scalarValue(this.subsystem.rotationSpeed, 0, 0, seed + 7, this.curves));
    }

    private initialPosition(seed: number): [number, number, number] {
        const base: [number, number, number] = [
            scalarValue(this.subsystem.position?.x, 0, 0, seed + 10, this.curves),
            scalarValue(this.subsystem.position?.y, 0, 0, seed + 11, this.curves),
            scalarValue(this.subsystem.position?.z, 0, 0, seed + 12, this.curves),
        ];
        if (this.subsystem.emitterType === 'box') {
            base[0] += scalarValue(this.subsystem.boxEmitterX, 0, 0, seed + 13, this.curves) * (seeded(seed, 14) * 2 - 1);
            base[1] += scalarValue(this.subsystem.boxEmitterY, 0, 0, seed + 15, this.curves) * (seeded(seed, 16) * 2 - 1);
            base[2] += scalarValue(this.subsystem.boxEmitterZ, 0, 0, seed + 17, this.curves) * (seeded(seed, 18) * 2 - 1);
        } else if (this.subsystem.emitterType === 'sphere') {
            const radius = Math.max(0, scalarValue(this.subsystem.sphereEmitterRadius, 1, 0, seed + 19, this.curves));
            if (this.subsystem.sphereEmitterYaw || this.subsystem.sphereEmitterPitch) {
                const yaw = scalarValue(this.subsystem.sphereEmitterYaw, seeded(seed, 20) * 360, 0, seed + 20, this.curves);
                const pitch = scalarValue(this.subsystem.sphereEmitterPitch, 0, 0, seed + 21, this.curves);
                const direction = directionFromYawPitch(yaw, pitch);
                base[0] += direction[0] * radius;
                base[1] += direction[1] * radius;
                base[2] += direction[2] * radius;
            } else {
                const yaw = seeded(seed, 20) * Math.PI * 2;
                const pitch = Math.acos(seeded(seed, 21) * 2 - 1);
                const r = radius * Math.cbrt(seeded(seed, 22));
                base[0] += Math.sin(pitch) * Math.cos(yaw) * r;
                base[1] += Math.cos(pitch) * r;
                base[2] += Math.sin(pitch) * Math.sin(yaw) * r;
            }
        }
        return base;
    }

    private integrate(dt: number): void {
        const force = this.subsystem.force ? this.forces[this.subsystem.force] : undefined;
        for (let i = 0; i < this.capacity; i++) {
            if (!this.active[i]) continue;
            const nextAge = (this.age[i] ?? 0) + dt;
            const life = Math.max(0.001, this.life[i] ?? 1);
            const seed = this.seed[i] ?? 0;
            this.age[i] = nextAge;
            if (nextAge >= life) {
                this.active[i] = false;
                continue;
            }
            const progress = nextAge / life;
            const mass = Math.max(0.05, scalarValue(this.subsystem.mass, 1, progress, seed + 37, this.curves));
            const forceDt = dt / mass;
            if (force?.type === 'friction') {
                const amount = Math.max(0, scalarValue(force.amount, 0.2, progress, seed, this.curves));
                const damp = Math.max(0, 1 - amount * dt);
                this.vx[i] = (this.vx[i] ?? 0) * damp;
                this.vy[i] = (this.vy[i] ?? 0) * damp;
                this.vz[i] = (this.vz[i] ?? 0) * damp;
            } else if (force?.type === 'planar') {
                const direction = force.direction ?? [0, 1, 0];
                const amount = scalarValue(force.amount, 1, progress, seed, this.curves);
                this.vx[i] = (this.vx[i] ?? 0) + (direction[0] ?? 0) * amount * forceDt;
                this.vy[i] = (this.vy[i] ?? 0) + (direction[1] ?? 0) * amount * forceDt;
                this.vz[i] = (this.vz[i] ?? 0) + (direction[2] ?? 0) * amount * forceDt;
            } else if (force?.type === 'vortex') {
                const center = force.position ?? [0, 0, 0];
                const axis = normalize3(force.direction ?? [0, 1, 0]);
                const amount = scalarValue(force.amount, 0.5, progress, seed, this.curves);
                const dx = (this.px[i] ?? 0) - (center[0] ?? 0);
                const dy = (this.py[i] ?? 0) - (center[1] ?? 0);
                const dz = (this.pz[i] ?? 0) - (center[2] ?? 0);
                const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
                const radial: [number, number, number] = [
                    dx - axis[0] * axial,
                    dy - axis[1] * axial,
                    dz - axis[2] * axial,
                ];
                const radialLength = Math.max(0.001, Math.hypot(radial[0], radial[1], radial[2]));
                const tangent = normalize3(cross3(axis, radial), [1, 0, 0]);
                const scale = amount * Math.max(0.25, radialLength / Math.max(1, force.division ?? 16));
                this.vx[i] = (this.vx[i] ?? 0) + tangent[0] * scale * forceDt;
                this.vy[i] = (this.vy[i] ?? 0) + tangent[1] * scale * forceDt;
                this.vz[i] = (this.vz[i] ?? 0) + tangent[2] * scale * forceDt;
            } else if (force?.type === 'turbulence') {
                const amount = scalarValue(force.amount, 1, progress, seed, this.curves);
                const phase = Math.floor((this.systemAge + progress) * Math.max(1, force.division ?? 8));
                this.vx[i] = (this.vx[i] ?? 0) + (seeded(seed + phase, 41) * 2 - 1) * amount * forceDt;
                this.vy[i] = (this.vy[i] ?? 0) + (seeded(seed + phase, 42) * 2 - 1) * amount * forceDt;
                this.vz[i] = (this.vz[i] ?? 0) + (seeded(seed + phase, 43) * 2 - 1) * amount * forceDt;
            }
            this.px[i] = (this.px[i] ?? 0) + (this.vx[i] ?? 0) * dt;
            this.py[i] = (this.py[i] ?? 0) + (this.vy[i] ?? 0) * dt;
            this.pz[i] = (this.pz[i] ?? 0) + (this.vz[i] ?? 0) * dt;
            this.rot[i] = (this.rot[i] ?? 0) + (this.rotSpeed[i] ?? 0) * dt;
        }
    }

    private writeInstances(): void {
        let count = 0;
        const cols = Math.max(1, this.subsystem.texture?.x ?? 1);
        const rows = Math.max(1, this.subsystem.texture?.y ?? 1);
        const frameCount = cols * rows;
        for (let i = 0; i < this.capacity; i++) {
            if (!this.active[i]) continue;
            const seed = this.seed[i] ?? 0;
            const progress = Math.max(0, Math.min(1, (this.age[i] ?? 0) / Math.max(0.001, this.life[i] ?? 1)));
            const posOffset = count * 3;
            const colorOffset = count * 4;
            this.buffer.positions[posOffset] = this.px[i] ?? 0;
            this.buffer.positions[posOffset + 1] = this.py[i] ?? 0;
            this.buffer.positions[posOffset + 2] = this.pz[i] ?? 0;
            this.buffer.sizes[count] = Math.max(0.001, scalarValue(this.subsystem.size, 1, progress, seed + 31, this.curves));
            this.buffer.rotations[count] = this.rot[i] ?? 0;
            this.buffer.colors[colorOffset] = clamp01(scalarValue(this.subsystem.color?.r, 255, progress, seed + 32, this.curves) / 255);
            this.buffer.colors[colorOffset + 1] = clamp01(scalarValue(this.subsystem.color?.g, 255, progress, seed + 33, this.curves) / 255);
            this.buffer.colors[colorOffset + 2] = clamp01(scalarValue(this.subsystem.color?.b, 255, progress, seed + 34, this.curves) / 255);
            this.buffer.colors[colorOffset + 3] = clamp01(scalarValue(this.subsystem.color?.alpha, 255, progress, seed + 35, this.curves) / 255);
            const loop = this.subsystem.spritesheetAnimationLoop ?? (this.subsystem.spritesheetAnimation ? 1 : 0);
            this.buffer.frames[count] = loop
                ? Math.floor((progress * frameCount) % frameCount)
                : frameCount > 1 ? Math.floor(seeded(seed, 36) * frameCount) : 0;
            count++;
        }
        this.buffer.count = count;
    }
}

export class ParticleEffectSimulation {
    readonly systems: ParticleSystemSim[];

    constructor(effect: ParticleEffect) {
        this.systems = effect.subsystems.map(subsystem => new ParticleSystemSim(subsystem, effect.animations, effect.forces));
    }

    reset(): void {
        for (const system of this.systems) system.reset();
    }

    update(dt: number): void {
        for (const system of this.systems) system.update(dt);
    }
}
