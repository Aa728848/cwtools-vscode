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

import * as fs from 'fs';
import * as path from 'path';
import type { AgentExecutionStrategy, AgentIntent, AgentRuntimeDomain, AgentToolName } from './types';
import { getProjectWorkspaceRoot } from './workspacePaths';
import { TOOL_REGISTRY } from './tools/registry';

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
	 *  If 'blocklist', listed tools are excluded from the scheduled profile's default set. */
	strategy: 'allowlist' | 'blocklist';
	/** Tool names to allow or block. */
	tools: AgentToolName[];
}

export interface WorkflowSchedulingProfile {
	domain: AgentRuntimeDomain;
	intent: Exclude<AgentIntent, 'auto'>;
	strategy: Exclude<AgentExecutionStrategy, 'auto'>;
	profileName?: string;
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
	/** Explicit routing profile used to create the canonical scheduling state. */
	scheduling: WorkflowSchedulingProfile;
	/** Context requirements that must be satisfied before launching. */
	requiredContext: WorkflowContextRequirement[];
	/** Tool access policy for the entire workflow. */
	toolPolicy: WorkflowToolPolicy;
	/** Ordered phases the workflow progresses through. */
	phases: WorkflowPhase[];
	/** Verification steps to check before marking the workflow complete. */
	verification: WorkflowVerificationStep[];
	/** Optional system prompt supplement injected for this workflow. */
	promptSupplement?: string;
}

export interface WorkflowSaveInput {
	id?: string;
	title: string;
	description: string;
	domain: AgentRuntimeDomain;
	intent: Exclude<AgentIntent, 'auto'>;
	strategy: Exclude<AgentExecutionStrategy, 'auto'>;
	profileName?: string;
	promptSupplement: string;
	allowedTools?: AgentToolName[];
	blockedTools?: AgentToolName[];
	requiredContext?: Array<WorkflowContextRequirement['kind'] | `${WorkflowContextRequirement['kind']}!`>;
	verificationTool?: AgentToolName;
	overwrite?: boolean;
}

export interface SaveProjectWorkflowResult {
	success: boolean;
	id: string;
	message: string;
	filePath?: string;
	workflow?: AiWorkflow;
	alreadyExists?: boolean;
}

// ─── Workflow registry ───────────────────────────────────────────────────────

const WORKFLOWS: Map<string, AiWorkflow> = new Map();

function registerWorkflow(workflow: AiWorkflow): void {
	WORKFLOWS.set(workflow.id, workflow);
}

/** Shared live semantic tools required to keep built-in workflows on the
 * current CWTools graph instead of falling back to raw scans. */
const DEEP_PARADOX_READ_TOOLS: AgentToolName[] = [
	'query_inline_instantiation', 'analyze_pdx_flow', 'compare_definition_with_vanilla',
	'query_interface_knowledge', 'search_rule_capabilities', 'explain_scope',
	'parse_pdx_fragment', 'get_pdx_block', 'get_completion_at',
];

// ── Diagnostic Fix Workflow ──────────────────────────────────────────────────

