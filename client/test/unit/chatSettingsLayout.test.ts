import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import * as icons from '../../webview/svgIcons';

const template = fs.readFileSync(path.resolve(__dirname, '../../extension/ai/chatHtml.ts'), 'utf8');
const compiledTemplate = ts.transpileModule(template, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function renderSettings(locale: string): string {
    const exported: Record<string, unknown> = {};
    vm.runInNewContext(compiledTemplate, {
        exports: exported,
        require: (name: string) => {
            if (name === 'vscode') return {
                env: { language: locale },
                Uri: { joinPath: (_base: unknown, ...parts: string[]) => parts.join('/') },
            };
            if (name === '../../webview/svgIcons') return icons;
            throw new Error(`Unexpected template dependency: ${name}`);
        },
    });
    if (typeof exported.getChatPanelHtml !== 'function') throw new Error('Chat template export is missing');
    const html: unknown = exported.getChatPanelHtml({ cspSource: 'https://webview.test', asWebviewUri: (uri: unknown) => uri }, {});
    if (typeof html !== 'string') throw new Error('Chat template must return HTML');
    return html.slice(html.indexOf('<div class="settings-page"'));
}

describe('sidebar settings layout', () => {
    for (const locale of ['en', 'zh-cn']) {
        it(`keeps the existing settings and account actions in reachable categories (${locale})`, () => {
            const html = renderSettings(locale);
            const requiredControls: Record<string, string[]> = {
                models: [
                    'settingsProvider', 'customApiFormat', 'settingsModelInput', 'delModelBtn', 'detectBtn',
                    'settingsCtx', 'settingsReasoningEffort', 'settingsCodexServiceTier', 'settingsResponseVerbosity',
                    'settingsApiKey', 'keyToggleBtn', 'fetchApiModelsBtn', 'deleteApiKeyBtn',
                    'codexLoginBtn', 'codexRefreshBtn', 'codexLogoutBtn', 'codexQuotaStatus',
                    'antigravityLoginBtn', 'antigravityRefreshBtn', 'antigravityLogoutBtn', 'antigravityAccountStatus',
                    'settingsReasoningKey', 'settingsEndpoint', 'subscriptionProxyMode', 'subscriptionProxyUrl',
                    'subscriptionProxySaveBtn', 'subscriptionProxyRefreshBtn',
                    'inlineEnabled', 'inlineProvider', 'inlineModelInput', 'inlineEndpoint', 'inlineDebounce',
                    'inlineMaxTokens', 'inlineContextBefore', 'inlineContextAfter', 'inlineRequestTimeout',
                    'inlineMcpCacheTtl', 'inlineLspFastPath', 'inlineIncludeMcp', 'inlineOverlapStripping',
                    'translationPreviewProvider', 'translationPreviewModelInput',
                ],
                agent: ['agentWriteMode', 'approvalsAutoReview', 'agentModelRows'],
                tools: [
                    'webAccessMode', 'webSearchProvider', 'webContextSize', 'webAllowSyntheticProxy',
                    'webFallbackProviders', 'webAllowedDomains', 'webBlockedDomains', 'webCountry',
                    'webSearxngEndpoint', 'webOpenAIModel', 'webCacheTtlMs',
                    'webKey-brave', 'webKey-exa', 'webKey-tavily', 'webKey-serper', 'webKey-serpapi',
                    'mcpServersList', 'addMcpServerBtn', 'skillSourceInput', 'installSkillBtn', 'installedSkillsList',
                ],
                usage: ['usageStatsContent', 'refreshUsageBtn', 'clearUsageBtn'],
            };
            const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
            expect(new Set(ids).size).to.equal(ids.length);
            for (const [category, controls] of Object.entries(requiredControls)) {
                const panel = html.split(`data-settings-panel="${category}"`)[1]?.split('data-settings-panel=')[0] ?? '';
                expect(panel, category).not.to.equal('');
                for (const id of controls) expect(panel, `${category}: ${id}`).to.include(`id="${id}"`);
                expect(html).to.include(`aria-controls="settingsPanel-${category}"`);
                expect(html).to.include(`aria-labelledby="settingsTab-${category}"`);
            }
            expect(html).to.include('id="testConnBtn"');
            expect(html).to.include('id="saveSettingsBtn"');
            expect(html).to.include('value="disabled"');
            expect(html).to.include('value="live"');
            for (const role of ['explore', 'planner', 'general-coder', 'paradox-coder', 'localization-writer', 'reviewer', 'gui-expert']) {
                expect(html).to.include(`class="agent-model-row" data-role="${role}"`);
            }
        });
    }

    it('keeps the context limit directly editable in the main model section, including provider-default zero', () => {
        const html = renderSettings('zh-cn');
        const chat = html.split('id="chatModelSection"')[1]?.split('id="inlineSection"')[0] ?? '';
        expect(chat).to.match(/<input[^>]+id="settingsCtx"[^>]+type="number"[^>]+min="0"/);
        expect(chat.indexOf('id="settingsCtx"')).to.be.lessThan(chat.indexOf('<details'));
        expect(chat).to.include('aria-describedby="settingsCtxHint"');
        expect(chat).to.include('可手动设置上下文上限');
        expect(chat).not.to.match(/id="settingsCtx"[^>]+(?:readonly|disabled)/);
    });

    it('uses CSP-compatible search-key actions and keyboard-accessible category controls', () => {
        const html = renderSettings('en');
        expect(html).not.to.include('onclick=');
        for (const provider of ['brave', 'exa', 'tavily', 'serper', 'serpapi']) {
            expect(html).to.include(`data-settings-key-toggle="webKey-${provider}"`);
        }
        expect(html.match(/role="tab"/g)).to.have.length(4);
        expect(html.match(/aria-selected="true"/g)).to.have.length(1);
        expect(html).to.include('id="settingsPanel-models" role="tabpanel" aria-labelledby="settingsTab-models" data-settings-panel="models">');
    });
});
