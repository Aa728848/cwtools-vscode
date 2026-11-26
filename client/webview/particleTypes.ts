/**
 * Compatibility shim: the particle transport contract moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview/test import sites keep working unchanged.
 */
export { isRange, isAnimatedValue } from 'cwtools-shared/editors';
export type {
    Span,
    NumberStyle,
    AnimatedValue,
    Range,
    Scalar,
    ParticleUnknown,
    ParticleVector,
    ParticleColor,
    ParticleTexture,
    Subsystem,
    AnimationCurve,
    Force,
    ParticleEffect,
    ParticleDiagnostic,
    ParticleParseResult,
    ParticleTexturePayload,
    ParticleTextureCandidateSource,
    ParticleTextureCandidate,
    ParticleRenderPayload,
} from 'cwtools-shared/editors';