registerWorkflow({
	id: 'diagnostic-fix',
	title: 'Diagnostic Fix',
	description: 'Automatically fix CWTools LSP diagnostics in the current file or workspace.',
	scheduling: { domain: 'paradox', intent: 'execute', strategy: 'single' },
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
			'explore_pdx_project',
			...DEEP_PARADOX_READ_TOOLS,
			// Read & analyze
			'read_file', 'document_symbols', 'workspace_symbols',
			'grep', 'query_localisation_index', 'query_workspace_index', 'query_project_profile', 'query_project_knowledge', 'get_lsp_status', 'get_diagnostics', 'verify_pdx_identifier',
			// Query rules
			'query_scope', 'query_types', 'query_cwt_schema', 'query_rules', 'query_override_modes', 'find_references',
			'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
			'go_to_definition',
			'query_static_modifiers', 'query_variables',
			// Asset lookup
			'find_sprite_candidates', 'find_sound_candidates',
			// Write
			'write_file', 'edit_file', 'replace_lines',
			'write_localisation',
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
	scheduling: { domain: 'paradox', intent: 'execute', strategy: 'single' },
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
			'explore_pdx_project',
			...DEEP_PARADOX_READ_TOOLS,
			// Read & analyze
			'read_file', 'document_symbols', 'workspace_symbols',
			'grep', 'query_localisation_index', 'query_workspace_index', 'query_project_profile', 'query_project_knowledge', 'list_directory', 'glob_files',
			'get_lsp_status', 'get_diagnostics', 'verify_pdx_identifier',
			// Query
			'query_types', 'go_to_definition',
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
			description: 'All generated localisation keys are searchable via grep.',
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
	description: 'Design and plan a new event chain with common/ subsystem review, scope chains, rewards, and dependencies.',
	scheduling: { domain: 'paradox', intent: 'plan', strategy: 'single' },
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
			'explore_pdx_project',
			...DEEP_PARADOX_READ_TOOLS,
			// Read-only analysis
			'read_file', 'document_symbols', 'workspace_symbols',
			'grep', 'query_localisation_index', 'query_workspace_index', 'query_project_profile', 'query_project_knowledge', 'list_directory', 'glob_files',
			'get_lsp_status', 'get_diagnostics', 'verify_pdx_identifier',
			// Deep API
			'query_scope', 'query_types', 'query_cwt_schema', 'query_rules', 'query_override_modes', 'find_references',
			'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
			'go_to_definition',
			'get_entity_info', 'query_static_modifiers', 'query_variables',
			// Web research
			'web_search', 'web_open', 'web_find',
			// Design output
			'write_design_blueprint',
			// Memory
			'set_memory', 'query_blackboard',
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
			id: 'common-review',
			title: 'Common Capability Review',
			description: 'Inventory common/ directories and decide which engine subsystems should anchor progression, agency, rewards, and cleanup.',
		},
		{
			id: 'topology',
			title: 'Pipeline Topology',
			description: 'Map the entry point, intermediate nodes, and outcomes.',
		},
		{
			id: 'rewards',
			title: 'Reward Implementation',
			description: 'Map outcomes to concrete entity families discovered from the active TypeDefs and project knowledge graph.',
		},
		{
			id: 'blueprint',
			title: 'Blueprint',
			description: 'Write the design blueprint with common review, subsystem plan, scope chains, ID allocation, rewards, and cleanup.',
		},
	],
	verification: [
		{
			id: 'common-review-written',
			description: 'The blueprint records common/ directories considered, selected, and rejected with rationale.',
			required: true,
		},
		{
			id: 'reward-plan-written',
			description: 'The blueprint maps rewards and outcomes to concrete common entity families.',
			required: true,
		},
		{
			id: 'blueprint-written',
			description: 'A design_blueprint.md has been created in the topic directory.',
			required: true,
		},
	],
	promptSupplement: `You are running in the **Event Chain Design Workflow**. Follow the Deep Archetype Study (Rule 0c), Common Directory Capability Review, and Blueprint Architecture (Step 3) protocols strictly. The final blueprint must show which current-game common/ directories were considered, which are selected, why unused candidates are rejected, and how rewards/outcomes are implemented through concrete common entity families.`,
});

// ── Rules Sync Review Workflow ───────────────────────────────────────────────

