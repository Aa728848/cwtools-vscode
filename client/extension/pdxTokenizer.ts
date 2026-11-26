/**
 * Compatibility shim: the PDX script tokenizer implementation moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview import sites keep working unchanged.
 */
export { TokenType, Token, TokenizeOptions, tokenize, isIdentStart, isIdentCont } from 'cwtools-shared';
