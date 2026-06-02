import * as vs from 'vscode';
import type { DiagnosticAnalysisCategory } from '../types';

export function isDiagnosticCategory(value: unknown): value is DiagnosticAnalysisCategory {
    return typeof value === 'string' && [
        'stale_lsp_cache',
        'missing_localisation',
        'unknown_sprite',
        'unknown_sound',
        'scope_mismatch',
        'unknown_trigger_effect',
        'brace_or_syntax_error',
        'invalid_value_type',
        'missing_definition',
        'duplicate_definition',
        'read_tracker_stale',
        'tool_argument_error',
        'lsp_no_feedback',
        'unknown',
    ].includes(value);
}

export function classifyDiagnosticFallback(message: string, code?: string): { category: DiagnosticAnalysisCategory; repairHint: string } {
    const lower = message.toLowerCase();
    const has = (needle: string) => lower.includes(needle);
    if ((code ?? '').toUpperCase().startsWith('CW001') || has('syntax') || has('parse') || has('unexpected') || has('brace') || has("missing '}'") || has('unmatched')) {
        return {
            category: 'brace_or_syntax_error',
            repairHint: 'Inspect the nearest block boundaries and fix the smallest malformed syntax region before changing semantic content.',
        };
    }
    if (has('localisation') || has('localization') || has('localised') || has('localized')) {
        return {
            category: 'missing_localisation',
            repairHint: 'Verify the key in localisation indexes and project text before creating or updating localisation.',
        };
    }
    if (has('scope')) {
        return {
            category: 'scope_mismatch',
            repairHint: 'Query the current scope and the relevant rule before changing triggers, effects, or scope transitions.',
        };
    }
    if (has('sprite') || has('gfx_') || has('spritetype') || has('picture')) {
        return {
            category: 'unknown_sprite',
            repairHint: 'Resolve the sprite through project and vanilla .gfx/.asset candidates before editing the reference.',
        };
    }
    if (has('sound') || has('music') || has('.asset')) {
        return {
            category: 'unknown_sound',
            repairHint: 'Resolve the sound or music asset through project and vanilla candidates before editing the reference.',
        };
    }
    if (has('duplicate') || has('already defined') || has('redeclared')) {
        return {
            category: 'duplicate_definition',
            repairHint: 'Find the existing definition before deleting, renaming, or moving the duplicate entry.',
        };
    }
    if (has('expected value of type') || has('invalid value') || has('not a valid value') || has('wrong type')) {
        return {
            category: 'invalid_value_type',
            repairHint: 'Query the field rule and nearby scope before replacing the value with a type-correct candidate.',
        };
    }
    if (has('trigger') || has('effect')) {
        return {
            category: 'unknown_trigger_effect',
            repairHint: 'Check CWT rules, scripted triggers/effects, and definitions before renaming or creating identifiers.',
        };
    }
    if (has('unknown') || has('not found') || has('could not find') || has('does not exist') || has('unresolved')) {
        return {
            category: 'missing_definition',
            repairHint: 'Verify the referenced definition across workspace and vanilla indexes before creating a replacement.',
        };
    }
    return {
        category: 'unknown',
        repairHint: 'Gather nearby file context, rule data, and current diagnostics before applying another edit.',
    };
}

export function diagnosticMetadata(diagnostic: vs.Diagnostic): { category: DiagnosticAnalysisCategory; repairHint: string; data?: unknown } {
    const data = (diagnostic as vs.Diagnostic & { data?: unknown }).data;
    const dataObj = data && typeof data === 'object' ? data as Record<string, unknown> : undefined;
    const fallback = classifyDiagnosticFallback(diagnostic.message, diagnostic.code !== undefined ? String(diagnostic.code) : undefined);
    return {
        category: isDiagnosticCategory(dataObj?.category) ? dataObj.category : fallback.category,
        repairHint: typeof dataObj?.repairHint === 'string' ? dataObj.repairHint : fallback.repairHint,
        data,
    };
}
