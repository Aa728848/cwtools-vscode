/**
 * Compatibility shim: the GUI preview contract moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview/test import sites keep working unchanged.
 */
export {
    flattenGuiElements,
    createGuiElementReference,
    resolveGuiElementReference,
    isGuiElementReference,
    isGuiRegion,
    isGuiSelection,
    isGuiSelectionContextData,
    isGuiPreviewSnapshot,
} from 'cwtools-shared/editors';
export type {
    GuiElement,
    GuiElementReference,
    GuiRegion,
    GuiSelection,
    GuiSelectionContextData,
    GuiPreviewSnapshot,
    GuiElementAtPath,
} from 'cwtools-shared/editors';