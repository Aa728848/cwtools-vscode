import * as path from 'path';
import type { AgentMode, AgentStep } from './types';
import { WRITE_TOOLS } from './tools/registry';

const PLAN_ARTIFACT_PATTERN = /(?:^|[\\/])implementation_plan\.md$/i;
const PLAN_HANDOFF_BLOCK_PATTERN = /```cwtools-plan\s*([\s\S]*?)```/gi;
const EXECUTE_HANDOFF_MODES = new Set<AgentMode>(['build', 'utility', 'orchestrator', 'script']);
const NON_PROJECT_WRITE_TOOLS = new Set(['git_ops', 'write_design_blueprint', 'save_workflow']);

export interface ImplementationPlanOperation {
    id: string;
    description: string;
    files: string[];
    dependsOn: string[];
}

export interface ImplementationPlanHandoff {
    version: 1;
    status: 'ready';
    objective: string;
    targetFiles: string[];
    operations: ImplementationPlanOperation[];
    verification: string[];
    acceptanceCriteria: string[];
    risks: Array<{ risk: string; mitigation: string }>;
    rollback: string[];
    unresolvedCritical: [];
}

export interface ImplementationPlanValidation {
    complete: boolean;
    missing: string[];
    handoff?: ImplementationPlanHandoff;
}

export const IMPLEMENTATION_PLAN_HANDOFF_CONTRACT = `Before requesting approval, append exactly one fenced \`cwtools-plan\` JSON block to the self-contained plan:
\`\`\`cwtools-plan
{
  "version": 1,
  "status": "ready",
  "objective": "Concrete delivery objective",
  "targetFiles": ["exact/project/file.ts"],
  "operations": [
    { "id": "op_1", "description": "Exact change", "files": ["exact/project/file.ts"], "dependsOn": [] }
  ],
  "verification": ["Exact check or test"],
  "acceptanceCriteria": ["Observable completion criterion"],
  "risks": [{ "risk": "Concrete risk", "mitigation": "Mitigation" }],
  "rollback": ["Concrete rollback step"],
  "unresolvedCritical": []
}
\`\`\`
The host renders an approval card only when this contract is present and valid. Every target must be an exact file path without globs and must be owned by exactly one operation, operation dependencies must reference valid operation IDs without cycles, and unresolvedCritical must be empty. Do not emit the block for preliminary analysis, exploration findings, clarification questions, drafts, or blocked plans.`;

export const IMPLEMENTATION_PLAN_AUTHORING_GUIDANCE = `Plan authoring guidance — keep the contract strict while adapting the prose to the task:
- Scale the plan to the real work. A cohesive one-file change may have one concise operation; cross-file work should split only at meaningful ownership or dependency boundaries. Do not pad a small task or force every plan into the same large-task template.
- Make the human-readable body execution-ready without relying on earlier chat. Organize it into multiple meaningful Markdown sections so objective/context, concrete operations and data flow, and verification/acceptance/risks/rollback are easy to find. Section names and depth should follow the task.
- Build the contract from verified evidence before writing the artifact. targetFiles is the canonical manifest: use exact project file paths, no globs or placeholders, and make it equal the union of operation files with every file owned exactly once. A verification-only operation may use an empty files array.
- Give every operation a unique stable ID. dependsOn may reference only existing operation IDs and must contain no self-reference or cycle. Use an empty dependency list when no dependency exists.
- Keep verification, acceptanceCriteria, risks with mitigations, and rollback concrete and non-empty. For a small change these may be brief, but they must still describe an observable check, a realistic regression risk, and a practical recovery action.
- unresolvedCritical may be empty only after every decision that could change files, architecture, behavior, or acceptance has been resolved. If such a decision remains, ask the user or report the blocker; do not write a ready plan or emit the handoff block.
- Append exactly one cwtools-plan fence containing strict JSON with no comments or trailing commas. The JSON is a machine-readable index of the prose, not a substitute for it.
- When writing the plan artifact, use the exact Agent Workspace Dir from Current Editor Context and the filename Implementation_Plan.md. Never guess a topic path or write plan.md/project-root artifacts. Perform this self-check before the first write instead of relying on tool rejection to discover omissions.`;

