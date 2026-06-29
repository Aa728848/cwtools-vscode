import type { AnimatedValue, AnimationCurve, Force, ParticleEffect, Scalar, Subsystem } from './particleTypes';
import { isRange } from './particleTypes';
import { evalCurve } from './curveEditor';
import * as THREE from 'three';

export interface ParticleInstanceData {
    count: number;
    positions: Float32Array;
    trailTails: Float32Array;
    sizes: Float32Array;
    rotations: Float32Array;
    rights: Float32Array;
    ups: Float32Array;
    colors: Float32Array;
    frames: Float32Array;
}

interface ForceMap {
    [name: string]: Force;
}

interface AnimationSampleContext {
    lifeProgress: number;
    particleAge: number;
    lifeSeconds: number;
    systemAge: number;
}

const FRICTION_RESPONSE_SCALE = 2.5;

function scalarValueAt(
    value: Scalar | undefined,
    fallback: number,
    progress: number,
    seed: number,
    curves: Map<string, AnimationCurve>,
    context?: AnimationSampleContext,
): number {
    if (!value) return fallback;
    if (isRange(value)) {
        const base = animatedValue(value.a, progress, curves, context);
        const variance = Math.abs(animatedValue(value.b, progress, curves, context));
        return base + (seeded(seed, 11) * 2 - 1) * variance;
    }
    return animatedValue(value, progress, curves, context);
}

function animatedValue(value: AnimatedValue, progress: number, curves: Map<string, AnimationCurve>, context?: AnimationSampleContext): number {
    const primaryCurve = value.raw && !isNumericCellText(value.raw) ? curves.get(value.raw) : undefined;
    if (primaryCurve) return animationCurveValue(primaryCurve, progress, context);
    const curve = value.curve ? curves.get(value.curve) : undefined;
    if (!curve) return value.value;
    const rawCurveValue = rawAnimationCurveValue(curve, progress, context);
    if (curve.op === 'MUL' || curve.op === 'mul') return value.value * rawCurveValue;
    return curve.minValue + (curve.maxValue - curve.minValue) * rawCurveValue;
}

function isNumericCellText(text: string): boolean {
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(text.trim());
}

function animationCurveValue(curve: AnimationCurve, progress: number, context?: AnimationSampleContext): number {
    const rawCurveValue = rawAnimationCurveValue(curve, progress, context);
    if (curve.op === 'MUL' || curve.op === 'mul') return rawCurveValue;
    return curve.minValue + (curve.maxValue - curve.minValue) * rawCurveValue;
}

function rawAnimationCurveValue(curve: AnimationCurve, progress: number, context?: AnimationSampleContext): number {
    const sourceTime = animationSourceTime(curve, progress, context);
    const duration = curve.duration > 0 ? curve.duration : 1;
    let localT = (sourceTime - curve.start) / duration;
    if (curve.repeat && sourceTime >= curve.start) {
        localT = ((sourceTime - curve.start) % duration) / duration;
    }
    localT = Math.max(0, Math.min(1, localT));
    return evalCurve(curve.points, localT);
}

