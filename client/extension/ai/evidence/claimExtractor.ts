/**
 * Claim extraction from pending PDX write payloads (plan §4.2.1).
 *
 * Pure, deterministic, bounded. Extracts the semantic claims a write makes
 * (effect/trigger/modifier usage, ID references, entry-point definitions)
 * from the *new* text of write_file / edit_file / replace_lines /
 * edit_pdx_block / multi_replace_file_content calls. Only PDX script
 * extensions are in scope; localisation .yml, markdown and other files are
 * skipped so non-script writes never pay for the gate.
 *
 * Extraction never throws: malformed input degrades to fewer claims, not to
 * a crash. Verification happens in evidenceGate.ts; this module only finds
 * what must be verified.
 */

import * as path from 'path';
import type { EvidenceClaimKind } from './evidenceTypes';
import type { PdxSemanticCatalog, CwtRuleValueReference } from '../types';

/** PDX script extensions the gate applies to (mirrors fileTools.isPdxStructureGuardedPath). */
export const PDX_SCRIPT_EXTENSIONS: readonly string[] = ['.txt', '.gui', '.gfx', '.asset', '.entity'];

/** Hard bounds so a hostile or pathological payload cannot stall the gate. */
export const MAX_EXTRACT_CHARS = 100_000;
export const MAX_STATEMENTS = 4_000;
export const MAX_CLAIM_CANDIDATES = 120;
export const MAX_UNKNOWN_NAME_CANDIDATES = 40;
export const MAX_REFERENCE_CANDIDATES = 40;
const MAX_BRACE_DEPTH = 64;

export interface WritePayload {
    /** Absolute or workspace-relative target path as given by the tool args. */
    targetFile: string;
    /** The new PDX text being written (whole content for write_file, fragment for edits). */
    text: string;
    /** True when the text was truncated to MAX_EXTRACT_CHARS before extraction. */
    truncated: boolean;
    /** Active game/profile. Reserved for profile-specific extractors; never inferred from another profile. */
    gameProfile?: string;
}

/** CWT type name. Kept open because supported games define different entity families. */
export type LocalDefinitionKind = string;

export type ReferenceKind = LocalDefinitionKind;

export type ExtractedSubject =
    | { type: 'syntax'; code: string }
    | {
        type: 'rule';
        name: string;
        /** Syntactic position the name was used in. */
        position: 'effect' | 'trigger' | 'modifier' | 'any';
        /** Innermost scope determined from enclosing scope-change blocks, if any. */
        currentScope?: string;
      }
    | {
        type: 'reference';
        id: string;
        refKind: ReferenceKind;
      };

export interface LocalDefinitionCandidate {
    id: string;
    kind: LocalDefinitionKind;
}

export interface ExtractedClaimCandidate {
    kind: EvidenceClaimKind;
    claim: string;
    blocking: boolean;
    subject: ExtractedSubject;
    detail?: string;
}

/** True when the path is a PDX script target (case-insensitive extension check). */
export function isPdxScriptTarget(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return PDX_SCRIPT_EXTENSIONS.includes(ext);
}

function asTrimmedString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Pull the (targetFile, newText) pair out of a write tool's args. Returns
 * null for non-write tools, missing text, or non-PDX targets — the caller
 * then skips the gate entirely.
 */