export const EXECUTE_IMPLEMENTATION_PLAN_HANDOFF_CONTRACT = `${IMPLEMENTATION_PLAN_HANDOFF_CONTRACT}
${IMPLEMENTATION_PLAN_AUTHORING_GUIDANCE}
In a writable execution or coordinator mode, keep ordinary internal planning silent and continue through implementation and verification in the same turn. However, once you present a proposed implementation approach to the user as a reviewable plan, that presentation becomes an approval boundary: write this same complete document, including the cwtools-plan block, to Implementation_Plan.md in the exact current Agent Workspace Dir and STOP. Never display a user-facing plan and then continue into project writes or dispatch in the same turn.`;

export function shouldPauseForInteractivePlan(
    content: string,
    context: { mode: AgentMode; approvedPlanExecution?: boolean },
): boolean {
    return !context.approvedPlanExecution
        && EXECUTE_HANDOFF_MODES.has(context.mode)
        && validateImplementationPlan(content).complete;
}

export function isCompleteImplementationPlanWrite(
    toolName: string,
    args: Record<string, unknown>,
    targetPaths: readonly string[],
): boolean {
    if (toolName !== 'write_file' || typeof args.content !== 'string') return false;
    const targets = targetPaths.length > 0
        ? targetPaths
        : typeof args.file === 'string' ? [args.file] : [];
    return targets.some(target => PLAN_ARTIFACT_PATTERN.test(target))
        && validateImplementationPlan(args.content).complete;
}

/** Runtime-only contract added after the cache-stable system prompt on approval continuations. */
export function buildApprovedPlanExecutionReminder(): string {
    return `<approved-plan-execution>
The approved Implementation Plan is the final design authority and is design-complete.
Enter Write/Execute immediately. Read the approved artifacts and execute their file operations or task DAG faithfully.
Do not re-enter discovery or design, regenerate a blueprint, reinterpret the architecture, or request approval again.
If an approved blueprintFile exists, dispatch that exact file. Otherwise, translate the approved Implementation Plan into the required dispatch payload mechanically, without adding design decisions.
After implementation and verification, produce the requested walkthrough.
</approved-plan-execution>`;
}

function targetPath(step: AgentStep): string {
    const args = step.toolArgs;
    for (const key of ['file', 'filePath', 'TargetFile', 'targetFile']) {
        if (typeof args?.[key] === 'string') return args[key] as string;
    }
    return '';
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(isNonEmptyString);
}

function parsePlanHandoff(planText: string): { blockCount: number; value?: unknown } {
    const blocks = [...planText.matchAll(PLAN_HANDOFF_BLOCK_PATTERN)];
    if (blocks.length !== 1 || !blocks[0]?.[1]) return { blockCount: blocks.length };
    try {
        return { blockCount: 1, value: JSON.parse(blocks[0][1]) };
    } catch {
        return { blockCount: 1 };
    }
}

function isExactFilePath(value: string): boolean {
    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized || normalized.endsWith('/') || normalized.includes('://')) return false;
    if (/[*?[\]{}<>]/.test(normalized)) return false;
    if (/(?:^|\/)(?:\.{1,2}|tbd|todo|unknown|待定)(?:\/|$)/i.test(normalized)) return false;
    return true;
}

function hasOperationCycle(operations: ImplementationPlanOperation[]): boolean {
    const dependencies = new Map(operations.map(operation => [operation.id, operation.dependsOn]));
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): boolean => {
        if (visiting.has(id)) return true;
        if (visited.has(id)) return false;
        visiting.add(id);
        for (const dependency of dependencies.get(id) ?? []) {
            if (visit(dependency)) return true;
        }
        visiting.delete(id);
        visited.add(id);
        return false;
    };

    return operations.some(operation => visit(operation.id));
}

