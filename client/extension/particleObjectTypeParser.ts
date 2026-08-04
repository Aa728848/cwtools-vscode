import { tokenize, type Token } from './pdxTokenizer';
import type { ParticleEffect } from '../webview/particleTypes';

export interface PdxParticleAlias {
    name: string;
    type: string;
    scale: number;
}

function unquote(value: string): string {
    return value.replace(/"/g, '');
}

function skipBlock(tokens: Token[], start: number): number {
    let depth = 0;
    for (let i = start; i < tokens.length; i++) {
        if (tokens[i]!.value === '{') depth++;
        else if (tokens[i]!.value === '}' && --depth === 0) return i + 1;
    }
    return tokens.length;
}

export function parsePdxParticleAliases(content: string): PdxParticleAlias[] {
    const tokens = tokenize(content);
    const aliases: PdxParticleAlias[] = [];
    for (let i = 0; i < tokens.length - 2; i++) {
        if (tokens[i]!.value !== 'pdxparticle' || tokens[i + 1]!.value !== '=' || tokens[i + 2]!.value !== '{') continue;
        const alias: PdxParticleAlias = { name: '', type: '', scale: 1 };
        let pos = i + 3;
        while (pos < tokens.length && tokens[pos]!.value !== '}') {
            const key = tokens[pos++]!.value;
            if (tokens[pos]?.value !== '=') continue;
            pos++;
            const value = tokens[pos];
            if (!value) break;
            if (value.value === '{') {
                pos = skipBlock(tokens, pos);
                continue;
            }
            pos++;
            if (key === 'name') alias.name = unquote(value.value);
            else if (key === 'type') alias.type = unquote(value.value);
            else if (key === 'scale') {
                const parsed = Number.parseFloat(value.value);
                if (Number.isFinite(parsed)) alias.scale = parsed;
            }
        }
        if (alias.name && alias.type) aliases.push(alias);
        i = Math.max(i, pos);
    }
    return aliases;
}

export function resolvePdxParticleEffect(
    referenceName: string,
    aliases: ReadonlyMap<string, PdxParticleAlias>,
    effects: ReadonlyMap<string, ParticleEffect>,
): ParticleEffect | undefined {
    const visiting = new Set<string>();
    let currentName = referenceName;
    let scale = 1;
    while (true) {
        if (visiting.has(currentName)) return undefined;
        visiting.add(currentName);
        const alias = aliases.get(currentName);
        if (!alias) break;
        scale *= alias.scale;
        if (alias.type === currentName) break;
        currentName = alias.type;
    }
    const effect = effects.get(currentName);
    if (!effect) return undefined;
    return {
        ...effect,
        name: referenceName,
        scale: (effect.scale ?? 1) * scale,
    };
}
