import type { AgentStep, AgentToolStage } from './types';
import { WRITE_TOOLS } from './tools/registry';

const PLAN_READY_PATTERN = /(?:plan|proposal|方案|计划|修改方案)[\s\S]{0,80}(?:ready|prepared|complete|finalized|就绪|准备就绪|完成|完善)/i;
const PLAN_MENTION_PATTERN = /(?:implementation plan|proposed plan|plan|proposal|实施计划|执行计划|修改计划|修改方案|方案)/i;
const EXECUTION_WAIT_PATTERN = /(?:wait(?:ing)?|ready|next|等待|准备|随后|下一步)[\s\S]{0,80}(?:execute|execution|implement|write|apply|执行|实施|写入|修改)/i;
const APPROVAL_PATTERN = /(?:approve|approval|confirm|annotation|批准|审批|确认|批注)/i;
const PLAN_ARTIFACT_PATTERN = /(?:^|[\\/])(?:implementation_plan|plan)\.md$/i;

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

/**
 * Detect a main-Agent proposal that needs the interactive plan lifecycle.
 * This is artifact/intent driven rather than tied to Plan, Build, or orchestration
 * mode; sub-Agent results never pass through the main chat host that calls it.
 */
export function shouldRenderInteractivePlan(
    result: Pick<{ explanation: string; steps: AgentStep[] }, 'explanation' | 'steps'> & {
        tokenUsage?: { toolStage?: AgentToolStage };
    },
): boolean {
    const toolCalls = result.steps.filter(step => step.type === 'tool_call' && typeof step.toolName === 'string');
    const wrotePlanArtifact = toolCalls.some(step => PLAN_ARTIFACT_PATTERN.test(targetPath(step)));
    const wroteProjectFile = toolCalls.some(step => step.toolName !== 'git_ops'
        && WRITE_TOOLS.has(step.toolName as any)
        && !PLAN_ARTIFACT_PATTERN.test(targetPath(step)));
    if (wroteProjectFile) return false;
    if (wrotePlanArtifact) return true;
    if (!result.explanation.trim() || !PLAN_MENTION_PATTERN.test(result.explanation)) return false;
    if ((result.tokenUsage?.toolStage === 'design' || result.tokenUsage?.toolStage === 'evidence')
        && toolCalls.some(step => step.toolName === 'todo_write')) return true;
    const asksForInteraction = EXECUTION_WAIT_PATTERN.test(result.explanation) || APPROVAL_PATTERN.test(result.explanation);
    return asksForInteraction && (PLAN_READY_PATTERN.test(result.explanation) || APPROVAL_PATTERN.test(result.explanation));
}
