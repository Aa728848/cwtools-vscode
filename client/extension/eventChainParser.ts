/**
 * Compatibility shim: the catalog-driven event-chain parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/test import sites keep working unchanged.
 */
export {
    selectEventSeedIds,
    parseEventFile,
    parseCommonFile,
    mergeGraphs,
    annotateEventEntryStatus,
    buildMtthConditionEdges,
    buildDefinitionReferenceEdges,
    extractConnectedSubgraph,
} from 'cwtools-shared';
export type {
    SemanticReference,
    EventConditionRelation,
    EventTriggerCondition,
    EventNode,
    EventEntryStatus,
    EventEdge,
    EventGraph,
    ExternalSourceNode,
    CommonFileResult,
} from 'cwtools-shared';