export function extractWritePayload(toolName: string, args: Record<string, unknown>): WritePayload | null {
    let targetFile: string | undefined;
    let text: string | undefined;

    switch (toolName) {
        case 'write_file':
            targetFile = asTrimmedString(args.file) ?? asTrimmedString(args.filePath);
            text = typeof args.content === 'string' ? args.content : undefined;
            break;
        case 'edit_file':
            targetFile = asTrimmedString(args.filePath) ?? asTrimmedString(args.file);
            text = typeof args.newString === 'string' ? args.newString : undefined;
            break;
        case 'replace_lines':
            targetFile = asTrimmedString(args.filePath) ?? asTrimmedString(args.file);
            text = typeof args.newContent === 'string' ? args.newContent : undefined;
            break;
        case 'edit_pdx_block':
            targetFile = asTrimmedString(args.file) ?? asTrimmedString(args.filePath);
            text = typeof args.newContent === 'string' ? args.newContent : undefined;
            break;
        case 'multi_replace_file_content': {
            targetFile = asTrimmedString(args.TargetFile) ?? asTrimmedString(args.filePath);
            const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
            const parts: string[] = [];
            for (const chunk of chunks) {
                if (chunk && typeof chunk === 'object' && typeof (chunk as Record<string, unknown>).ReplacementContent === 'string') {
                    parts.push((chunk as Record<string, unknown>).ReplacementContent as string);
                }
            }
            text = parts.length > 0 ? parts.join('\n') : undefined;
            break;
        }
        default:
            return null;
    }

    if (!targetFile || text === undefined || !isPdxScriptTarget(targetFile)) return null;
    if (text.trim().length === 0) return null;

    const truncated = text.length > MAX_EXTRACT_CHARS;
    return { targetFile, text: truncated ? text.slice(0, MAX_EXTRACT_CHARS) : text, truncated };
}

// - Syntactic scan -

interface PdxStatement {
    name: string;
    /** Brace depth of the enclosing block; 0 = top level. */
    depth: number;
    isBlock: boolean;
    /** Unquoted scalar value for `key = value` statements. */
    scalarValue?: string;
    /** Enclosing block keys, outermost first. */
    chain: string[];
}

const DYNAMIC_OR_SENTINEL_ENTITY_IDS: ReadonlySet<string> = new Set([
    'yes', 'no', 'all', 'any', 'none', 'random', 'random_common', 'random_negative',
    'all_negative', 'root', 'prev', 'from', 'fromfrom', 'this', 'owner',
]);

function isConcreteEntityId(value: string): boolean {
    const normalized = value.toLowerCase();
    if (!/^[A-Za-z_][\w.-]*$/.test(value)) return false;
    if (DYNAMIC_OR_SENTINEL_ENTITY_IDS.has(normalized)) return false;
    if (normalized.startsWith('event_target.') || normalized.startsWith('parameter.')) return false;
    return !normalized.startsWith('random_') && !normalized.startsWith('all_');
}

function typedReferenceForStatement(
    statement: PdxStatement,
    catalog: PdxSemanticCatalog | undefined,
    targetFile: string,
): { id: string; kind: LocalDefinitionKind } | undefined {
    if (!catalog || statement.isBlock || !statement.scalarValue || !isConcreteEntityId(statement.scalarValue)) return undefined;
    const name = statement.name.toLowerCase();
    const parent = statement.chain[statement.chain.length - 1]?.toLowerCase();
    const directReferences = catalog.rules
        .filter(candidate => candidate.name === name)
        .flatMap(candidate => candidate.valueReferences)
        .filter(candidate => candidate.argumentPath.toLowerCase() === '$value' && candidate.access !== 'value_set');
    const blockReferences = parent
        ? catalog.rules
            .filter(candidate => candidate.name === parent)
            .flatMap(candidate => candidate.valueReferences)
            .filter(candidate => candidate.argumentPath.toLowerCase() === name && candidate.access !== 'value_set')
        : [];
    // CWT aliases may define both scalar (`rule = <type>`) and block
    // (`rule = { field = <type> }`) forms, sometimes in separate rules.
    const reference = directReferences[0] ?? blockReferences[0];
    const kind = reference ? definitionKindForReference(reference, catalog) : undefined;
    const definitionType = definitionTypeForTarget(targetFile, catalog);
    if (definitionType
        && kind === definitionType.name
        && statement.depth === 1
        && parent
        && definitionType.typeKeyFilters.includes(parent)
        && statement.name.toLowerCase() === definitionType.nameField) return undefined;
    return kind ? { id: statement.scalarValue, kind } : undefined;
}

function definitionKindForReference(
    reference: CwtRuleValueReference,
    catalog: PdxSemanticCatalog,
): LocalDefinitionKind | undefined {
    const typeName = reference.typeName.trim().toLowerCase();
    return catalog.definitionTypes
        .map(type => type.name)
        .sort((a, b) => b.length - a.length)
        .find(name => typeName === name || typeName.startsWith(`${name}.`));
}

