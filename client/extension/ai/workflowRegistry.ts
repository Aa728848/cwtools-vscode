/**
 * AI Workflow Registry
 *
 * Defines stable, repeatable workflows for common modding tasks.
 * Workflows are metadata-driven — they guide the existing runner
 * rather than replacing it.
 *
 * Phase 1 of the AI Workflow System plan:
 *   - Define workflow metadata
 *   - Register initial workflows (Diagnostic Fix, Localisation Generation)
 *   - Provide query helpers for runner integration
 */

import type { AgentMode, AgentToolName } from './types';

// ─── Workflow contracts ──────────────────────────────────────────────────────

/** What context is required before a workflow can start. */
export interface WorkflowContextRequirement {
	/** Kind of context: 'activeFile', 'diagnostics', 'selection', 'workspace' */
	kind: 'activeFile' | 'diagnostics' | 'selection' | 'workspace';
	/** Whether this context is strictly required (blocks launch if missing). */
	required: boolean;
	/** Human-readable description shown when context is missing. */
	description: string;
}

/** Controls which tools are available during workflow execution. */
export interface WorkflowToolPolicy {
	/** If 'allowlist', only the listed tools are available.
	 *  If 'blocklist', listed tools are excluded from the default mode set. */
	strategy: 'allowlist' | 'blocklist';
	/** Tool names to allow or block. */
	tools: AgentToolName[];
}

/** A discrete phase within a workflow (for UI display and progress tracking). */
export interface WorkflowPhase {
	/** Short identifier for this phase. */
	id: string;
	/** Human-readable title. */
	title: string;
	/** Description shown in the chat panel. */
	description: string;
	/** Optional: restrict tools further during this specific phase. */
	toolPolicy?: WorkflowToolPolicy;
}

/** A verification step that must pass before the workflow is considered complete. */
export interface WorkflowVerificationStep {
	/** Unique identifier. */
	id: string;
	/** Human-readable check description. */
	description: string;
	/** Tool to call for verification (e.g., 'get_diagnostics'). */
	verificationTool?: AgentToolName;
	/** Whether this check is required for workflow completion. */
	required: boolean;
}

/** Complete workflow definition. */
export interface AiWorkflow {
	/** Unique workflow identifier. */
	id: string;
	/** User-facing title. */
	title: string;
	/** Short description for display in the chat panel and command palette. */
	description: string;
	/** The agent mode this workflow runs in. */
	mode: AgentMode;
	/** Context requirements that must be satisfied before launching. */
	requiredContext: WorkflowContextRequirement[];
	/** Tool access policy for the entire workflow. */
	toolPolicy: WorkflowToolPolicy;
	/** Ordered phases the workflow progresses through. */
	phases: WorkflowPhase[];
	/** Verification steps to check before marking the workflow complete. */
	verification: WorkflowVerificationStep[];
	/** Optional: system prompt supplement injected before the mode prompt. */
	promptSupplement?: string;
}

// ─── Workflow registry ───────────────────────────────────────────────────────

const WORKFLOWS: Map<string, AiWorkflow> = new Map();

function registerWorkflow(workflow: AiWorkflow): void {
	WORKFLOWS.set(workflow.id, workflow);
}

// ── Diagnostic Fix Workflow ──────────────────────────────────────────────────

registerWorkflow({
	id: 'diagnostic-fix',
	title: 'Diagnostic Fix',
	description: 'Automatically fix CWTools LSP diagnostics in the current file or workspace.',
	mode: 'build',
	requiredContext: [
		{
			kind: 'diagnostics',
			required: true,
			description: 'At least one CWTools diagnostic must be present.',
		},
		{
			kind: 'activeFile',
			required: false,
			description: 'An active editor file helps scope the fix to a specific file.',
		},
	],
	toolPolicy: {
		strategy: 'allowlist',
		tools: [
			// Read & analyze
			'read_file', 'get_file_context', 'document_symbols', 'workspace_symbols',
			'search_mod_files', 'grep', 'query_localisation_index', 'query_workspace_index', 'get_diagnostics', 'verify_pdx_identifier',
			// Query rules
			'query_scope', 'query_types', 'query_rules', 'query_references',
			'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
			'query_definition', 'query_definition_by_name',
			'query_static_modifiers', 'query_variables',
			// Asset lookup
			'find_sprite_candidates', 'find_sound_candidates',
			// Write
			'write_file', 'multi_replace_file_content', 'replace_lines',
			'edit_pdx_block', 'write_localisation',
			// Reflection
			'analyze_diagnostic_error',
			// Task tracking
			'todo_write',
		],
	},
	phases: [
		{
			id: 'collect',
			title: 'Collect Diagnostics',
			description: 'Retrieve and classify all diagnostics from the target file(s).',
		},
		{
			id: 'analyze',
			title: 'Analyze Errors',
			description: 'Classify each diagnostic (code logic, forward ref, vanilla warning, asset ref).',
		},
		{
			id: 'fix',
			title: 'Apply Fixes',
			description: 'Fix each real error using the Error Fix Protocol.',
		},
		{
			id: 'verify',
			title: 'Verify',
			description: 'Re-run diagnostics to ensure zero real errors remain.',
		},
	],
	verification: [
		{
			id: 'zero-errors',
			description: 'get_diagnostics returns zero real (non-cache) errors.',
			verificationTool: 'get_diagnostics',
			required: true,
		},
	],
	promptSupplement: `You are running in the **Diagnostic Fix Workflow**. Your sole objective is to fix CWTools LSP diagnostics.
Follow the Diagnostic Framework and Error Fix Protocol strictly. Do NOT add new features or restructure code — only fix errors.`,
});

