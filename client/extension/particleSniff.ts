/**
 * Compatibility shim: the particle/entity asset classifier moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/test import sites keep working unchanged.
 */
export { classifyAssetFile } from 'cwtools-shared';
export type { AssetFileKind } from 'cwtools-shared';
