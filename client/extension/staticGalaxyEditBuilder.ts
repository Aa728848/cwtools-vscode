/**
 * Compatibility shim: the Static Galaxy edit builder moved to
 * cwtools-shared/src/editors/staticGalaxyEditBuilder (single source). Re-exported
 * here so existing Host/test import sites keep working unchanged.
 */
export {
    buildStaticGalaxyEdits,
    StaticGalaxyEditError,
} from 'cwtools-shared/editors';
export type {
    StaticGalaxyEditContext,
    StaticGalaxyMoveRequest,
    StaticGalaxyEditRequest,
    StaticGalaxyReplacement,
    StaticGalaxyBuiltEdit,
} from 'cwtools-shared/editors';
