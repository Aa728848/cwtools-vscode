/**
 * Compatibility shim: the technology tree parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview import sites keep working unchanged.
 */
export { TechArea, TechNode, TechEdge, TechGraph, applyTechLocalisation, parseTechFile, mergeTechGraphs, extractTechSubgraph } from 'cwtools-shared';