/** Validate the explicit machine-readable contract plus the human-readable plan body. */
export function validateImplementationPlan(planText: string): ImplementationPlanValidation {
    const missing: string[] = [];
    const parsed = parsePlanHandoff(planText);
    if (parsed.blockCount !== 1) {
        return { complete: false, missing: ['exactly one cwtools-plan contract'] };
    }
    if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
        return { complete: false, missing: ['valid cwtools-plan JSON'] };
    }

    const candidate = parsed.value as Record<string, unknown>;
    if (candidate.version !== 1) missing.push('version=1');
    if (candidate.status !== 'ready') missing.push('status=ready');
    if (!isNonEmptyString(candidate.objective)) missing.push('objective');
    if (!isNonEmptyStringArray(candidate.targetFiles)
        || !candidate.targetFiles.every(isExactFilePath)
        || new Set(candidate.targetFiles.map(file => file.trim())).size !== candidate.targetFiles.length) {
        missing.push('exact unique targetFiles');
    }
    if (!isNonEmptyStringArray(candidate.verification)) missing.push('verification');
    if (!isNonEmptyStringArray(candidate.acceptanceCriteria)) missing.push('acceptanceCriteria');
    if (!isNonEmptyStringArray(candidate.rollback)) missing.push('rollback');
    if (!Array.isArray(candidate.unresolvedCritical) || candidate.unresolvedCritical.length !== 0) {
        missing.push('unresolvedCritical must be empty');
    }

    const risks = Array.isArray(candidate.risks) ? candidate.risks : [];
    if (risks.length === 0 || !risks.every(risk => {
        if (!risk || typeof risk !== 'object' || Array.isArray(risk)) return false;
        const record = risk as Record<string, unknown>;
        return isNonEmptyString(record.risk) && isNonEmptyString(record.mitigation);
    })) {
        missing.push('risks');
    }

    const rawOperations = Array.isArray(candidate.operations) ? candidate.operations : [];
    const operations: ImplementationPlanOperation[] = [];
    for (const rawOperation of rawOperations) {
        if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) continue;
        const operation = rawOperation as Record<string, unknown>;
        if (!isNonEmptyString(operation.id)
            || !isNonEmptyString(operation.description)
            || !isStringArray(operation.files)
            || !operation.files.every(isExactFilePath)
            || new Set(operation.files.map(file => file.trim())).size !== operation.files.length
            || !Array.isArray(operation.dependsOn)
            || !operation.dependsOn.every(isNonEmptyString)) continue;
        operations.push({
            id: operation.id.trim(),
            description: operation.description.trim(),
            files: operation.files.map(file => file.trim()),
            dependsOn: operation.dependsOn.map(id => id.trim()),
        });
    }
    if (operations.length !== rawOperations.length || operations.length === 0) missing.push('operations');

    const operationIds = new Set(operations.map(operation => operation.id));
    if (operationIds.size !== operations.length) missing.push('unique operation IDs');
    if (operations.some(operation => operation.dependsOn.some(id => id === operation.id || !operationIds.has(id)))) {
        missing.push('valid operation dependencies');
    } else if (hasOperationCycle(operations)) {
        missing.push('acyclic operation dependencies');
    }

    if (isNonEmptyStringArray(candidate.targetFiles) && operations.length > 0) {
        const targetFiles = new Set(candidate.targetFiles.map(file => file.trim()));
        const operationFiles = operations.flatMap(operation => operation.files);
        const ownedFiles = new Set(operationFiles);
        if ([...targetFiles].some(file => !ownedFiles.has(file))
            || [...ownedFiles].some(file => !targetFiles.has(file))
            || operationFiles.length !== ownedFiles.size) {
            missing.push('operation file ownership');
        }
    }

    const humanBody = planText.replace(PLAN_HANDOFF_BLOCK_PATTERN, '').trim();
    const headingCount = humanBody.match(/^#{1,4}\s+\S.+$/gm)?.length ?? 0;
    if (humanBody.length < 240) missing.push('self-contained plan body');
    if (headingCount < 3) missing.push('at least three plan sections');

    if (missing.length > 0) return { complete: false, missing };
    return {
        complete: true,
        missing: [],
        handoff: {
            version: 1,
            status: 'ready',
            objective: candidate.objective as string,
            targetFiles: (candidate.targetFiles as string[]).map(file => file.trim()),
            operations,
            verification: candidate.verification as string[],
            acceptanceCriteria: candidate.acceptanceCriteria as string[],
            risks: risks as Array<{ risk: string; mitigation: string }>,
            rollback: candidate.rollback as string[],
            unresolvedCritical: [],
        },
    };
}

