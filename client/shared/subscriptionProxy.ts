import { isRecord } from './protocolValidation';

export type SubscriptionProxyMode = 'auto' | 'custom' | 'direct';
export type SubscriptionProxySource = 'vscode' | 'environment' | 'system' | 'custom';

/** Addresses sent to the Webview never contain proxy credentials. */
export interface SubscriptionProxyStatus {
    mode: SubscriptionProxyMode;
    customProxyUrl?: string;
    activeProxyUrl?: string;
    source?: SubscriptionProxySource;
    error?: string;
}

export function isSubscriptionProxyMode(value: unknown): value is SubscriptionProxyMode {
    return value === 'auto' || value === 'custom' || value === 'direct';
}

export function isSubscriptionProxyStatus(value: unknown): value is SubscriptionProxyStatus {
    return isRecord(value)
        && isSubscriptionProxyMode(value.mode)
        && (value.customProxyUrl === undefined || typeof value.customProxyUrl === 'string')
        && (value.activeProxyUrl === undefined || typeof value.activeProxyUrl === 'string')
        && (value.source === undefined || (typeof value.source === 'string' && ['vscode', 'environment', 'system', 'custom'].includes(value.source)))
        && (value.error === undefined || typeof value.error === 'string');
}
