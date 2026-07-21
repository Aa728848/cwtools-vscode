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

export type LocalDefinitionKind =
    | 'event'
    | 'scripted_effect'
    | 'scripted_trigger'
    | 'static_modifier'
    | 'technology'
    | 'building'
    | 'trait'
    | 'starbase_building';

export type ReferenceKind = LocalDefinitionKind | 'scripted_effect_or_trigger';

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
      }
    | { type: 'call_chain'; entryId: string; requiresCaller: boolean };

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

/** Generic containers whose direct children are effect/trigger/modifier positions. */
const CONTAINER_POSITION: Readonly<Record<string, 'effect' | 'trigger' | 'modifier' | 'any'>> = {
    modifier: 'modifier',
    effect: 'effect',
    immediate: 'effect',
    hidden_effect: 'effect',
    after: 'effect',
    trigger: 'trigger',
    limit: 'trigger',
    not: 'trigger',
    nor: 'trigger',
    nand: 'trigger',
    any_of: 'trigger',
    all_of: 'trigger',
    fail_trigger: 'trigger',
    pre_triggers: 'trigger',
    weight: 'trigger',
    chance: 'trigger',
    if: 'any',
    else_if: 'any',
    else: 'any',
    while: 'any',
    option: 'any',
    allowed: 'any',
    alternative: 'any',
    events: 'any',
};

/** scope_change blocks follow strong naming conventions: every_X / random_X / any_X / ordered_X / each_X. */
const SCOPE_CHANGE_PATTERN = /^(?:every|random|any|ordered|each)_(\w+)$/;

/**
 * Universal argument keys that appear as direct children of option/event
 * containers. Everything else with a scalar value in script position is a
 * candidate effect/trigger call (triggers take scalar args: `has_trait = x`;
 * effects too: `add_energy = 100`).
 */
const SCALAR_ARG_KEYS: ReadonlySet<string> = new Set([
    'name', 'id', 'value', 'var', 'key', 'text', 'texture', 'icon', 'picture',
    'sound', 'namespace', 'flag', 'target', 'days', 'months', 'years',
    'duration', 'who', 'opinion', 'type', 'class', 'level', 'skill', 'amount',
    'factor', 'add', 'mult', 'base', 'group', 'default', 'loc', 'title', 'desc',
]);

/**
 * Conservative typed entity references whose scalar value is an exact entity
 * id. These names are shared by multiple Paradox profiles and are only
 * applied in an already-established effect/trigger position. Free-form keys
 * such as `name`, `key`, localisation, variables, and arbitrary block fields
 * deliberately stay out of this table.
 */
const DIRECT_TYPED_REFERENCES: Readonly<Record<string, LocalDefinitionKind>> = {
    has_technology: 'technology',
    can_research_technology: 'technology',
    is_researching_technology: 'technology',
    add_technology: 'technology',
    give_technology: 'technology',
    research_technology: 'technology',
    has_trait: 'trait',
    add_trait: 'trait',
    remove_trait: 'trait',
    has_building: 'building',
    has_active_building: 'building',
    has_building_construction: 'building',
    add_building: 'building',
    remove_building: 'building',
    repair_building: 'building',
    ruin_building: 'building',
    disable_building: 'building',
};