// ── Localisation Generation Workflow ─────────────────────────────────────────

registerWorkflow({
	id: 'loc-generation',
	title: 'Localisation Generation',
	description: 'Generate missing localisation entries for new or existing game entities.',
	mode: 'build',
	requiredContext: [
		{
			kind: 'workspace',
			required: true,
			description: 'A workspace must be open to scan for missing localisation keys.',
		},
	],
	toolPolicy: {
		strategy: 'allowlist',
		tools: [
			// Read & analyze
			'read_file', 'get_file_context', 'document_symbols', 'workspace_symbols',
			'search_mod_files', 'grep', 'query_localisation_index', 'query_workspace_index', 'list_directory', 'glob_files',
			'get_diagnostics', 'verify_pdx_identifier',
			// Query
			'query_types', 'query_definition_by_name',
			// Write (localisation only)
			'write_localisation', 'write_file',
			// Task tracking
			'todo_write',
		],
	},
	phases: [
		{
			id: 'scan',
			title: 'Scan for Missing Keys',
			description: 'Identify entities with missing localisation keys.',
		},
		{
			id: 'generate',
			title: 'Generate Entries',
			description: 'Create localisation entries using write_localisation.',
		},
		{
			id: 'verify',
			title: 'Verify',
			description: 'Confirm all generated keys resolve correctly.',
		},
	],
	verification: [
		{
			id: 'keys-present',
			description: 'All generated localisation keys are searchable via search_mod_files.',
			required: true,
		},
	],
	promptSupplement: `You are running in the **Localisation Generation Workflow**. Your sole objective is to generate missing localisation entries.
Use the write_localisation tool for all YML writes. Follow encoding conventions (UTF-8 BOM). Generate entries for ALL configured languages.`,
});

// ── Event Chain Design Workflow ──────────────────────────────────────────────

registerWorkflow({
	id: 'event-chain-design',
	title: 'Event Chain Design',
	description: 'Design and plan a new event chain with proper scope chains and dependencies.',
	mode: 'plan',
	requiredContext: [
		{
			kind: 'workspace',
			required: true,
			description: 'A workspace must be open to study existing patterns.',
		},
	],
	toolPolicy: {
		strategy: 'allowlist',
		tools: [
			// Read-only analysis
			'read_file', 'get_file_context', 'document_symbols', 'workspace_symbols',
			'search_mod_files', 'grep', 'query_localisation_index', 'query_workspace_index', 'list_directory', 'glob_files',
			'get_diagnostics', 'verify_pdx_identifier',
			// Deep API
			'query_scope', 'query_types', 'query_rules', 'query_references',
			'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
			'query_definition', 'query_definition_by_name',
			'get_entity_info', 'query_static_modifiers', 'query_variables',
			// Web research
			'web_fetch', 'search_web', 'codesearch',
			// Design output
			'write_design_blueprint',
			// Memory
			'set_memory', 'get_memory', 'search_memory',
			// Task tracking
			'todo_write',
		],
	},
	phases: [
		{
			id: 'archetype',
			title: 'Archetype Study',
			description: 'Find and study a vanilla event chain of similar complexity.',
		},
		{
			id: 'topology',
			title: 'Pipeline Topology',
			description: 'Map the entry point, intermediate nodes, and outcomes.',
		},
		{
			id: 'blueprint',
			title: 'Blueprint',
			description: 'Write the design blueprint with scope chains and ID allocation.',
		},
	],
	verification: [
		{
			id: 'blueprint-written',
			description: 'A design_blueprint.md has been created in the topic directory.',
			required: true,
		},
	],
	promptSupplement: `You are running in the **Event Chain Design Workflow**. Follow the Deep Archetype Study (Rule 0c) and Blueprint Architecture (Step 3) protocols strictly.`,
});

// ── Rules Sync Review Workflow ───────────────────────────────────────────────

