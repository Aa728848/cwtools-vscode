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
    /**
     * Set when the provider is declared in ~/.cwtools/providers.json: the
     * endpoint and credential are file-owned, so the settings form renders
     * them read-only and never writes them back.
     */
    source?: 'home';
    /** Name of the environment variable holding the key (home providers only). */
    apiKeyEnv?: string;
}