function animationSourceTime(curve: AnimationCurve, progress: number, context?: AnimationSampleContext): number {
    if (!context) return progress;
    switch (curve.time.toLowerCase()) {
        case 'system':
            return context.systemAge;
        case 'life_abs':
            return context.particleAge;
        case 'spawn':
            return Math.max(0, context.systemAge - context.particleAge);
        case 'life':
        default:
            return context.lifeProgress;
    }
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

function rangeMagnitude(value: Scalar | undefined, progress: number, curves: Map<string, AnimationCurve>, context?: AnimationSampleContext): number {
    if (!value || !isRange(value)) return 0;
    const values = [value.b, ...(value.extras ?? [])];
    return values.reduce((max, item) => Math.max(max, Math.abs(animatedValue(item, progress, curves, context))), 0);
}

function directionFromYawPitch(yawDeg: number, pitchDeg: number): [number, number, number] {
    const yaw = degToRad(yawDeg);
    const pitch = degToRad(pitchDeg);
    const cp = Math.cos(pitch);
    return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

function assetVectorToWorld(vector: [number, number, number]): [number, number, number] {
    // Stellaris particle local X uses negative values for the muzzle-forward axis.
    return [vector[2], vector[1], -vector[0]];
}

function normalize3(vector: [number, number, number], fallback: [number, number, number] = [0, 1, 0]): [number, number, number] {
    const length = Math.hypot(vector[0], vector[1], vector[2]);
    if (length <= 0.00001) return fallback;
    return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function rotateYawVector(vector: [number, number, number], yawDeg: number): [number, number, number] {
    const yaw = degToRad(yawDeg);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [
        vector[0] * c + vector[2] * s,
        vector[1],
        -vector[0] * s + vector[2] * c,
    ];
}

function cross3(a: [number, number, number], b: [number, number, number]): [number, number, number] {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function forceReferenceNames(value: string | undefined): string[] {
    return (value ?? '')
        .split(',')
        .map(name => name.trim().replace(/^"|"$/g, ''))
        .filter(Boolean);
}

function makeBuffer(capacity: number): ParticleInstanceData {
    return {
        count: 0,
        positions: new Float32Array(capacity * 3),
        trailTails: new Float32Array(capacity * 3),
        sizes: new Float32Array(capacity),
        rotations: new Float32Array(capacity),
        rights: new Float32Array(capacity * 3),
        ups: new Float32Array(capacity * 3),
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
    private readonly prevPx: Float32Array;
    private readonly prevPy: Float32Array;
    private readonly prevPz: Float32Array;
    private readonly vx: Float32Array;
    private readonly vy: Float32Array;
    private readonly vz: Float32Array;
    private readonly rot: Float32Array;
    private readonly rotSpeed: Float32Array;
    private readonly orientationRight = new THREE.Vector3();
    private readonly orientationUp = new THREE.Vector3();
    private readonly orientationNormal = new THREE.Vector3();
    private readonly spatialScale: number;
    private systemAge = 0;
    private emissionAcc = 0;
    private burstDone = false;

    constructor(subsystem: Subsystem, animations: AnimationCurve[], forces: Force[], spatialScale = 1) {
        this.subsystem = subsystem;
        this.capacity = Math.max(1, Math.min(2048, subsystem.maxAmount ?? 128));
        this.buffer = makeBuffer(this.capacity);
        this.spatialScale = Math.max(0.001, Math.abs(spatialScale));
        this.curves = new Map(animations.map(curve => [curve.name, curve]));
        this.forces = Object.fromEntries(forces.map(force => [force.name, force]));
        this.active = new Array<boolean>(this.capacity).fill(false);
        this.age = new Float32Array(this.capacity);
        this.life = new Float32Array(this.capacity);
        this.seed = new Uint32Array(this.capacity);
        this.px = new Float32Array(this.capacity);
        this.py = new Float32Array(this.capacity);
        this.pz = new Float32Array(this.capacity);
        this.prevPx = new Float32Array(this.capacity);
        this.prevPy = new Float32Array(this.capacity);
        this.prevPz = new Float32Array(this.capacity);
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
        const systemContext: AnimationSampleContext = {
            lifeProgress: 0,
            particleAge: 0,
            lifeSeconds: 1,
            systemAge: this.systemAge,
        };
        const start = scalarValueAt(this.subsystem.start, 0, 0, 3, this.curves, systemContext);
        if (this.systemAge < start) return;
        const duration = scalarValueAt(this.subsystem.duration, -1, 0, 4, this.curves, systemContext);
        const emission = scalarValueAt(this.subsystem.emission, duration === 0 ? this.capacity : 24, 0, 7, this.curves, systemContext);
        if (duration === 0) {
            if (this.burstDone) return;
            this.burstDone = true;
            for (let i = 0; i < Math.min(this.capacity, Math.max(1, Math.round(emission))); i++) this.spawnOne();
            return;
        }
        if (duration >= 0 && this.systemAge > start + duration) return;

        const pulseDuration = scalarValueAt(this.subsystem.emissionPulseDuration, 0, 0, 5, this.curves, systemContext);
        const pulseSilence = scalarValueAt(this.subsystem.emissionPulseSilence, 0, 0, 6, this.curves, systemContext);
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
        const systemContext: AnimationSampleContext = {
            lifeProgress: 0,
            particleAge: 0,
            lifeSeconds: 1,
            systemAge: this.systemAge,
        };
        this.life[index] = Math.max(0.05, scalarValueAt(this.subsystem.life, 1, 0, seed, this.curves, systemContext));
        const spawnContext: AnimationSampleContext = {
            ...systemContext,
            lifeSeconds: this.life[index] ?? 1,
        };

        const pos = this.initialPosition(seed, spawnContext);
        this.px[index] = pos[0];
        this.py[index] = pos[1];
        this.pz[index] = pos[2];
        this.prevPx[index] = pos[0];
        this.prevPy[index] = pos[1];
        this.prevPz[index] = pos[2];

        const yaw = scalarValueAt(this.subsystem.velocityYaw, 0, 0, seed + 1, this.curves, spawnContext) +
            scalarValueAt(this.subsystem.emitterYaw, 0, 0, seed + 2, this.curves, spawnContext);
        const pitch = scalarValueAt(this.subsystem.velocityPitch, 0, 0, seed + 3, this.curves, spawnContext) +
            scalarValueAt(this.subsystem.emitterPitch, 0, 0, seed + 4, this.curves, spawnContext);
        const dir = directionFromYawPitch(yaw, pitch);
        const speed = scalarValueAt(this.subsystem.velocity, 1, 0, seed + 5, this.curves, spawnContext) * this.spatialScale;
        this.vx[index] = dir[0] * speed;
        this.vy[index] = dir[1] * speed;
        this.vz[index] = dir[2] * speed;
        this.rot[index] = degToRad(scalarValueAt(this.subsystem.rotation, 0, 0, seed + 6, this.curves, spawnContext));
        this.rotSpeed[index] = degToRad(scalarValueAt(this.subsystem.rotationSpeed, 0, 0, seed + 7, this.curves, spawnContext));
    }

    private initialPosition(seed: number, context: AnimationSampleContext): [number, number, number] {
        const base = assetVectorToWorld([
            scalarValueAt(this.subsystem.position?.x, 0, 0, seed + 10, this.curves, context) * this.spatialScale,
            scalarValueAt(this.subsystem.position?.y, 0, 0, seed + 11, this.curves, context) * this.spatialScale,
            scalarValueAt(this.subsystem.position?.z, 0, 0, seed + 12, this.curves, context) * this.spatialScale,
        ]);
        if (this.subsystem.emitterType === 'box') {
            base[2] += scalarValueAt(this.subsystem.boxEmitterX, 0, 0, seed + 13, this.curves, context) * this.spatialScale * (seeded(seed, 14) * 2 - 1);
            base[1] += scalarValueAt(this.subsystem.boxEmitterY, 0, 0, seed + 15, this.curves, context) * this.spatialScale * (seeded(seed, 16) * 2 - 1);
            base[0] += scalarValueAt(this.subsystem.boxEmitterZ, 0, 0, seed + 17, this.curves, context) * this.spatialScale * (seeded(seed, 18) * 2 - 1);
        } else if (this.subsystem.emitterType === 'sphere') {
            const radius = Math.max(0, scalarValueAt(this.subsystem.sphereEmitterRadius, 1, 0, seed + 19, this.curves, context) * this.spatialScale);
            if (this.subsystem.sphereEmitterYaw || this.subsystem.sphereEmitterPitch) {
                const yaw = scalarValueAt(this.subsystem.sphereEmitterYaw, seeded(seed, 20) * 360, 0, seed + 20, this.curves, context);
                const pitch = scalarValueAt(this.subsystem.sphereEmitterPitch, 0, 0, seed + 21, this.curves, context);
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

    private forceDirection(force: Force, fallback: [number, number, number] = [0, 1, 0]): [number, number, number] {
        return rotateYawVector(assetVectorToWorld(force.direction ?? fallback), force.yaw ?? 0);
    }

    private forceAxis(force: Force, fallback: [number, number, number] = [0, 1, 0]): [number, number, number] {
        return normalize3(this.forceDirection(force, fallback), fallback);
    }

    private forcePosition(force: Force): [number, number, number] {
        const position = rotateYawVector(assetVectorToWorld(force.position ?? [0, 0, 0]), force.yaw ?? 0);
        return [
            position[0] * this.spatialScale,
            position[1] * this.spatialScale,
            position[2] * this.spatialScale,
        ];
    }

    private spatialForceAmount(force: Force, fallback: number, progress: number, seed: number, context?: AnimationSampleContext): number {
        return scalarValueAt(force.amount, fallback, progress, seed, this.curves, context) * this.spatialScale;
    }

    private subsystemForces(): Force[] {
        return forceReferenceNames(this.subsystem.force)
            .map(name => this.forces[name])
            .filter((force): force is Force => !!force);
    }

    private integrate(dt: number): void {
        const activeForces = this.subsystemForces();
        const singleFriction = activeForces.length === 1 && activeForces[0]?.type === 'friction' ? activeForces[0] : undefined;
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
            const context: AnimationSampleContext = {
                lifeProgress: progress,
                particleAge: nextAge,
                lifeSeconds: life,
                systemAge: this.systemAge,
            };
            const mass = Math.max(0.05, scalarValueAt(this.subsystem.mass, 1, progress, seed + 37, this.curves, context));
            const forceDt = dt / mass;
            this.prevPx[i] = this.px[i] ?? 0;
            this.prevPy[i] = this.py[i] ?? 0;
            this.prevPz[i] = this.pz[i] ?? 0;
            let moveVx = this.vx[i] ?? 0;
            let moveVy = this.vy[i] ?? 0;
            let moveVz = this.vz[i] ?? 0;
            let usedExactFriction = false;
            if (singleFriction) {
                const amount = Math.max(0, scalarValueAt(singleFriction.amount, 0.2, progress, seed, this.curves, context));
                const drag = amount * FRICTION_RESPONSE_SCALE / mass;
                const damp = Math.exp(-drag * dt);
                const displacementScale = drag > 0.000001 ? (1 - damp) / (drag * dt) : 1;
                moveVx *= displacementScale;
                moveVy *= displacementScale;
                moveVz *= displacementScale;
                this.vx[i] = (this.vx[i] ?? 0) * damp;
                this.vy[i] = (this.vy[i] ?? 0) * damp;
                this.vz[i] = (this.vz[i] ?? 0) * damp;
                usedExactFriction = true;
            } else {
                const startVx = this.vx[i] ?? 0;
                const startVy = this.vy[i] ?? 0;
                const startVz = this.vz[i] ?? 0;
                for (const force of activeForces) {
                    if (force.type === 'friction') {
                        const amount = Math.max(0, scalarValueAt(force.amount, 0.2, progress, seed, this.curves, context));
                        const damp = Math.exp(-amount * FRICTION_RESPONSE_SCALE * forceDt);
                        this.vx[i] = (this.vx[i] ?? 0) * damp;
                        this.vy[i] = (this.vy[i] ?? 0) * damp;
                        this.vz[i] = (this.vz[i] ?? 0) * damp;
                    } else if (force.type === 'planar') {
                        const direction = this.forceDirection(force);
                        const amount = this.spatialForceAmount(force, 1, progress, seed, context);
                        this.vx[i] = (this.vx[i] ?? 0) + (direction[0] ?? 0) * amount * forceDt;
                        this.vy[i] = (this.vy[i] ?? 0) + (direction[1] ?? 0) * amount * forceDt;
                        this.vz[i] = (this.vz[i] ?? 0) + (direction[2] ?? 0) * amount * forceDt;
                    } else if (force.type === 'point') {
                        const center = this.forcePosition(force);
                        const amount = this.spatialForceAmount(force, 1, progress, seed, context);
                        const dx = (this.px[i] ?? 0) - center[0];
                        const dy = (this.py[i] ?? 0) - center[1];
                        const dz = (this.pz[i] ?? 0) - center[2];
                        const radialLength = Math.max(0.001, Math.hypot(dx, dy, dz));
                        const fallback = this.forceAxis(force, [1, 0, 0]);
                        const radial: [number, number, number] = radialLength > 0.001 ? [dx / radialLength, dy / radialLength, dz / radialLength] : fallback;
                        const falloff = 1 / Math.max(0.25, radialLength / Math.max(1, force.division ?? 16));
                        this.vx[i] = (this.vx[i] ?? 0) + radial[0] * amount * falloff * forceDt;
                        this.vy[i] = (this.vy[i] ?? 0) + radial[1] * amount * falloff * forceDt;
                        this.vz[i] = (this.vz[i] ?? 0) + radial[2] * amount * falloff * forceDt;
                    } else if (force.type === 'spin') {
                        const center = this.forcePosition(force);
                        const axis = this.forceAxis(force);
                        const amount = this.spatialForceAmount(force, 1, progress, seed, context);
                        const dx = (this.px[i] ?? 0) - center[0];
                        const dy = (this.py[i] ?? 0) - center[1];
                        const dz = (this.pz[i] ?? 0) - center[2];
                        const axial = dx * axis[0] + dy * axis[1] + dz * axis[2];
                        const radial: [number, number, number] = [
                            dx - axis[0] * axial,
                            dy - axis[1] * axial,
                            dz - axis[2] * axial,
                        ];
                        const tangent = normalize3(cross3(axis, radial), [1, 0, 0]);
                        const radialLength = Math.max(0.001, Math.hypot(radial[0], radial[1], radial[2]));
                        const strength = amount * Math.max(0.25, radialLength / Math.max(1, force.division ?? 16));
                        this.vx[i] = (this.vx[i] ?? 0) + tangent[0] * strength * forceDt;
                        this.vy[i] = (this.vy[i] ?? 0) + tangent[1] * strength * forceDt;
                        this.vz[i] = (this.vz[i] ?? 0) + tangent[2] * strength * forceDt;
                    } else if (force.type === 'vortex') {
                        const center = this.forcePosition(force);
                        const axis = this.forceAxis(force);
                        const amount = this.spatialForceAmount(force, 0.5, progress, seed, context);
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
                    } else if (force.type === 'turbulence') {
                        const amount = this.spatialForceAmount(force, 1, progress, seed, context);
                        const phase = Math.floor((this.systemAge + progress) * Math.max(1, force.division ?? 8));
                        this.vx[i] = (this.vx[i] ?? 0) + (seeded(seed + phase, 41) * 2 - 1) * amount * forceDt;
                        this.vy[i] = (this.vy[i] ?? 0) + (seeded(seed + phase, 42) * 2 - 1) * amount * forceDt;
                        this.vz[i] = (this.vz[i] ?? 0) + (seeded(seed + phase, 43) * 2 - 1) * amount * forceDt;
                    }
                }
                if (activeForces.length > 0) {
                    moveVx = (startVx + (this.vx[i] ?? 0)) * 0.5;
                    moveVy = (startVy + (this.vy[i] ?? 0)) * 0.5;
                    moveVz = (startVz + (this.vz[i] ?? 0)) * 0.5;
                }
            }
            if (!usedExactFriction) {
                moveVx = activeForces.length > 0 ? moveVx : this.vx[i] ?? 0;
                moveVy = activeForces.length > 0 ? moveVy : this.vy[i] ?? 0;
                moveVz = activeForces.length > 0 ? moveVz : this.vz[i] ?? 0;
            }
            this.px[i] = (this.px[i] ?? 0) + moveVx * dt;
            this.py[i] = (this.py[i] ?? 0) + moveVy * dt;
            this.pz[i] = (this.pz[i] ?? 0) + moveVz * dt;
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
            const ageSeconds = this.age[i] ?? 0;
            const lifeSeconds = Math.max(0.001, this.life[i] ?? 1);
            const progress = Math.max(0, Math.min(1, ageSeconds / lifeSeconds));
            const context: AnimationSampleContext = {
                lifeProgress: progress,
                particleAge: ageSeconds,
                lifeSeconds,
                systemAge: this.systemAge,
            };
            const posOffset = count * 3;
            const colorOffset = count * 4;
            this.buffer.positions[posOffset] = this.px[i] ?? 0;
            this.buffer.positions[posOffset + 1] = this.py[i] ?? 0;
            this.buffer.positions[posOffset + 2] = this.pz[i] ?? 0;
            this.buffer.sizes[count] = Math.max(0.001, scalarValueAt(this.subsystem.size, 1, progress, seed + 31, this.curves, context) * this.spatialScale);
            this.writeTrailTail(count, i);
            this.buffer.rotations[count] = this.rot[i] ?? 0;
            this.writeOrientation(count, progress, seed, ageSeconds, lifeSeconds, context);
            this.buffer.colors[colorOffset] = clamp01(scalarValueAt(this.subsystem.color?.r, 255, progress, seed + 32, this.curves, context) / 255);
            this.buffer.colors[colorOffset + 1] = clamp01(scalarValueAt(this.subsystem.color?.g, 255, progress, seed + 33, this.curves, context) / 255);
            this.buffer.colors[colorOffset + 2] = clamp01(scalarValueAt(this.subsystem.color?.b, 255, progress, seed + 34, this.curves, context) / 255);
            this.buffer.colors[colorOffset + 3] = clamp01(scalarValueAt(this.subsystem.color?.alpha, 255, progress, seed + 35, this.curves, context) / 255);
            this.buffer.frames[count] = this.frameForParticle(frameCount, progress, ageSeconds, seed);
            count++;
        }
        this.buffer.count = count;
    }

    private frameForParticle(frameCount: number, progress: number, ageSeconds: number, seed: number): number {
        if (frameCount <= 1) return 0;
        if (this.subsystem.spritesheetAnimation === false) {
            return Math.floor(seeded(seed, 36) * frameCount);
        }
        if (this.subsystem.spritesheetAnimation === true && (this.subsystem.spritesheetAnimationLoop ?? 0) > 0) {
            const loopSeconds = Math.max(0.001, this.subsystem.spritesheetAnimationLoop ?? 1);
            return Math.floor((ageSeconds / loopSeconds * frameCount) % frameCount);
        }
        return Math.min(frameCount - 1, Math.floor(progress * frameCount));
    }

    private writeTrailTail(outputIndex: number, particleIndex: number): void {
        const offset = outputIndex * 3;
        const px = this.px[particleIndex] ?? 0;
        const py = this.py[particleIndex] ?? 0;
        const pz = this.pz[particleIndex] ?? 0;
        if (!this.subsystem.trail) {
            this.buffer.trailTails[offset] = px;
            this.buffer.trailTails[offset + 1] = py;
            this.buffer.trailTails[offset + 2] = pz;
            return;
        }

        const speed = Math.hypot(this.vx[particleIndex] ?? 0, this.vy[particleIndex] ?? 0, this.vz[particleIndex] ?? 0);
        const age = this.age[particleIndex] ?? 0;
        const size = this.buffer.sizes[outputIndex] ?? 1;
        if (speed > 0.0001) {
            const length = Math.max(
                Math.hypot(px - (this.prevPx[particleIndex] ?? px), py - (this.prevPy[particleIndex] ?? py), pz - (this.prevPz[particleIndex] ?? pz)),
                Math.min(size * 6, speed * Math.min(age, 0.25)),
            );
            this.buffer.trailTails[offset] = px - (this.vx[particleIndex] ?? 0) / speed * length;
            this.buffer.trailTails[offset + 1] = py - (this.vy[particleIndex] ?? 0) / speed * length;
            this.buffer.trailTails[offset + 2] = pz - (this.vz[particleIndex] ?? 0) / speed * length;
            return;
        }

        this.buffer.trailTails[offset] = this.prevPx[particleIndex] ?? px;
        this.buffer.trailTails[offset + 1] = this.prevPy[particleIndex] ?? py;
        this.buffer.trailTails[offset + 2] = this.prevPz[particleIndex] ?? pz;
    }

    private writeOrientation(index: number, progress: number, seed: number, ageSeconds: number, lifeSeconds: number, context: AnimationSampleContext): void {
        const yawBase = scalarValueAt(this.subsystem.particleYaw, 0, progress, seed + 38, this.curves, context);
        const pitchBase = scalarValueAt(this.subsystem.particlePitch, 0, progress, seed + 39, this.curves, context);
        const rollBase = scalarValueAt(this.subsystem.particleRoll, 0, progress, seed + 40, this.curves, context);
        const yawSpeed = scalarValueAt(this.subsystem.rotationSpeedYaw, 0, progress, seed + 41, this.curves, context);
        const pitchSpeed = scalarValueAt(this.subsystem.rotationSpeedPitch, 0, progress, seed + 42, this.curves, context);
        const rollSpeed = scalarValueAt(this.subsystem.rotationSpeedRoll, 0, progress, seed + 43, this.curves, context);
        const flutter = this.orientationFlutter(progress, seed, ageSeconds, lifeSeconds, context);
        const yaw = degToRad(yawBase + yawSpeed * ageSeconds + flutter.yaw);
        const pitch = degToRad(pitchBase + pitchSpeed * ageSeconds + flutter.pitch);
        const roll = degToRad(rollBase + rollSpeed * ageSeconds + flutter.roll);

        this.orientationRight.set(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();
        this.orientationUp.set(0, 1, 0).applyAxisAngle(this.orientationRight, pitch).normalize();
        this.orientationNormal.crossVectors(this.orientationRight, this.orientationUp).normalize();
        if (Math.abs(roll) > 0.00001) {
            this.orientationRight.applyAxisAngle(this.orientationNormal, roll).normalize();
            this.orientationUp.applyAxisAngle(this.orientationNormal, roll).normalize();
        }

        const offset = index * 3;
        this.buffer.rights[offset] = this.orientationRight.x;
        this.buffer.rights[offset + 1] = this.orientationRight.y;
        this.buffer.rights[offset + 2] = this.orientationRight.z;
        this.buffer.ups[offset] = this.orientationUp.x;
        this.buffer.ups[offset + 1] = this.orientationUp.y;
        this.buffer.ups[offset + 2] = this.orientationUp.z;
    }

    private orientationFlutter(progress: number, seed: number, ageSeconds: number, lifeSeconds: number, context: AnimationSampleContext): { yaw: number; pitch: number; roll: number } {
        if (this.subsystem.billboard !== false) return { yaw: 0, pitch: 0, roll: 0 };
        const shortLife = clamp01((0.45 - lifeSeconds) / 0.35);
        if (shortLife <= 0) return { yaw: 0, pitch: 0, roll: 0 };
        const yawRange = rangeMagnitude(this.subsystem.particleYaw, progress, this.curves, context);
        const pitchRange = rangeMagnitude(this.subsystem.particlePitch, progress, this.curves, context);
        const rollRange = rangeMagnitude(this.subsystem.particleRoll, progress, this.curves, context);
        const totalRange = yawRange + pitchRange + rollRange;
        if (totalRange <= 0.001) return { yaw: 0, pitch: 0, roll: 0 };
        const cycle = (ageSeconds * (12 + seeded(seed, 51) * 18) + progress * 0.35) * Math.PI * 2;
        const phaseA = seeded(seed, 52) * Math.PI * 2;
        const phaseB = seeded(seed, 53) * Math.PI * 2;
        const phaseC = seeded(seed, 54) * Math.PI * 2;
        return {
            yaw: Math.sin(cycle + phaseA) * yawRange * 0.35 * shortLife,
            pitch: Math.sin(cycle + phaseB) * pitchRange * 0.35 * shortLife,
            roll: Math.sin(cycle + phaseC) * Math.max(rollRange, totalRange * 0.35) * 0.3 * shortLife,
        };
    }
}

export class ParticleEffectSimulation {
    readonly systems: ParticleSystemSim[];

    constructor(effect: ParticleEffect) {
        this.systems = effect.subsystems.map(subsystem => new ParticleSystemSim(subsystem, effect.animations, effect.forces, effect.scale ?? 1));
    }

    reset(): void {
        for (const system of this.systems) system.reset();
    }

    update(dt: number): void {
        for (const system of this.systems) system.update(dt);
    }
}
