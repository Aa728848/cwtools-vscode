export type ProtocolRecord = Record<string, unknown> & { type: string };

export type ValueValidator = (value: unknown) => boolean;
export type MessageValidator = (message: Record<string, unknown>) => boolean;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const isString: ValueValidator = value => typeof value === 'string';
export const isBoolean: ValueValidator = value => typeof value === 'boolean';
export const isFiniteNumber: ValueValidator = value => typeof value === 'number' && Number.isFinite(value);
export const isInteger: ValueValidator = value => typeof value === 'number' && Number.isInteger(value);
export const isArray: ValueValidator = Array.isArray;
export const isObject: ValueValidator = isRecord;
export const isStringArray: ValueValidator = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Accepts any present value (for required fields whose payload is `unknown`). */
export const isPresent: ValueValidator = () => true;

/** Integer bounded to `[min, max]` (inclusive). */
export function isIntegerInRange(min: number, max: number): ValueValidator {
    return value => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isOneOf<const T extends readonly unknown[]>(values: T): ValueValidator {
    return value => values.includes(value);
}

export function isArrayOf(validate: ValueValidator): ValueValidator {
    return value => Array.isArray(value) && value.every(validate);
}

export function optional(validate: ValueValidator): ValueValidator {
    return value => value === undefined || validate(value);
}

export function nullable(validate: ValueValidator): ValueValidator {
    return value => value === null || validate(value);
}

export function fields(
    required: Record<string, ValueValidator> = {},
    optionalFields: Record<string, ValueValidator> = {},
): MessageValidator {
    return message => {
        for (const [field, validate] of Object.entries(required)) {
            if (!(field in message) || !validate(message[field])) return false;
        }
        for (const [field, validate] of Object.entries(optionalFields)) {
            if (field in message && !validate(message[field])) return false;
        }
        return true;
    };
}

export function parseProtocolMessage<T extends { type: string }>(
    input: unknown,
    validators: Record<T['type'], MessageValidator>,
): T | null {
    if (!isRecord(input) || typeof input.type !== 'string') return null;
    const validator = validators[input.type as T['type']];
    if (!validator || !validator(input)) return null;
    return input as T;
}
