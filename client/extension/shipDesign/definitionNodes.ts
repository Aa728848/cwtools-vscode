/**
 * Compatibility shim: the definition-file node helpers moved to
 * cwtools-shared/src/editors/shipDesign/definitionNodes (single source).
 * Re-exported here so existing Host/test import sites keep working unchanged.
 */
export {
    parseDefinitionFile,
    definitionScalars,
    definitionBlocks,
    firstDefinitionScalar,
    firstDefinitionBlock,
    definitionString,
    definitionBoolean,
    resolveDefinitionNumber,
    definitionNumber,
    definitionNumericFields,
    definitionItems,
    collectDefinitionItemsDeep,
    mergeDefinitionVariables,
} from 'cwtools-shared/editors';
export type {
    DefinitionScalar,
    DefinitionBlock,
    DefinitionNode,
    DefinitionFile,
    DefinitionNumber,
} from 'cwtools-shared/editors';
