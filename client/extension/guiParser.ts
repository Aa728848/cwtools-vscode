/**
 * Compatibility shim: the PDXScript GUI/.gfx parser implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/test import sites keep working unchanged.
 */
export {
    parsePdx,
    parseGuiFile,
    parseGuiGfxFile as parseGfxFile,
    buildSpriteIndex,
    serializePosition,
    serializeSize,
    serializeProperty,
    serializeNewElement,
    setGuiParserDebugSink,
} from 'cwtools-shared';
export type { SpriteInfo, PdxNode, GuiElement, GuiParserDebugSink } from 'cwtools-shared';