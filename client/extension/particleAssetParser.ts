/**
 * Compatibility shim: the particle (.asset) parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/test import sites keep working unchanged.
 */
export { parseParticleFile } from 'cwtools-shared';
