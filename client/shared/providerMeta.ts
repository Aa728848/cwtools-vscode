/** Provider metadata sent to the settings WebView */
export interface ProviderMeta {
    id: string;
    name: string;
    models: string[];
    inlineModels?: string[];
    defaultModel: string;
    requiresApiKey: boolean;
    defaultEndpoint: string;
    /** User-saved endpoint override for this provider (empty if none). */
    userEndpoint?: string;
    supportsFIM: boolean;
    maxContextTokens?: number;
    registerUrl?: string;
    runtimeKind?: 'http';
    authKind?: 'api-key' | 'none' | 'chatgpt-oauth' | 'antigravity-oauth';
    supportsUtilityCalls?: boolean;
}
