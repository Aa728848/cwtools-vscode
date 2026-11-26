/**
 * Compatibility shim: the Static Galaxy scenario parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/test import sites keep working unchanged.
 */
export { parseStaticGalaxy, toScenarioView } from 'cwtools-shared';
export type {
    OffsetSpan,
    PdxAssignmentNode,
    AxisTransform,
    ParsedAxis,
    ParsedSystem,
    ParsedNebula,
    ParsedHyperlane,
    ParsedScenario,
    StaticGalaxyParseResult,
} from 'cwtools-shared';