registerWorkflow({
	id: 'rules-sync-review',
	title: 'Rules Sync Review',
	description: 'Review the project after a CWTools rules update to identify new or changed diagnostics.',
	scheduling: { domain: 'paradox', intent: 'review', strategy: 'single' },
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
			'explore_pdx_project',
			...DEEP_PARADOX_READ_TOOLS,
			'read_file', 'document_symbols', 'workspace_symbols',
			'grep', 'query_localisation_index', 'query_workspace_index', 'query_project_profile', 'query_project_knowledge', 'list_directory', 'glob_files',
			'get_lsp_status', 'get_diagnostics', 'verify_pdx_identifier',
			'query_scope', 'query_types', 'query_cwt_schema', 'query_rules', 'query_override_modes', 'find_references',
			'query_scripted_effects', 'query_scripted_triggers', 'query_enums',
			'go_to_definition',
			'get_entity_info', 'query_static_modifiers', 'query_variables',
			'find_sprite_candidates', 'find_sound_candidates',
			'web_search', 'web_open', 'web_find',
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
	scheduling: { domain: 'paradox', intent: 'execute', strategy: 'single' },
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
			'explore_pdx_project',
			...DEEP_PARADOX_READ_TOOLS,
			'read_file', 'document_symbols', 'workspace_symbols',
			'grep', 'query_localisation_index', 'query_workspace_index', 'query_project_profile', 'query_project_knowledge', 'list_directory', 'glob_files',
			'get_lsp_status', 'get_diagnostics', 'verify_pdx_identifier',
			'find_sprite_candidates', 'find_sound_candidates',
			'query_cwt_schema', 'query_rules', 'query_override_modes',
			'write_file', 'edit_file', 'replace_lines',
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

// Project workflow files:
// .cwtools/workflows/<id>.md
// Frontmatter keys: id, title, description, domain, intent, strategy, profile,
// allowed-tools, blocked-tools, required-context, verification-tool.
function parseWorkflowFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	const normalized = content.replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---')) return { meta: {}, body: normalized.trim() };
	const lines = normalized.split(/\r?\n/);
	const meta: Record<string, string> = {};
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (line.trim() === '---') {
			end = i;
			break;
		}
		const match = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
		if (match) {
			meta[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^["']|["']$/g, '');
		}
	}
	return end >= 0
		? { meta, body: lines.slice(end + 1).join('\n').trim() }
		: { meta: {}, body: normalized.trim() };
}

function splitCsv(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(/[,\n]/).map(v => v.trim()).filter(Boolean);
}

function parseSchedulingProfile(values: {
	domain?: string;
	intent?: string;
	strategy?: string;
	profileName?: string;
}): WorkflowSchedulingProfile | undefined {
	const domain = values.domain?.trim();
	const intent = values.intent?.trim();
	const strategy = values.strategy?.trim();
	const profileName = values.profileName?.trim();
	if (domain !== 'paradox' && domain !== 'general' && domain !== 'hybrid') return undefined;
	if (intent !== 'execute' && intent !== 'plan' && intent !== 'explore' && intent !== 'review') return undefined;
	if (strategy !== 'single' && strategy !== 'multi') return undefined;
	if (profileName && !/^[a-zA-Z0-9_.-]{1,80}$/.test(profileName)) return undefined;
	return { domain, intent, strategy, ...(profileName ? { profileName } : {}) };
}

function parseToolList(value: string | undefined): AgentToolName[] {
	const tools: AgentToolName[] = [];
	for (const raw of splitCsv(value)) {
		const name = raw as AgentToolName;
		if (TOOL_REGISTRY.has(name as any)) tools.push(name);
	}
	return tools;
}

function uniqueTools(values: AgentToolName[] | undefined): AgentToolName[] {
	const out: AgentToolName[] = [];
	const seen = new Set<string>();
	for (const value of values || []) {
		const name = String(value || '').trim() as AgentToolName;
		if (!name || seen.has(name)) continue;
		if (!TOOL_REGISTRY.has(name as any)) continue;
		seen.add(name);
		out.push(name);
	}
	return out;
}

function parseRequiredContext(value: string | undefined): WorkflowContextRequirement[] {
	const entries = splitCsv(value);
	if (entries.length === 0) {
		return [{ kind: 'workspace', required: false, description: 'Workspace context is optional.' }];
	}
	return entries.map(raw => {
		const required = raw.endsWith('!');
		const clean = raw.replace(/!$/, '').trim() as WorkflowContextRequirement['kind'];
		const valid = ['activeFile', 'diagnostics', 'selection', 'workspace'].includes(clean) ? clean : 'workspace';
		return {
			kind: valid,
			required,
			description: `${valid} context${required ? ' is required' : ' is useful'} for this workflow.`,
		};
	});
}

function parseProjectWorkflow(filePath: string): AiWorkflow | undefined {
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const { meta, body } = parseWorkflowFrontmatter(raw);
		const id = (meta.id || path.basename(filePath, path.extname(filePath))).trim();
		if (!id) return undefined;
		const scheduling = parseSchedulingProfile({
			domain: meta.domain,
			intent: meta.intent,
			strategy: meta.strategy,
			profileName: meta.profile,
		});
		if (!scheduling) return undefined;

		const allowedTools = parseToolList(meta['allowed-tools']);
		const blockedTools = parseToolList(meta['blocked-tools']);
		const hasAllowlist = allowedTools.length > 0 || meta['tool-policy']?.toLowerCase() === 'allowlist';
		const toolPolicy: WorkflowToolPolicy = hasAllowlist
			? { strategy: 'allowlist', tools: allowedTools }
			: { strategy: 'blocklist', tools: blockedTools };

		const verificationTool = meta['verification-tool'] as AgentToolName | undefined;
		const verification: WorkflowVerificationStep[] = verificationTool && TOOL_REGISTRY.has(verificationTool as any)
			? [{
				id: 'verify',
				description: `Run ${verificationTool} for workflow verification.`,
				verificationTool,
				required: true,
			}]
			: [];

		return {
			id,
			title: meta.title || id,
			description: meta.description || 'Project-defined workflow.',
			scheduling,
			requiredContext: parseRequiredContext(meta['required-context']),
			toolPolicy,
			phases: [{
				id: 'run',
				title: 'Run Workflow',
				description: meta.phase || 'Follow the project-defined workflow instructions.',
			}],
			verification,
			promptSupplement: body || undefined,
		};
	} catch {
		return undefined;
	}
}

function loadProjectWorkflows(): Map<string, AiWorkflow> {
	const out = new Map<string, AiWorkflow>();
	const workspaceRoot = getProjectWorkspaceRoot();
	if (!workspaceRoot) return out;

	const dirs = [path.join(workspaceRoot, '.cwtools', 'workflows')];
	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
			const workflow = parseProjectWorkflow(path.join(dir, entry.name));
			if (workflow) out.set(workflow.id, workflow);
		}
	}
	return out;
}