registerWorkflow({
	id: 'rules-sync-review',
	title: 'Rules Sync Review',
	description: 'Review the project after a CWTools rules update to identify new or changed diagnostics.',
	mode: 'review',
	requiredContext: [
		{
			kind: 'workspace',
			required: true,
			description: 'A workspace must be open.',
		},
	],
	toolPolicy: {
		strategy: 'allowlist',
		tools: [
			'read_file', 'get_file_context', 'document_symbols', 'workspace_symbols',
			'search_mod_files', 'grep', 'query_localisation_index', 'query_workspace_index', 'list_directory', 'glob_files',
			'get_diagnostics', 'verify_pdx_identifier',
			'query_scope', 'query_types', 'query_rules', 'query_references',
			'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
			'query_definition', 'query_definition_by_name',
			'get_entity_info', 'query_static_modifiers', 'query_variables',
			'find_sprite_candidates', 'find_sound_candidates',
			'web_fetch', 'search_web', 'codesearch',
			'git_ops',
		],
	},
	phases: [
		{
			id: 'triage',
			title: 'Triage',
			description: 'Collect all diagnostics and categorize by type and severity.',
		},
		{
			id: 'deep-dive',
			title: 'Deep Dive',
			description: 'Inspect representative errors from the top 3 categories.',
		},
		{
			id: 'report',
			title: 'Report',
			description: 'Generate an actionable summary with priority-ranked recommendations.',
		},
	],
	verification: [],
});

// ── Asset Wiring Workflow ────────────────────────────────────────────────────

registerWorkflow({
	id: 'asset-wiring',
	title: 'Asset Wiring',
	description: 'Find and wire sprite/sound assets to entities with missing or invalid references.',
	mode: 'build',
	requiredContext: [
		{
			kind: 'diagnostics',
			required: false,
			description: 'Asset reference diagnostics help identify targets.',
		},
		{
			kind: 'workspace',
			required: true,
			description: 'A workspace must be open.',
		},
	],
	toolPolicy: {
		strategy: 'allowlist',
		tools: [
			'read_file', 'get_file_context', 'document_symbols', 'workspace_symbols',
			'search_mod_files', 'grep', 'query_localisation_index', 'query_workspace_index', 'list_directory', 'glob_files',
			'get_diagnostics', 'verify_pdx_identifier',
			'find_sprite_candidates', 'find_sound_candidates',
			'query_rules',
			'write_file', 'multi_replace_file_content', 'replace_lines',
			'edit_pdx_block',
			'todo_write',
		],
	},
	phases: [
		{
			id: 'scan',
			title: 'Scan Missing Assets',
			description: 'Collect all sprite/sound diagnostic errors.',
		},
		{
			id: 'resolve',
			title: 'Resolve Candidates',
			description: 'Find matching vanilla or project assets for each missing reference.',
		},
		{
			id: 'apply',
			title: 'Apply Wiring',
			description: 'Replace invalid asset references with verified candidates.',
		},
		{
			id: 'verify',
			title: 'Verify',
			description: 'Re-run diagnostics to confirm all asset references resolve.',
		},
	],
	verification: [
		{
			id: 'no-asset-errors',
			description: 'No sprite or sound reference diagnostics remain.',
			verificationTool: 'get_diagnostics',
			required: true,
		},
	],
	promptSupplement: `You are running in the **Asset Wiring Workflow**. Follow the Sprite Diagnostic Repair Protocol and Sound Asset Diagnostic Repair Protocol strictly.`,
});

// ─── Query helpers ───────────────────────────────────────────────────────────

/**
 * Returns the workflow for a given ID, or undefined if not found.
 */
export function getWorkflow(id: string): AiWorkflow | undefined {
	return WORKFLOWS.get(id);
}

/**
 * Returns all registered workflows.
 */
export function getAllWorkflows(): AiWorkflow[] {
	return Array.from(WORKFLOWS.values());
}

/**
 * Returns all workflow IDs.
 */
export function getAllWorkflowIds(): string[] {
	return Array.from(WORKFLOWS.keys());
}

/**
 * Derives the effective tool allowlist for a workflow.
 * If the workflow uses an allowlist strategy, returns those tools directly.
 * If it uses a blocklist, returns the default mode tools minus blocked ones.
 */
export function getWorkflowAllowedTools(
	workflow: AiWorkflow,
	defaultModeTools: AgentToolName[]
): AgentToolName[] {
	if (workflow.toolPolicy.strategy === 'allowlist') {
		return workflow.toolPolicy.tools;
	}
	const blocked = new Set(workflow.toolPolicy.tools);
	return defaultModeTools.filter(t => !blocked.has(t));
}

/**
 * Checks whether all required context is available for a workflow.
 * Returns a list of unsatisfied requirement descriptions.
 */
export function checkWorkflowContext(
	workflow: AiWorkflow,
	available: { activeFile?: boolean; diagnostics?: boolean; selection?: boolean; workspace?: boolean }
): string[] {
	const missing: string[] = [];
	for (const req of workflow.requiredContext) {
		if (!req.required) continue;
		const key = req.kind;
		if (!available[key]) {
			missing.push(req.description);
		}
	}
	return missing;
}
