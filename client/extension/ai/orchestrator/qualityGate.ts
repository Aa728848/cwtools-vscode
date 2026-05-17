/**
 * Eddy CWTool Code — 质量门
 *
 * Builder Agent 完成后自动触发 Reviewer Agent 进行审查。
 * 支持多轮修复循环（最多 3 轮），确保代码质量。
 */

import type { SubAgentResult, TaskNode } from './types';
import type { AgentStep } from '../types';

import type { QualityGateResult } from './types';

/** 质量门配置 */
export interface QualityGateConfig {
    /** 最大修复循环次数 */
    maxFixCycles: number;
    /** 是否启用自动修复（false = 仅报告） */
    autoFix: boolean;
}

/** 默认配置 */
const DEFAULT_CONFIG: QualityGateConfig = {
    maxFixCycles: 3,
    autoFix: true,
};

export const SPRITE_REPAIR_PROTOCOL = [
    '## Sprite Resource Diagnostic Protocol',
    '',
    'When any diagnostic says `Expected value of type sprite` or a field such as `picture`, `icon`, or `spriteType` references a missing/invalid `GFX_*` value:',
    '1. Treat it as an asset reference error, not as a generic syntax error.',
    '2. The value for a sprite-typed field must be an existing sprite name (usually `GFX_*`), never a raw `.dds` file path.',
    '3. Before proposing or applying a replacement, call `find_sprite_candidates` with the invalid value, the field name, and `searchContext="both"` so both project and vanilla `.gfx` sprite definitions are available.',
    '4. Prefer a project sprite candidate first, then a semantically close vanilla candidate. For event `picture = ...`, prefer event-picture sprites such as `GFX_evt_*` or candidates whose texture path indicates event/anomaly/archaeology art; avoid UI icon textures unless the field is actually an icon field.',
    '5. If no candidate is returned, retry with broader keywords from the surrounding content (for example anomaly, archaeology, situation, relic, event) before declaring it blocked.',
    '6. Fix only the offending line with guarded `replace_lines` when line numbers are known, then run `get_diagnostics` on the file again.',
].join('\n');

export const SOUND_REPAIR_PROTOCOL = [
    '## Sound Asset Diagnostic Protocol',
    '',
    'When any diagnostic or field involves `show_sound = ...`, `sound = ...`, missing sound references, or an expected sound/music asset:',
    '1. Treat it as an asset lookup, not as a generic syntax error.',
    '2. The value should be an existing sound/music asset name from `.asset` definitions, not a raw `.wav`/`.ogg` path unless the local rule explicitly expects a file path.',
    '3. Before proposing or applying a replacement, call `find_sound_candidates` with the invalid value, the field name, and `searchContext="both"` so both project and vanilla `.asset` definitions are available.',
    '4. Prefer a project asset candidate first, then a semantically close vanilla candidate. For `show_sound`, prefer event/UI sound effects over music tracks unless the surrounding code clearly expects music.',
    '5. If no candidate is returned, retry with broader keywords from the surrounding content before declaring it blocked.',
    '6. Fix only the offending line with guarded `replace_lines` when line numbers are known, then run `get_diagnostics` on the file again.',
].join('\n');

/**
 * 质量门。
 *
 * 工作流程：
 * 1. Builder Agent 完成代码生成
 * 2. QualityGate 自动生成审查 prompt（基于 Builder 写入的文件列表）
 * 3. 调用 Reviewer Agent 审查
 * 4. 如果发现问题且 autoFix = true：
 *    - 生成修复 prompt 并调用 Builder Agent 修复
 *    - 重新审查（最多 maxFixCycles 轮）
 * 5. 输出最终审查报告
 */
export class QualityGate {
    private config: QualityGateConfig;

