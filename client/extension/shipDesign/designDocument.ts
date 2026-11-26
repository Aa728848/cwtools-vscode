/**
 * Compatibility shim: the ship-design parser, format-preserving edit builder and
 * draft session moved to cwtools-shared/src/editors/shipDesign (single source).
 * Re-exported here so existing Host/test import sites keep working unchanged.
 */
export {
    parseShipDesignDocument,
    applyShipDesignOperation,
    ShipDesignDraftSession,
    ShipDesignEditError,
} from 'cwtools-shared/editors';
export type {
    ShipDesignParseResult,
    ShipDesignTextEdit,
    ShipDesignEditResult,
} from 'cwtools-shared/editors';