/** Derive the pushed scope only from the active CWT scope-change alias. */
export function scopePushedBy(blockName: string, catalog?: PdxSemanticCatalog): string | undefined {
    const fromRules = catalog?.rules.find(rule => rule.name === blockName.toLowerCase() && rule.pushScope)?.pushScope;
    return fromRules?.toLowerCase();
}

function isScopeChangeLike(blockName: string, catalog?: PdxSemanticCatalog): boolean {
    return scopePushedBy(blockName, catalog) !== undefined;
}

/**
 * Tokenize PDX script into `key = ...` statements. Handles `#` comments,
 * quoted strings with escaped quotes, and tracks brace depth. Total by
 * construction: unbalanced input just yields fewer statements.
 */
function scanStatements(text: string): PdxStatement[] {
    const statements: PdxStatement[] = [];
    const blockStack: string[] = [];
    const len = text.length;
    let i = 0;

    const skipWsAndComments = () => {
        while (i < len) {
            const ch = text[i]!;
            if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
            if (ch === '#') {
                while (i < len && text[i] !== '\n') i++;
                continue;
            }
            break;
        }
    };

    const readToken = (): string | undefined => {
        if (i >= len) return undefined;
        const ch = text[i]!;
        if (ch === '"') {
            i++;
            let value = '';
            while (i < len) {
                const c = text[i]!;
                if (c === '\\' && i + 1 < len) { value += text[i + 1]; i += 2; continue; }
                if (c === '"') { i++; break; }
                value += c;
                i++;
            }
            return value;
        }
        const start = i;
        while (i < len && !' \t\r\n#={}<>'.includes(text[i]!)) i++;
        return i > start ? text.slice(start, i) : undefined;
    };

    while (i < len && statements.length < MAX_STATEMENTS) {
        skipWsAndComments();
        if (i >= len) break;
        const ch = text[i]!;
        if (ch === '{') {
            // Anonymous or operator block opening not preceded by `key =`; keep depth sane.
            if (blockStack.length < MAX_BRACE_DEPTH) blockStack.push('');
            i++;
            continue;
        }
        if (ch === '}') {
            blockStack.pop();
            i++;
            continue;
        }
        const token = readToken();
        if (token === undefined) { i++; continue; }

        skipWsAndComments();
        if (text[i] === '=' || (text[i] === '<' && text[i + 1] === '=') || (text[i] === '>' && text[i + 1] === '=')) {
            // comparison/equality operator — consume it
            i += text[i] === '=' ? 1 : 2;
            skipWsAndComments();
            if (text[i] === '{') {
                if (blockStack.length < MAX_BRACE_DEPTH) {
                    statements.push({
                        name: token,
                        depth: blockStack.length,
                        isBlock: true,
                        chain: [...blockStack],
                    });
                    blockStack.push(token);
                }
                i++;
            } else {
                const value = readToken();
                statements.push({
                    name: token,
                    depth: blockStack.length,
                    isBlock: false,
                    scalarValue: value,
                    chain: [...blockStack],
                });
            }
        }
        // Bare tokens without `=` (loose values, operators) carry no claims.
    }
    return statements;
}

/** Syntax-only inventory used to request just the relevant semantic rules from LSP. */
export function extractPdxStatementNames(payload: WritePayload): string[] {
    return Array.from(new Set(scanStatements(payload.text).map(statement => statement.name.toLowerCase())))
        .sort()
        .slice(0, MAX_STATEMENTS);
}

function definitionScopeForKey(key: string, targetFile: string, catalog?: PdxSemanticCatalog): string | undefined {
    const definitionType = definitionTypeForTarget(targetFile, catalog);
    if (!definitionType) return undefined;
    const prefix = `${definitionType.name}.`;
    const reference = catalog?.rules
        .filter(candidate => candidate.name === key.toLowerCase())
        .flatMap(rule => rule.valueReferences)
        .find(candidate => candidate.typeName.toLowerCase().startsWith(prefix));
    return reference?.typeName.slice(prefix.length).toLowerCase() || undefined;
}