/** Typed ids nested inside the block form of a known effect/trigger. */
const BLOCK_ARGUMENT_TYPED_REFERENCES: Readonly<Record<string, Readonly<Record<string, LocalDefinitionKind>>>> = {
    give_technology: { tech: 'technology', technology: 'technology' },
    add_technology: { tech: 'technology', technology: 'technology' },
    research_technology: { tech: 'technology', technology: 'technology' },
    add_trait: { trait: 'trait' },
    remove_trait: { trait: 'trait' },
    add_building: { building: 'building' },
    remove_building: { building: 'building' },
    repair_building: { building: 'building' },
    set_starbase_building: { building: 'starbase_building' },
    remove_starbase_building: { building: 'starbase_building' },
};

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
    targetFile: string,
): { id: string; kind: LocalDefinitionKind } | undefined {
    if (statement.isBlock || !statement.scalarValue || !isConcreteEntityId(statement.scalarValue)) return undefined;
    const name = statement.name.toLowerCase();
    const parent = statement.chain[statement.chain.length - 1]?.toLowerCase();
    if (parent) {
        const nestedKind = BLOCK_ARGUMENT_TYPED_REFERENCES[parent]?.[name];
        if (nestedKind) return { id: statement.scalarValue, kind: nestedKind };
    }
    if (containerPositionFor(statement.chain, targetFile) === undefined) return undefined;
    const directKind = DIRECT_TYPED_REFERENCES[name];
    return directKind ? { id: statement.scalarValue, kind: directKind } : undefined;
}
/** Explicit scope changes that do not follow the pattern. */
const EXPLICIT_SCOPE_CHANGES: Readonly<Record<string, string>> = {
    root: 'root',
    prev: 'prev',
    from: 'from',
    fromfrom: 'from',
    owner: 'country',
    capital: 'planet',
    overlord: 'country',
    federation: 'federation',
    sector: 'sector',
    system: 'system',
    planet: 'planet',
    country: 'country',
    fleet: 'fleet',
    ship: 'ship',
    leader: 'leader',
    pop: 'pop',
    army: 'army',
    deposit: 'deposit',
    megastructure: 'megastructure',
    starbase: 'starbase',
};

/** Event declaration keys establish the root/current scope for their body. */
const EVENT_ROOT_SCOPES: Readonly<Record<string, string>> = {
    country_event: 'country',
    observer_event: 'country',
    pop_event: 'pop',
    pop_group_event: 'pop_group',
    pop_faction_event: 'pop_faction',
    planet_event: 'planet',
    first_contact_event: 'first_contact',
    astral_rift_event: 'astral_rift',
    bypass_event: 'bypass',
    ship_event: 'ship',
    fleet_event: 'fleet',
    system_event: 'system',
    starbase_event: 'starbase',
    espionage_operation_event: 'espionage_operation',
    leader_event: 'leader',
    situation_event: 'situation',
    agreement_event: 'agreement',
    colony_event: 'colony',
    carrier_event: 'carrier',
};

/** Derive the scope a scope_change block pushes, following PDX naming conventions. */
export function scopePushedBy(blockName: string): string | undefined {
    const explicit = EXPLICIT_SCOPE_CHANGES[blockName.toLowerCase()];
    if (explicit) return explicit;
    const match = SCOPE_CHANGE_PATTERN.exec(blockName.toLowerCase());
    if (!match?.[1]) return undefined;
    let scope = match[1];
    // every_owned_planet / random_owned_fleet -> planet / fleet
    scope = scope.replace(/^owned_/, '');
    return scope || undefined;
}

