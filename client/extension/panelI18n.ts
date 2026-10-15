/**
 * Shared bilingual UI helpers for extension-host panels and commands.
 * Historically every panel re-implemented `panelText`/`localize`/`isChineseLocale`;
 * this module is the single definition all callers should import.
 */
import * as vscode from 'vscode';

export function isChineseLocale(): boolean {
    return vscode.env.language.toLowerCase().startsWith('zh');
}

export function localize(en: string, zh: string): string {
    return isChineseLocale() ? zh : en;
}

/** Alias used by preview panels (GUI/Entity/Particle/Solar/EventChain). */
export const panelText = localize;

/**
 * Language tag down-sent to a webview initialization payload, so webview-side copy
 * renders in the same locale as the Host-rendered chrome instead of guessing from
 * `document.lang` alone.
 */
export type PanelLocale = 'en' | 'zh-cn';

export function panelLocale(): PanelLocale {
    return isChineseLocale() ? 'zh-cn' : 'en';
}