function currentScopeFor(chain: string[], targetFile: string, catalog?: PdxSemanticCatalog): string | undefined {
    let scope: string | undefined;
    let rootScope: string | undefined;
    for (const block of chain) {
        const normalized = block.toLowerCase();
        const definitionRoot = definitionScopeForKey(normalized, targetFile, catalog);
        if (definitionRoot) {
            rootScope = definitionRoot;
            scope = definitionRoot;
            continue;
        }
        if (normalized === 'root') {
            scope = rootScope;
            continue;
        }
        if (normalized === 'prev' || normalized === 'from' || normalized === 'fromfrom') {
            // These scopes depend on the caller chain and cannot be inferred
            // safely from a standalone fragment.
            scope = undefined;
            continue;
        }
        const pushed = scopePushedBy(block, catalog);
        if (pushed) scope = pushed;
    }
    return scope;
}

function definitionTypeForTarget(targetFile: string, catalog?: PdxSemanticCatalog): PdxSemanticCatalog['definitionTypes'][number] | undefined {
    const normalized = targetFile.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
    return catalog?.definitionTypes
        .filter(type => type.paths.some(typePath => normalized.startsWith(`${typePath}/`) || normalized.includes(`/${typePath}/`)))
        .sort((a, b) => Math.max(0, ...b.paths.map(value => value.length)) - Math.max(0, ...a.paths.map(value => value.length)))[0];
}

function rootPositionForTarget(targetFile: string, catalog?: PdxSemanticCatalog): 'effect' | 'trigger' | 'modifier' | undefined {
    const type = definitionTypeForTarget(targetFile, catalog)?.name;
    if (!type) return undefined;
    const category = catalog?.rules.find(rule => rule.name === `<${type}>`)?.category;
    return category === 'effect' || category === 'trigger' || category === 'modifier'
        ? category
        : undefined;
}

function childrenOf(statements: readonly PdxStatement[], parentStmt: PdxStatement, parentIndex: number): PdxStatement[] {
    const expectedChain = [...parentStmt.chain, parentStmt.name];
    const out: PdxStatement[] = [];
    for (let j = parentIndex + 1; j < statements.length; j++) {
        const statement = statements[j]!;
        if (statement.depth <= parentStmt.depth) break;
        if (statement.depth === parentStmt.depth + 1
            && statement.chain.length === expectedChain.length
            && statement.chain[statement.chain.length - 1] === parentStmt.name) {
            out.push(statement);
        }
    }
    return out;
}

/** Definitions present in the exact pending final content (pre-write local proof). */
export function extractLocalDefinitions(payload: WritePayload, catalog?: PdxSemanticCatalog): LocalDefinitionCandidate[] {
    const definitionType = definitionTypeForTarget(payload.targetFile, catalog);
    const statements = scanStatements(payload.text);
    const definitions: LocalDefinitionCandidate[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < statements.length; index++) {
        const statement = statements[index]!;
        if (!statement.isBlock || statement.depth !== 0) continue;
        if (!definitionType
            || (definitionType.typeKeyFilters.length > 0 && !definitionType.typeKeyFilters.includes(statement.name.toLowerCase()))) continue;
        let definition: LocalDefinitionCandidate | undefined;
        const id = definitionType.nameField
            ? childrenOf(statements, statement, index)
                .find(child => !child.isBlock && child.name.toLowerCase() === definitionType.nameField && child.scalarValue)
                ?.scalarValue
            : statement.name;
        if (id) definition = { id, kind: definitionType.name };
        if (!definition) continue;
        const key = `${definition.kind}:${definition.id.toLowerCase()}`;
        if (!seen.has(key)) {
            seen.add(key);
            definitions.push(definition);
        }
    }
    return definitions;
}

function containerPositionFor(chain: string[], targetFile: string, catalog?: PdxSemanticCatalog): 'effect' | 'trigger' | 'modifier' | 'any' | undefined {
    const parent = chain[chain.length - 1];
    if (parent === undefined) return undefined;
    // Children of a CWT-declared scope_change block are semantic calls again.
    if (isScopeChangeLike(parent, catalog)) return 'any';
    // Top-level callable definitions use the definition id as their parent;
    // the CWT <TypeDef> alias supplies the direct-child category.
    if (chain.length === 1) return rootPositionForTarget(targetFile, catalog);
    return undefined;
}

