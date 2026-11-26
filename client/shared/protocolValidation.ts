/**
 * Compatibility shim: the protocol validation primitives moved to
 * cwtools-shared/src/editors (single source). Re-exported here so existing
 * Host/webview/test import sites keep working unchanged.
 */
export {
    isRecord,
    isString,
    isBoolean,
    isFiniteNumber,
    isInteger,
    isArray,
    isObject,
    isStringArray,
    isPresent,
    isIntegerInRange,
    isOneOf,
    isArrayOf,
    optional,
    nullable,
    fields,
    parseProtocolMessage,
} from 'cwtools-shared/editors';
export type { ProtocolRecord, ValueValidator, MessageValidator } from 'cwtools-shared/editors';