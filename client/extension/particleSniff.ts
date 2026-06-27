import { tokenize, TokenType } from './pdxTokenizer';

export type AssetFileKind = 'particle' | 'entity' | 'unknown';

/**
 * Classify shared .asset files by top-level blocks. Runtime sniffing is needed
 * because Stellaris keeps both particle and entity definitions under .asset.
 */
export function classifyAssetFile(text: string): AssetFileKind {
    const tokens = tokenize(text);
    let depth = 0;
    let sawEntity = false;

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.type === TokenType.LBrace) {
            depth++;
            continue;
        }
        if (token.type === TokenType.RBrace) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0) continue;

        const isBlock =
            tokens[i + 1]?.type === TokenType.Equals &&
            tokens[i + 2]?.type === TokenType.LBrace;
        if (!isBlock) continue;
        if (token.value === 'particle') return 'particle';
        if (token.value === 'entity') sawEntity = true;
    }

    return sawEntity ? 'entity' : 'unknown';
}