/**
 * Extract claim candidates from a write payload. Emits at most
 * MAX_CLAIM_CANDIDATES entries in deterministic source order. Design choices
 * never produce blocking claims (they are not claims we can verify).
 */
export function extractClaimsFromText(payload: WritePayload, catalog?: PdxSemanticCatalog): ExtractedClaimCandidate[] {
    const claims: ExtractedClaimCandidate[] = [];
    const push = (candidate: ExtractedClaimCandidate): boolean => {
        if (claims.length >= MAX_CLAIM_CANDIDATES) return false;
        claims.push(candidate);
        return true;
    };

    // One syntax_shape claim covers the whole fragment; verified via parseFragment.
    push({
        kind: 'syntax_shape',
        claim: `the written PDX fragment parses as valid script syntax`,
        blocking: true,
        subject: { type: 'syntax', code: payload.text },
        detail: payload.truncated ? `Fragment truncated to ${MAX_EXTRACT_CHARS} chars before parsing.` : undefined,
    });

    const statements = scanStatements(payload.text);
    let unknownNames = 0;
    let references = 0;

    for (let idx = 0; idx < statements.length; idx++) {
        const stmt = statements[idx]!;
        if (claims.length >= MAX_CLAIM_CANDIDATES) break;
        const lowerName = stmt.name.toLowerCase();

        // Explicit entity-id arguments are verified separately from the
        // effect/trigger symbol itself. This prevents any legal rule name
        // from lending credibility to a fabricated typed id.
        const typedReference = typedReferenceForStatement(stmt, catalog, payload.targetFile);
        if (typedReference && references < MAX_REFERENCE_CANDIDATES) {
            references++;
            push({
                kind: 'reference_exists',
                claim: `referenced ${typedReference.kind.replace(/_/g, ' ')} id '${typedReference.id}' exists`,
                blocking: true,
                subject: { type: 'reference', id: typedReference.id, refKind: typedReference.kind },
            });
        }

        // Effect/trigger/modifier usage: direct children of generic containers
        // or scope-change blocks. Block form: `name = { ... }`; scalar form
        // only for boolean-style calls (`name = yes/no`) so option args like
        // `name = my_loc_key` are not mistaken for scripted calls.
        const catalogCategories = new Set((catalog?.rules ?? [])
            .filter(rule => rule.name === lowerName)
            .map(rule => rule.category));
        const catalogPosition = catalogCategories.has('scope_change')
            || (catalogCategories.has('effect') && catalogCategories.has('trigger'))
            ? 'any'
            : catalogCategories.has('effect') ? 'effect'
                : catalogCategories.has('trigger') ? 'trigger'
                    : catalogCategories.has('modifier') ? 'modifier'
                        : undefined;
        const position = catalogPosition ?? containerPositionFor(stmt.chain, payload.targetFile, catalog);
        if (position === undefined) continue;
        if (stmt.name.length === 0 || !/^[A-Za-z_][\w.:-]*$/.test(stmt.name)) continue;
        const knownRule = catalogPosition !== undefined;
        if (!knownRule && !stmt.isBlock && !/^(?:yes|no)$/i.test(stmt.scalarValue ?? '')) {
            // Unknown scalar assignments are usually parameters. Dynamic
            // callable TypeDefs are still recognized in their canonical
            // boolean or block forms without maintaining argument-key lists.
            continue;
        }

        const scope = currentScopeFor(stmt.chain, payload.targetFile, catalog);
        push({
            kind: 'symbol_exists',
            claim: `'${stmt.name}' is a known ${position === 'any' ? 'effect/trigger' : position} usable here`,
            blocking: true,
            subject: {
                type: 'rule',
                name: stmt.name,
                position,
                currentScope: scope,
            },
        });
        unknownNames++;
        if (unknownNames >= MAX_UNKNOWN_NAME_CANDIDATES) break;
    }

    return claims;
}
