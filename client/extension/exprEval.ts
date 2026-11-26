/**
 * Compatibility shim: the safe arithmetic expression evaluator implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview import sites keep working unchanged.
 */
export { safeEval } from 'cwtools-shared';
