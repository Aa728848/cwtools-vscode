/**
 * Compatibility shim: the PDX semantic catalog contract/parser moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview/test import sites keep working unchanged.
 */
export {
    normalizePdxDirectoryPath,
    matchPdxDefinitionType,
    parsePdxSemanticCatalog,
} from 'cwtools-shared';
export type {
    PdxRuleCategory,
    CwtRuleValueReference,
    CwtShaderReference,
    PdxDirectoryPath,
    PdxSemanticCatalog,
    PdxDefinitionType,
} from 'cwtools-shared';