function toolResultSucceeded(step: AgentStep): boolean {
    if (step.type !== 'tool_result' || !step.toolResult
        || typeof step.toolResult !== 'object' || Array.isArray(step.toolResult)) return false;
    const result = step.toolResult as Record<string, unknown>;
    return result.success !== false && result.ok !== false && result.error === undefined;
}

function sameArtifactPath(target: string, expectedPath: string, workspaceRoot?: string): boolean {
    const resolvedTarget = path.isAbsolute(target)
        ? path.resolve(target)
        : path.resolve(workspaceRoot ?? process.cwd(), target);
    const resolvedExpected = path.resolve(expectedPath);
    return process.platform === 'win32'
        ? resolvedTarget.toLowerCase() === resolvedExpected.toLowerCase()
        : resolvedTarget === resolvedExpected;
}

export function hasImplementationPlanArtifact(
    steps: AgentStep[],
    options: { expectedPath?: string; workspaceRoot?: string } = {},
): boolean {
    const successfulInvocations = new Set(steps
        .filter(step => toolResultSucceeded(step) && typeof step.invocationId === 'string')
        .map(step => step.invocationId as string));
    return steps.some(step => {
        if (step.type !== 'tool_call' || typeof step.invocationId !== 'string'
            || !successfulInvocations.has(step.invocationId)) return false;
        const target = targetPath(step);
        if (!PLAN_ARTIFACT_PATTERN.test(target)) return false;
        return !options.expectedPath || sameArtifactPath(target, options.expectedPath, options.workspaceRoot);
    });
}

/**
 * Accept only a complete structured Plan-mode result or an explicit plan artifact
 * created by an Execute-mode main Agent. Explore/Review prose can never become a plan.
 */
export function shouldRenderInteractivePlan(
    result: Pick<{ explanation: string; steps: AgentStep[] }, 'explanation' | 'steps'>,
    context: {
        mode: AgentMode;
        planText?: string;
        hasCurrentPlanArtifact?: boolean;
        approvedPlanExecution?: boolean;
    },
): boolean {
    const toolCalls = result.steps.filter(step => step.type === 'tool_call' && typeof step.toolName === 'string');
    const wrotePlanArtifact = context.hasCurrentPlanArtifact ?? hasImplementationPlanArtifact(result.steps);
    const wroteProjectFile = toolCalls.some(step => !NON_PROJECT_WRITE_TOOLS.has(String(step.toolName))
        && WRITE_TOOLS.has(step.toolName as any)
        && !PLAN_ARTIFACT_PATTERN.test(targetPath(step)));
    if (wroteProjectFile) return false;
    if (context.approvedPlanExecution) return false;
    if (context.mode !== 'plan' && !EXECUTE_HANDOFF_MODES.has(context.mode)) return false;

    const planText = context.planText ?? (context.mode === 'plan' ? result.explanation : '');
    return (context.mode === 'plan' || wrotePlanArtifact || shouldPauseForInteractivePlan(planText, context))
        && validateImplementationPlan(planText).complete;
}
