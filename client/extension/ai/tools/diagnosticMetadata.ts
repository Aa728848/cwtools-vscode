import * as vs from 'vscode';
import type { DiagnosticAnalysisCategory } from '../types';
import { DIAGNOSTIC_ANALYSIS_CATEGORIES } from '../types';
import { diagnosticCodeString } from '../../diagnosticI18n';

export interface DiagnosticMetadata {
    category: DiagnosticAnalysisCategory;
    repairHint: string;
    expectedType?: string;
    actualType?: string;
    scope?: string;
    symbol?: string;
    confidence?: 'high' | 'medium' | 'low' | string;
    metadataSource?: 'lsp_data' | 'message_heuristic' | string;
    data?: unknown;
}

export function isDiagnosticCategory(value: unknown): value is DiagnosticAnalysisCategory {
    return typeof value === 'string' && (DIAGNOSTIC_ANALYSIS_CATEGORIES as readonly string[]).includes(value);
}

function firstCapture(message: string, patterns: RegExp[]): string | undefined {
    for (const pattern of patterns) {
        const match = pattern.exec(message);
        const value = match?.[1]?.trim();
        if (value) return value.replace(/^['"`]+|['"`.,:;)]+$/g, '');
    }
    return undefined;
}

function semanticFields(message: string): Pick<DiagnosticMetadata, 'expectedType' | 'actualType' | 'scope' | 'symbol'> {
    const expectedType = firstCapture(message, [
        /expected value of type\s+['"]?([A-Za-z0-9_.:-]+)/i,
        /expected\s+['"]?([A-Za-z0-9_.:-]+)['"]?\s+(?:scope|type|value)/i,
        /([A-Za-z0-9_.:-]+)\s+expected/i,
    ]);
    const actualType = firstCapture(message, [
        /(?:got|actual|found)\s+['"]?([A-Za-z0-9_.:-]+)/i,
        /but\s+(?:got|found)\s+['"]?([A-Za-z0-9_.:-]+)/i,
    ]);
    const scope = firstCapture(message, [
        /scope\s*[:=]\s*['"]?([A-Za-z0-9_.:-]+)/i,
        /(?:root|this|from|prev|fromfrom)\s*[:=]\s*['"]?([A-Za-z0-9_.:-]+)/i,
    ]);
    const symbol = firstCapture(message, [
        /['"]([^'"]{2,160})['"]/,
        /\b(GFX_[A-Za-z0-9_.:-]+)\b/i,
        /\b([A-Za-z_][A-Za-z0-9_.:-]{2,})\s+(?:not found|does not exist|is unknown|already defined)/i,
    ]);
    return { expectedType, actualType, scope, symbol };
}

function withSemantics(message: string, base: Pick<DiagnosticMetadata, 'category' | 'repairHint'>): DiagnosticMetadata {
    const fields = semanticFields(message);
    return {
        ...base,
        ...fields,
        confidence: 'low',
        metadataSource: 'message_heuristic',
    };
}

function dataString(dataObj: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = dataObj?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function classifyDiagnosticFallback(message: string, code?: string): DiagnosticMetadata {
    const lower = message.toLowerCase();
    const has = (needle: string) => lower.includes(needle);
    if ((code ?? '').toUpperCase().startsWith('CW001') || has('syntax') || has('parse') || has('unexpected') || has('brace') || has("missing '}'") || has('unmatched')) {
        return withSemantics(message, {
            category: 'brace_or_syntax_error',
            repairHint: 'Inspect the nearest block boundaries and fix the smallest malformed syntax region before changing semantic content.',
        });
    }
    if (has('localisation') || has('localization') || has('localised') || has('localized')) {
        return withSemantics(message, {
            category: 'missing_localisation',
            repairHint: 'Verify the key in localisation indexes and project text before creating or updating localisation.',
        });
    }
    if (has('scope')) {
        return withSemantics(message, {
            category: 'scope_mismatch',
            repairHint: 'Query the current scope and the relevant rule before changing triggers, effects, or scope transitions.',
        });
    }
    if (has('sprite') || has('gfx_') || has('spritetype') || has('picture')) {
        return withSemantics(message, {
            category: 'unknown_sprite',
            repairHint: 'Resolve the sprite through project and vanilla .gfx/.asset candidates before editing the reference.',
        });
    }
    if (has('sound') || has('music') || has('.asset')) {
        return withSemantics(message, {
            category: 'unknown_sound',
            repairHint: 'Resolve the sound or music asset through project and vanilla candidates before editing the reference.',
        });
    }
    if (has('duplicate') || has('already defined') || has('redeclared')) {
        return withSemantics(message, {
            category: 'duplicate_definition',
            repairHint: 'Find the existing definition before deleting, renaming, or moving the duplicate entry.',
        });
    }
    if (has('expected value of type') || has('invalid value') || has('not a valid value') || has('wrong type')) {
        return withSemantics(message, {
            category: 'invalid_value_type',
            repairHint: 'Query the field rule and nearby scope before replacing the value with a type-correct candidate.',
        });
    }
    if (has('trigger') || has('effect')) {
        return withSemantics(message, {
            category: 'unknown_trigger_effect',
            repairHint: 'Check CWT rules, scripted triggers/effects, and definitions before renaming or creating identifiers.',
        });
    }
    if (has('unknown') || has('not found') || has('could not find') || has('does not exist') || has('unresolved')) {
        return withSemantics(message, {
            category: 'missing_definition',
            repairHint: 'Verify the referenced definition across workspace and vanilla indexes before creating a replacement.',
        });
    }
    return withSemantics(message, {
        category: 'unknown',
        repairHint: 'Gather nearby file context, rule data, and current diagnostics before applying another edit.',
    });
}

export function diagnosticMetadata(diagnostic: vs.Diagnostic): DiagnosticMetadata {
    const data = (diagnostic as vs.Diagnostic & { data?: unknown }).data;
    const dataObj = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
    const fallback = classifyDiagnosticFallback(diagnostic.message, diagnosticCodeString(diagnostic.code));
    return {
        category: isDiagnosticCategory(dataObj?.category) ? dataObj.category : fallback.category,
        repairHint: typeof dataObj?.repairHint === 'string' ? dataObj.repairHint : fallback.repairHint,
        expectedType: dataString(dataObj, 'expectedType') ?? fallback.expectedType,
        actualType: dataString(dataObj, 'actualType') ?? fallback.actualType,
        scope: dataString(dataObj, 'scope') ?? fallback.scope,
        symbol: dataString(dataObj, 'symbol') ?? fallback.symbol,
        confidence: dataString(dataObj, 'confidence') ?? fallback.confidence,
        metadataSource: dataString(dataObj, 'metadataSource') ?? (dataObj ? 'lsp_data' : fallback.metadataSource),
        data,
    };
}
