export interface Span {
    /** 1-based line number for display. */
    line: number;
    /** 1-based ending line number for display. */
    endLine: number;
    /** 0-based absolute UTF-16 offset in the source document. */
    startOffset: number;
    /** 0-based exclusive absolute UTF-16 offset in the source document. */
    endOffset: number;
}

export type NumberStyle = 'int' | 'fixed1' | 'fixed2' | 'fixed3' | 'fixed4' | 'fixed5' | 'fixed6' | 'raw';

export interface AnimatedValue {
    value: number;
    curve?: string;
    /** Additional comma-suffix entries after the first curve/value slot. */
    suffixes?: string[];
    rawStyle?: NumberStyle;
    raw?: string;
    span?: Span;
}

export interface Range {
    a: AnimatedValue;
    b: AnimatedValue;
    /** Extra values are uncommon, but vanilla files occasionally contain 3-4 entries. */
    extras?: AnimatedValue[];
    span?: Span;
}

export type Scalar = AnimatedValue | Range;

export interface ParticleUnknown {
    key?: string;
    raw: string;
    span?: Span;
}

export interface ParticleVector {
    x?: Scalar;
    y?: Scalar;
    z?: Scalar;
    span?: Span;
    fieldOrder?: string[];
    unknown?: ParticleUnknown[];
}

export interface ParticleColor {
    r?: Scalar;
    g?: Scalar;
    b?: Scalar;
    alpha?: Scalar;
    /** Original source keys, normally x/y/z/alpha, kept for block serialization. */
    keys?: Partial<Record<'r' | 'g' | 'b' | 'alpha', string>>;
    span?: Span;
    fieldOrder?: string[];
    unknown?: ParticleUnknown[];
}

export interface ParticleTexture {
    file: string;
    x?: number;
    y?: number;
    shader?: string;
    span?: Span;
    spans?: Partial<Record<'file' | 'x' | 'y' | 'shader', Span>>;
    fieldOrder?: string[];
    numberStyles?: Partial<Record<'x' | 'y', NumberStyle>>;
    unknown?: ParticleUnknown[];
}

export interface Subsystem {
    name?: string;
    maxAmount?: number;
    slaveParticles?: number;
    emitterType?: 'point' | 'sphere' | 'box' | string;
    sort?: 'depth' | 'age' | 'distance' | string;
    invert?: boolean;
    trail?: boolean;
    localSpace?: boolean;
    billboard?: boolean;
    hide?: boolean;
    spritesheetAnimation?: boolean;
    spritesheetAnimationLoop?: number;
    texture?: ParticleTexture;
    color?: ParticleColor;
    position?: ParticleVector;
    mass?: Scalar;
    start?: Scalar;
    duration?: Scalar;
    life?: Scalar;
    emission?: Scalar;
    emissionPulseDuration?: Scalar;
    emissionPulseSilence?: Scalar;
    velocity?: Scalar;
    velocityYaw?: Scalar;
    velocityPitch?: Scalar;
    emitterYaw?: Scalar;
    emitterPitch?: Scalar;
    size?: Scalar;
    rotation?: Scalar;
    rotationSpeed?: Scalar;
    rotationSpeedYaw?: Scalar;
    rotationSpeedPitch?: Scalar;
    rotationSpeedRoll?: Scalar;
    particleYaw?: Scalar;
    particlePitch?: Scalar;
    particleRoll?: Scalar;
    sphereEmitterRadius?: Scalar;
    sphereEmitterYaw?: Scalar;
    sphereEmitterPitch?: Scalar;
    boxEmitterX?: Scalar;
    boxEmitterY?: Scalar;
    boxEmitterZ?: Scalar;
    force?: string;
    childsystems?: Subsystem[];
    /** Spans for scalar/string/bool fields whose model value is not a Scalar object. */
    spans?: Record<string, Span>;
    fieldOrder?: string[];
    numberStyles?: Record<string, NumberStyle>;
    unknown?: ParticleUnknown[];
    span?: Span;
}

export interface AnimationCurve {
    name: string;
    start: number;
    duration: number;
    repeat?: boolean;
    minValue: number;
    maxValue: number;
    points: Array<{ x: number; y: number }>;
    op: 'MUL' | string;
    time: 'life' | 'life_abs' | 'system' | 'spawn' | string;
    spans?: Record<string, Span>;
    fieldOrder?: string[];
    numberStyles?: Record<string, NumberStyle>;
    span?: Span;
    unknown?: ParticleUnknown[];
}

export interface Force {
    name: string;
    type: 'planar' | 'friction' | 'point' | 'spin' | 'turbulence' | 'vortex' | string;
    position?: [number, number, number];
    direction?: [number, number, number];
    localForce?: boolean;
    yaw?: number;
    division?: number;
    amount?: Scalar;
    spans?: Record<string, Span>;
    fieldOrder?: string[];
    numberStyles?: Record<string, NumberStyle>;
    span?: Span;
    unknown?: ParticleUnknown[];
}

export interface ParticleEffect {
    name: string;
    scale?: number;
    subsystems: Subsystem[];
    animations: AnimationCurve[];
    forces: Force[];
    spans?: Record<string, Span>;
    fieldOrder?: string[];
    numberStyles?: Record<string, NumberStyle>;
    unknown?: ParticleUnknown[];
    span?: Span;
}

export interface ParticleDiagnostic {
    message: string;
    line: number;
    severity: 'error' | 'warning';
}

export interface ParticleParseResult {
    effects: ParticleEffect[];
    diagnostics: ParticleDiagnostic[];
}

export interface ParticleTexturePayload {
    file: string;
    dataUri: string;
    width: number;
    height: number;
}

export type ParticleTextureCandidateSource = 'mod' | 'vanilla' | 'mod+vanilla';

export interface ParticleTextureCandidate {
    file: string;
    source: ParticleTextureCandidateSource;
}

export interface ParticleRenderPayload {
    effects: ParticleEffect[];
    diagnostics: ParticleDiagnostic[];
    fileName: string;
    selectedEffectIndex: number;
    textures: Record<string, ParticleTexturePayload>;
    textureCandidates: ParticleTextureCandidate[];
    readonly: boolean;
}

export function isRange(value: Scalar | undefined): value is Range {
    return !!value && typeof value === 'object' && 'a' in value && 'b' in value;
}

export function isAnimatedValue(value: Scalar | undefined): value is AnimatedValue {
    return !!value && typeof value === 'object' && 'value' in value;
}