    constructor(config?: Partial<QualityGateConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 生成综合审查 prompt。
     * 基于所有写入的文件列表构建针对性的审查指令。
     */
    buildCombinedReviewPrompt(writtenFiles: string[], preFetchedDiagnostics?: string): string {
        const fileList = writtenFiles.length > 0
            ? writtenFiles.map(f => `- ${f}`).join('\n')
            : '(No file write records)';

        // W3 修复：预取诊断存在时，明确禁止 Reviewer 重复调用 get_diagnostics
        const diagnosticsSection = preFetchedDiagnostics 
            ? `\n## Pre-fetched LSP Diagnostics (ALREADY RETRIEVED — DO NOT call get_diagnostics again):\n${preFetchedDiagnostics}\n` 
            : '';

        const step1 = preFetchedDiagnostics
            ? '1. Review the pre-fetched diagnostics above.'
            : '1. Diagnostics were not pre-fetched. You may call `get_diagnostics` if needed.';

        const hasSpriteDiagnostics = /Expected value of type sprite|type sprite|spriteType|picture|GFX_/i.test(preFetchedDiagnostics ?? '');
        const hasSoundDiagnostics = /show_sound|Expected value of type sound|type sound|sound\s*=|music|\.asset/i.test(preFetchedDiagnostics ?? '');
        const spriteSection = hasSpriteDiagnostics ? `\n${SPRITE_REPAIR_PROTOCOL}\n` : '';
        const soundSection = hasSoundDiagnostics ? `\n${SOUND_REPAIR_PROTOCOL}\n` : '';

        return [
            '## Quality Gate Review Task',
            '',
            'Please review the code quality of the following files:',
            fileList,
            diagnosticsSection,
            spriteSection,
            soundSection,
            'Review Checklist:',
            step1,
            '2. Check for logic conflict issues (e.g., an event has `option` but uses `hide_window = yes`, which is a contradiction). Such conflicts MUST be reported and fixed.',
            '3. Check cross-file reference consistency (Event IDs, Modifier names, Localization keys, and sprite/asset references).',
            '4. Verify the correctness of the scope chain.',
            '5. Check file structure integrity (Refer to Rule 3b).',
            '',
            'Output Format (You MUST output EXACTLY this JSON format in a markdown code block):',
            '```json',
            '{',
            '  "logicIssuesCount": <number>,',
            '  "logicIssues": ["<issue 1>", "<issue 2>"],',
            '  "fixSuggestions": ["<suggestion 1>", "<suggestion 2>"]',
            '}',
            '```',
            'IMPORTANT: Do not output PASSED or FAILED. The system will automatically fail the quality gate if any LSP errors exist. You only need to report semantic or logic issues.',
        ].join('\n');
    }

    /**
     * 执行审查。
     * 拉起 Reviewer Agent 并分析结果。
     */
    async reviewOutput(
        agentRunner: import('../agentRunner').AgentRunner,
        writtenFiles: string[],
        options: Partial<import('../agentRunner').AgentRunnerOptions>,
    ): Promise<QualityGateResult> {
        if (writtenFiles.length === 0) {
            return {
                passed: true,
                diagnosticErrors: 0,
                logicIssues: 0,
                filesChecked: [],
                reviewReport: '无文件修改',
            };
        }

        let preFetchedDiagnostics = '';
        let diagnosticErrorCount = 0;
        try {
            const diagResults: string[] = [];
            for (const file of writtenFiles) {
                if (!file.endsWith('.txt') && !file.endsWith('.gui')) continue;
                const res = await agentRunner.toolExecutor.execute('get_diagnostics', { file, severity: 'error' });
                if (res && typeof res === 'object') {
                    const count = (res as any).totalDiagnosticCount || 0;
                    if (count > 0) {
                        diagnosticErrorCount += count;
                        diagResults.push(`File: ${file}\n${JSON.stringify((res as any).diagnostics, null, 2)}`);
                    }
                }
            }
            if (diagResults.length > 0) {
                preFetchedDiagnostics = diagResults.join('\n\n');
            }
        } catch (e) {
            // ignore
        }

        const prompt = this.buildCombinedReviewPrompt(writtenFiles, preFetchedDiagnostics);
        
        // 执行 Reviewer Agent
        const reviewResult = await agentRunner.run(
            prompt,
            {}, // context
            [], // conversationHistory
            {
                ...options,
                mode: 'review', // 强制使用审查模式
            }
        );

        const parsed = this.parseReviewResult(reviewResult.explanation);
        const totalLogicIssues = parsed.logicIssuesCount || 0;
        
        const passed = diagnosticErrorCount === 0 && totalLogicIssues === 0;

        return {
            passed,
            diagnosticErrors: diagnosticErrorCount,
            logicIssues: totalLogicIssues,
            filesChecked: writtenFiles,
            reviewReport: reviewResult.explanation,
            fixSuggestions: parsed.fixSuggestions,
        };
    }

    // W11 修复：删除与 buildCombinedReviewPrompt 功能完全重复的旧接口。
    // 旧方法仅因参数类型不同（SubAgentResult vs string[]）而存在，
    // 现在统一使用 buildCombinedReviewPrompt(writtenFiles: string[])。
    /** @deprecated 使用 buildCombinedReviewPrompt 代替 */
    buildReviewPrompt(builderResult: SubAgentResult, preFetchedDiagnostics?: string): string {
        return this.buildCombinedReviewPrompt(builderResult.writtenFiles, preFetchedDiagnostics);
    }

    /**
     * 生成修复 prompt。
     * 基于 Reviewer 的审查报告，构建修复指令。
     */
    buildFixPrompt(reviewReport: string, writtenFiles: string[]): string {
        const hasSpriteIssues = /Expected value of type sprite|type sprite|spriteType|picture|GFX_/i.test(reviewReport);
        const hasSoundIssues = /show_sound|Expected value of type sound|type sound|sound\s*=|music|\.asset/i.test(reviewReport);
        return [
            '## Quality Gate Fix Task',
            '',
            'The Review Agent has found the following issues, please fix them:',
            '',
            reviewReport,
            '',
            ...(hasSpriteIssues ? [SPRITE_REPAIR_PROTOCOL, ''] : []),
            ...(hasSoundIssues ? [SOUND_REPAIR_PROTOCOL, ''] : []),
            'Related Files:',
            ...writtenFiles.map(f => `- ${f}`),
            '',
            'Fix Requirements:',
            '1. Only fix the specific issues listed in the review report. You MUST fix ALL LSP red errors and logic conflicts (e.g., `hide_window = yes` used with `option`).',
            '2. Do not delete or simplify existing logic (Follow Rule 3b).',
            '3. For sprite-type diagnostics, replace invalid values only with candidates returned by `find_sprite_candidates` or another verified `.gfx` definition; never invent a `GFX_*` name.',
            '4. For sound diagnostics, replace invalid values only with candidates returned by `find_sound_candidates` or another verified `.asset` definition; never invent a sound asset name.',
            '5. After fixing, call `get_diagnostics` for each modified file to verify that the errors are resolved.',
        ].join('\n');
    }

    /**
     * 解析审查报告，判断是否通过。
     */
    parseReviewResult(reviewOutput: string): { logicIssuesCount: number; fixSuggestions: string[] } {
        try {
            // Try extracting JSON block
            const jsonMatch = reviewOutput.match(/```json\s*(\{[\s\S]*?\})\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                const parsed = JSON.parse(jsonMatch[1]);
                return {
                    logicIssuesCount: parsed.logicIssuesCount || 0,
                    fixSuggestions: Array.isArray(parsed.fixSuggestions) ? parsed.fixSuggestions : []
                };
            }
            // Fallback for non-JSON formatted but contains logic issues count
            const match = reviewOutput.match(/(\d+)\s*(?:个|issues?|problems?|errors?)/i);
            const logicIssuesCount = match ? parseInt(match[1]!, 10) : 0;
            return { logicIssuesCount, fixSuggestions: [] };
        } catch (e) {
            return { logicIssuesCount: 0, fixSuggestions: [] };
        }
    }

    /** 获取配置 */
    getConfig(): QualityGateConfig {
        return { ...this.config };
    }
}