function isScopeChangeLike(blockName: string): boolean {
    return scopePushedBy(blockName) !== undefined;
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

function currentScopeFor(chain: string[]): string | undefined {
    let scope: string | undefined;
    let rootScope: string | undefined;
    for (const block of chain) {
        const normalized = block.toLowerCase();
        const eventRoot = EVENT_ROOT_SCOPES[normalized];
        if (eventRoot) {
            rootScope = eventRoot;
            scope = eventRoot;
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
        const pushed = scopePushedBy(block);
        if (pushed) scope = pushed;
    }
    return scope;
}

function rootPositionForTarget(targetFile: string): 'effect' | 'trigger' | 'modifier' | undefined {
    const normalized = `/${targetFile.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()}`;
    if (normalized.includes('/common/scripted_effects/')) return 'effect';
    if (normalized.includes('/common/scripted_triggers/')) return 'trigger';
    if (normalized.includes('/common/static_modifiers/')) return 'modifier';
    if (normalized.includes('/common/on_actions/')) return 'effect';
    return undefined;
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
export function extractLocalDefinitions(payload: WritePayload): LocalDefinitionCandidate[] {
    const normalized = `/${payload.targetFile.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase()}`;
    const definitionKind: Exclude<LocalDefinitionKind, 'event'> | undefined =
        normalized.includes('/common/scripted_effects/') ? 'scripted_effect'
            : normalized.includes('/common/scripted_triggers/') ? 'scripted_trigger'
                : normalized.includes('/common/static_modifiers/') ? 'static_modifier'
                    : normalized.includes('/common/technology/') || normalized.includes('/common/technologies/') ? 'technology'
                        : normalized.includes('/common/buildings/') ? 'building'
                            : normalized.includes('/common/traits/') ? 'trait'
                                : normalized.includes('/common/starbase_buildings/') ? 'starbase_building'
                                    : undefined;
    const statements = scanStatements(payload.text);
    const definitions: LocalDefinitionCandidate[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < statements.length; index++) {
        const statement = statements[index]!;
        if (!statement.isBlock || statement.depth !== 0) continue;
        let definition: LocalDefinitionCandidate | undefined;
        if (definitionKind) {
            definition = { id: statement.name, kind: definitionKind };
        } else if (normalized.includes('/events/') && /(^|_)event$/i.test(statement.name)) {
            const id = childrenOf(statements, statement, index)
                .find(child => !child.isBlock && child.name.toLowerCase() === 'id' && child.scalarValue)
                ?.scalarValue;
            if (id) definition = { id, kind: 'event' };
        }
        if (!definition) continue;
        const key = `${definition.kind}:${definition.id.toLowerCase()}`;
        if (!seen.has(key)) {
            seen.add(key);
            definitions.push(definition);
        }
    }
    return definitions;
}

function containerPositionFor(chain: string[], targetFile: string): 'effect' | 'trigger' | 'modifier' | 'any' | undefined {
    const parent = chain[chain.length - 1];
    if (parent === undefined) return undefined;
    const mapped = CONTAINER_POSITION[parent.toLowerCase()];
    if (mapped) return mapped;
    // Children of a scope_change block are effect/trigger positions again.
    if (isScopeChangeLike(parent)) return 'any';
    // Top-level scripted definitions use the definition id as their parent,
    // so the file family supplies the semantic position of direct children.
    if (chain.length === 1) return rootPositionForTarget(targetFile);
    return undefined;
}

/**
 * Extract claim candidates from a write payload. Emits at most
 * MAX_CLAIM_CANDIDATES entries in deterministic source order. Design choices
 * never produce blocking claims (they are not claims we can verify).
 */
export function extractClaimsFromText(payload: WritePayload): ExtractedClaimCandidate[] {
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

        // Event definition (top-level `something_event = { id = X }`) or
        // event invocation (nested). Definition -> call_chain note; nested -> reference.
        if (stmt.isBlock && /(^|_)event$/.test(lowerName)) {
            const eventChildren = childrenOf(statements, stmt, idx);
            const idStmt = eventChildren.find(s => !s.isBlock && s.name.toLowerCase() === 'id' && s.scalarValue);
            if (idStmt?.scalarValue) {
                if (stmt.depth === 0) {
                    const requiresCaller = eventChildren.some(s => !s.isBlock
                        && s.name.toLowerCase() === 'is_triggered_only'
                        && s.scalarValue?.toLowerCase() === 'yes');
                    push({
                        kind: 'call_chain',
                        claim: `entry point '${idStmt.scalarValue}' is reachable from game systems`,
                        blocking: requiresCaller,
                        subject: { type: 'call_chain', entryId: idStmt.scalarValue, requiresCaller },
                        detail: requiresCaller
                            ? 'This event declares is_triggered_only = yes and therefore requires an inbound event/on_action call site.'
                            : 'The definition may use an engine-managed entry mechanism; dynamic reachability remains advisory.',
                    });
                } else if (references < MAX_REFERENCE_CANDIDATES) {
                    references++;
                    push({
                        kind: 'reference_exists',
                        claim: `referenced event id '${idStmt.scalarValue}' exists`,
                        blocking: true,
                        subject: { type: 'reference', id: idStmt.scalarValue, refKind: 'event' },
                    });
                }
            }
            continue;
        }

        // Static modifier references: add_modifier/remove_modifier = { modifier = X }, has_modifier = X.
        if (!stmt.isBlock && stmt.scalarValue) {
            const parent = stmt.chain[stmt.chain.length - 1]?.toLowerCase();
            if (lowerName === 'modifier' && (parent === 'add_modifier' || parent === 'remove_modifier')) {
                if (references < MAX_REFERENCE_CANDIDATES) {
                    references++;
                    push({
                        kind: 'reference_exists',
                        claim: `referenced static modifier '${stmt.scalarValue}' exists`,
                        blocking: true,
                        subject: { type: 'reference', id: stmt.scalarValue, refKind: 'static_modifier' },
                    });
                }
                continue;
            }
            if (lowerName === 'has_modifier' && containerPositionFor(stmt.chain, payload.targetFile) !== undefined) {
                if (references < MAX_REFERENCE_CANDIDATES) {
                    references++;
                    push({
                        kind: 'reference_exists',
                        claim: `referenced static modifier '${stmt.scalarValue}' exists`,
                        blocking: true,
                        subject: { type: 'reference', id: stmt.scalarValue, refKind: 'static_modifier' },
                    });
                }
                continue;
            }
        }

        // Explicit entity-id arguments are verified separately from the
        // effect/trigger symbol itself. This prevents a legal rule name such
        // as `has_technology` from lending credibility to a fabricated id.
        const typedReference = typedReferenceForStatement(stmt, payload.targetFile);
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
        const position = containerPositionFor(stmt.chain, payload.targetFile);
        if (position === undefined) continue;
        if (stmt.name.length === 0 || !/^[A-Za-z_][\w.:-]*$/.test(stmt.name)) continue;
        if (stmt.isBlock && CONTAINER_POSITION[lowerName] !== undefined) {
            // Grammar containers such as `limit`, `trigger`, `immediate`, and
            // `option` establish the position of their children; they are not
            // themselves effect/trigger/modifier calls.
            continue;
        }
        if (!stmt.isBlock && position !== 'modifier' && SCALAR_ARG_KEYS.has(lowerName)) {
            // Option/event arguments (`name = my_loc_key`), not scripted calls.
            continue;
        }

        const scope = currentScopeFor(stmt.chain);
        push({
            kind: 'symbol_exists',
            claim: `'${stmt.name}' is a known ${position === 'any' ? 'effect/trigger' : position} usable here`,
            blocking: true,
            subject: {
                type: 'rule',
                name: stmt.name,
                position: stmt.isBlock && CONTAINER_POSITION[lowerName] ? 'any' : position,
                currentScope: scope,
            },
        });
        unknownNames++;
        if (unknownNames >= MAX_UNKNOWN_NAME_CANDIDATES) break;
    }

    // on_actions commonly use bare identifiers in `events = { id.1 id.2 }`.
    // Strip comments and quoted text first so documentation cannot create proof.
    const searchable = payload.text
        .replace(/"(?:\\.|[^"\\])*"/g, ' ')
        .replace(/#[^\r\n]*/g, ' ');
    const eventLists = /\bevents\s*=\s*\{([^{}]{0,4000})\}/gi;
    let listMatch: RegExpExecArray | null;
    while (references < MAX_REFERENCE_CANDIDATES && (listMatch = eventLists.exec(searchable)) !== null) {
        for (const token of listMatch[1]!.split(/\s+/)) {
            if (references >= MAX_REFERENCE_CANDIDATES) break;
            if (!/^[A-Za-z_][\w.-]*\.\d+$/.test(token)) continue;
            references++;
            push({
                kind: 'reference_exists',
                claim: `referenced event id '${token}' exists`,
                blocking: true,
                subject: { type: 'reference', id: token, refKind: 'event' },
            });
        }
    }

    return claims;
}