function sanitizeWorkflowId(value: string | undefined, fallbackTitle: string): string {
	const source = (value || fallbackTitle || '').trim().toLowerCase();
	const sanitized = source
		.replace(/[^a-z0-9_.-]+/g, '-')
		.replace(/^[.-]+|[.-]+$/g, '')
		.slice(0, 80);
	return sanitized || `workflow-${Date.now()}`;
}

function frontmatterValue(value: string): string {
	return value.replace(/\r?\n/g, ' ').replace(/"/g, '\\"').trim();
}

function formatFrontmatterCsv(values: string[]): string | undefined {
	const clean = values.map(v => v.trim()).filter(Boolean);
	return clean.length > 0 ? clean.join(', ') : undefined;
}

function normalizeRequiredContextForSave(values: WorkflowSaveInput['requiredContext']): string[] {
	const entries = values && values.length > 0 ? values : ['workspace!'];
	const validKinds = new Set(['activeFile', 'diagnostics', 'selection', 'workspace']);
	const out: string[] = [];
	for (const raw of entries) {
		const text = String(raw || '').trim();
		const required = text.endsWith('!');
		const kind = text.replace(/!$/, '');
		if (!validKinds.has(kind)) continue;
		out.push(`${kind}${required ? '!' : ''}`);
	}
	return out.length > 0 ? out : ['workspace!'];
}

export function saveProjectWorkflow(
	input: WorkflowSaveInput,
	workspaceRoot = getProjectWorkspaceRoot(),
	onBeforeWrite?: (filePath: string, previousContent: string | null) => void
): SaveProjectWorkflowResult {
	if (!workspaceRoot) {
		return { success: false, id: '', message: 'No workspace is open; cannot save a project workflow.' };
	}

	const title = String(input.title || '').trim();
	const description = String(input.description || '').trim();
	const promptSupplement = String(input.promptSupplement || '').trim();
	if (!title) {
		return { success: false, id: '', message: 'Workflow title is required.' };
	}
	if (!description) {
		return { success: false, id: '', message: 'Workflow description is required.' };
	}
	if (!promptSupplement) {
		return { success: false, id: '', message: 'Workflow instructions are required.' };
	}
	const scheduling = parseSchedulingProfile({
		domain: input.domain,
		intent: input.intent,
		strategy: input.strategy,
		profileName: input.profileName,
	});
	if (!scheduling) {
		return { success: false, id: '', message: 'Workflow domain, intent, strategy, or profileName is invalid.' };
	}

	const id = sanitizeWorkflowId(input.id, title);
	const workflowDir = path.join(workspaceRoot, '.cwtools', 'workflows');
	const filePath = path.join(workflowDir, `${id}.md`);
	if (fs.existsSync(filePath) && !input.overwrite) {
		return {
			success: false,
			id,
			filePath,
			alreadyExists: true,
			message: `Workflow '${id}' already exists. Set overwrite=true to replace it.`,
		};
	}

	const allowedTools = uniqueTools(input.allowedTools);
	const blockedTools = uniqueTools(input.blockedTools);
	const requiredContext = normalizeRequiredContextForSave(input.requiredContext);
	const verificationTool = input.verificationTool && TOOL_REGISTRY.has(input.verificationTool as any)
		? input.verificationTool
		: undefined;

	const frontmatter: string[] = [
		'---',
		`id: ${id}`,
		`title: "${frontmatterValue(title)}"`,
		`description: "${frontmatterValue(description)}"`,
		`domain: ${scheduling.domain}`,
		`intent: ${scheduling.intent}`,
		`strategy: ${scheduling.strategy}`,
		`required-context: ${requiredContext.join(', ')}`,
	];
	if (scheduling.profileName) frontmatter.push(`profile: ${scheduling.profileName}`);
	const allowed = formatFrontmatterCsv(allowedTools);
	const blocked = formatFrontmatterCsv(blockedTools);
	if (allowed) {
		frontmatter.push(`allowed-tools: ${allowed}`);
	} else if (blocked) {
		frontmatter.push(`blocked-tools: ${blocked}`);
	}
	if (verificationTool) {
		frontmatter.push(`verification-tool: ${verificationTool}`);
	}
	frontmatter.push('---', '', promptSupplement, '');

	fs.mkdirSync(workflowDir, { recursive: true });
	const previousContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
	onBeforeWrite?.(filePath, previousContent);
	fs.writeFileSync(filePath, frontmatter.join('\n'), 'utf8');

	const workflow = parseProjectWorkflow(filePath);
	return {
		success: true,
		id,
		filePath,
		workflow,
		message: `Saved workflow '${id}' to ${filePath}. It is now available as /workflow:${id}.`,
	};
}

function getMergedWorkflowMap(): Map<string, AiWorkflow> {
	const merged = new Map(WORKFLOWS);
	for (const [id, workflow] of loadProjectWorkflows()) {
		merged.set(id, workflow);
	}
	return merged;
}

/**
 * Returns the workflow for a given ID, or undefined if not found.
 */
export function getWorkflow(id: string): AiWorkflow | undefined {
	return getMergedWorkflowMap().get(id);
}

/**
 * Returns all registered workflows.
 */
export function getAllWorkflows(): AiWorkflow[] {
	return Array.from(getMergedWorkflowMap().values());
}

/**
 * Returns all workflow IDs.
 */
export function getAllWorkflowIds(): string[] {
	return Array.from(getMergedWorkflowMap().keys());
}

/**
 * Derives the effective tool allowlist for a workflow.
 * If the workflow uses an allowlist strategy, returns those tools directly.
 * If it uses a blocklist, returns the scheduled profile's default tools minus blocked ones.
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
