/**
 * Compatibility shim: the Static Galaxy protocol contract moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview/test import sites keep working unchanged.
 */
export {
    STATIC_GALAXY_MAX_MOVES,
    STATIC_GALAXY_MAX_LANE_LINKS,
    STATIC_GALAXY_MAX_SPRAY_SYSTEMS,
    STATIC_GALAXY_MAX_COORDINATE,
    isStaticGalaxyAxis,
    isStaticGalaxyPosition,
    isStaticGalaxyAxisUpdate,
    isStaticGalaxySystemMove,
    isStaticGalaxyPositionUpdate,
    isStaticGalaxyHyperlaneUpdate,
    parseStaticGalaxyWebviewMessage,
} from 'cwtools-shared/editors';
export type {
    StaticGalaxyAxis,
    StaticGalaxyPosition,
    StaticGalaxyDiagnosticSeverity,
    StaticGalaxyDiagnosticView,
    StaticGalaxyInitializerInfo,
    StaticGalaxySystemView,
    StaticGalaxyNebulaView,
    StaticGalaxyHyperlaneKind,
    StaticGalaxyHyperlaneView,
    StaticGalaxyScenarioSettings,
    StaticGalaxyBounds,
    StaticGalaxyScenarioView,
    StaticGalaxyRevision,
    StaticGalaxyDocumentState,
    StaticGalaxySystemMove,
    StaticGalaxyAxisUpdate,
    StaticGalaxyPositionUpdate,
    StaticGalaxyHyperlaneUpdate,
    StaticGalaxyEditRejectCode,
    StaticGalaxyHostMessage,
    StaticGalaxyWebviewMessage,
} from 'cwtools-shared/editors';
