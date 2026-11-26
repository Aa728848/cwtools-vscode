/**
 * Compatibility shim: the entity/asset parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview import sites keep working unchanged.
 */
export { LocatorOverride, AttachDefinition, MeshSettingOverride, StateDefinition, StateParticleEvent, EntityDefinition, MeshDefinition, EntityGraph, parseAssetFile, parseGfxFile, buildEntityGraph } from 'cwtools-shared';
