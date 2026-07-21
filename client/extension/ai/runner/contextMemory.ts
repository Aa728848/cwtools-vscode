import * as path from 'path';
import * as fs from 'fs';
import { ChatMessage, contentToString } from '../types';
import { AIService } from '../aiService';
import { getProjectWorkspaceRoot, getPrivateTopicStorageDir } from '../workspacePaths';
import { ErrorReporter } from '../errorReporter';
import { SOURCE, aiText } from '../messages';
import { getHistoryPolicy } from './historyPolicy';

/**
 * 结构化历史状态记忆概况接口 (Phase 4 核心契约)
 */
export interface CompactedSummary {
    goal: string;
    constraints: string[];
    done: string[];
    inProgress: string[];
    blocked: string[];
    decisions: string[];
    nextSteps: string[];
    criticalContext: string[];
    relevantFiles: Array<{ path: string; reason: string }>;
    artifactRefs: string[];
    lastStableRunEventId: string;
}

/**
 * 确保目标目录存在
 */
function ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * 获取运行记录目录
 */
export function getRunStorageDir(topicId: string, runId: string): string {
    const wsRoot = getProjectWorkspaceRoot();
    const storageDir = path.join(getPrivateTopicStorageDir(topicId, wsRoot), 'runs', runId);
    ensureDir(storageDir);
    return storageDir;
}

/**
 * 对复杂的对话历史与事务记录进行多维度分析，由 LLM 进行自适应概括与状态提炼
 *
 * 注意：自「统一摘要与 compaction」改造（docs/ai-agent-reliability-efficiency-plan.md §5.1）起，
 * AgentRunner.run() 已不再在每个 turn 自动调用本函数——摘要统一由 runner/compaction.ts 的
 * maybeCompactHistory 负责。本模块暂时保留供显式/诊断用途；其写出的 summary.json/summary.md
 * 仍可能被 promptBuilder、chat/bridge 与 checkpoint 读取（缺文件时读取方均安全回退）。
 */
export async function compactHistory(
    topicId: string,
    runId: string,
    messages: ChatMessage[],
    ledgerEvents: any[],
    aiService: AIService,
    abortSignal?: AbortSignal
): Promise<CompactedSummary> {
    ErrorReporter.debug(SOURCE.AGENT_RUNNER, aiText(
        `Starting history compaction (Phase 4 Compact History): runId=${runId}`,
        `开始执行历史状态压缩 (Phase 4 Compact History): runId=${runId}`,
    ));
    
    // 1. 整理 ledger 极简事件流水以作为 LLM 概括依据，控制 input 体积
    const eventSummaries = ledgerEvents.map(e => {
        const timeStr = new Date(e.timestamp || Date.now()).toLocaleTimeString();
        return `[${timeStr}] ${aiText('event', '事件')}: ${e.type || 'unknown'}, ${aiText('status', '状态')}: ${e.payload?.status || 'no_status'}${e.payload?.tool ? `, ${aiText('tool', '工具')}: ${e.payload.tool}` : ''}${e.payload?.error ? `, ${aiText('error', '异常')}: ${e.payload.error}` : ''}`;
    }).slice(-15); // 仅抓取最近 15 条以防撑爆

    // 2. 整理最近的对话尾部
    const recentChatPreview = messages.map(m => {
        const contentStr = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${m.role.toUpperCase()}: ${contentStr.substring(0, 300)}${contentStr.length > 300 ? '...' : ''}`;
    }).slice(-6).join('\n\n');

    // 3. 构建高纯度压缩 Prompt，强制 LLM 输出极其严格的 JSON 结构
    const systemPrompt = aiText(`You are a rigorous CWTools transaction-memory analyst.
Your only task is to analyze the provided [CWTools conversation history] and [transaction event stream], then extract the core context checkpoints and memory needed for continued system development.
Remove obsolete, duplicated, or non-actionable chatter. Keep only the following eleven contract dimensions.

You must output a **pure JSON object** matching this TypeScript shape. Do not include Markdown fences, prefixes, or suffixes.

TypeScript shape:
\`\`\`ts
interface CompactedSummary {
  goal: string; // highest-level development goal for this conversation
  constraints: string[]; // explicit user constraints or architectural hazards discovered in code
  done: string[]; // completed and verified subtasks/modules
  inProgress: string[]; // work currently underway or still incomplete
  blocked: string[]; // current blockers, compile errors, or clarification needs
  decisions: string[]; // irreversible technical/design decisions made during the task
  nextSteps: string[]; // direct next development steps required to reach the goal
  criticalContext: string[]; // essential technical details from code diagnostics, LSP, or file analysis
  relevantFiles: Array<{ path: string; reason: string }>; // important related files and why they matter
  artifactRefs: string[]; // local paths to large output files or intermediate artifacts
  lastStableRunEventId: string; // last stable ledger event id (use "evt_latest" if needed)
}
\`\`\`

Rules:
1. Avoid parse ambiguity. Every JSON field must be a concrete string or array.
2. Never use placeholders. If nextSteps is empty, infer the next compile/test commands.
3. Output only the JSON string.`, `你是一个极其严谨的 CWTools 事务记忆分析专家。
你的唯一任务是：分析以下给出的 [CWTools 会话历史] 和 [事务事件流水]，提取出系统开发所必须保持的“核心上下文断点与记忆”。
请务必剔除已经作废、重复和无实际开发意义的废话，只保留以下十一个维度核心契约。

你必须输出符合以下 TypeScript 格式的 **纯 JSON 对象**，绝对不允许夹带任何 Markdown 的 \`\`\` 标记或前缀后缀！

TypeScript 结构定义如下：
\`\`\`ts
interface CompactedSummary {
  goal: string; // 本次会话解决的最高核心开发目标
  constraints: string[]; // 用户明确提到、或代码中约束的最高设计准则/架构雷区
  done: string[]; // 已经圆满攻克并 100% 验证通过的细分任务/模块
  inProgress: string[]; // 目前正处于实施阶段、有残留任务的进行中工作
  blocked: string[]; // 当前遇到的关键阻塞因素、编译报错或等待用户决策的 Clarification
  decisions: string[]; // 解决该任务过程中做出的不可逆重大技术/设计决策
  nextSteps: string[]; // 接下来为达成目标必须立即执行的直接开发子步骤，极其重要！
  criticalContext: string[]; // 从核心代码诊断、LSP、或文件分析中得出的最核心技术细节（如关键函数、参数定义）
  relevantFiles: Array<{ path: string; reason: string }>; // 关联的重点文件列表及其强相关理由，不能遗漏！
  artifactRefs: string[]; // 产生的大型输出文件、中间快照的本地磁盘路径引用
  lastStableRunEventId: string; // 最后一笔正常执行完的 Ledger Event ID (可使用 "evt_latest" 或实际最新的 Event ID)
}
\`\`\`

注意：
1. 绝对不要产生任何解析死角，JSON 中的每一项都必须是明确的字符串或数组。
2. 绝对不能使用 placeholder，如果 nextSteps 为空，请预测下一步需要执行的代码编译和测试指令。
3. 请仅输出 JSON 字符串！`);

    const userPrompt = aiText(`=== Recent Transaction Event Stream ===
${eventSummaries.join('\n')}

=== Recent Chat Context Tail ===
${recentChatPreview}

Summarize immediately and output a pure JSON string.`, `=== 近期事务事件流水 ===
${eventSummaries.join('\n')}

=== 近期聊天上下文尾部 ===
${recentChatPreview}

请立刻归纳提炼，输出纯 JSON 字符串！`);

    const summaryMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ];

    try {
        const response = await aiService.chatCompletion(summaryMessages, {
            temperature: 0.1,
            maxTokens: 2500,
            abortSignal,
            disableThinking: true // 压缩是不需要深度思考的普通状态归纳，极大提升效率
        });

        const rawText = contentToString(response.choices[0]?.message?.content).trim();
        let parsed: CompactedSummary | null = null;
        
        try {
            parsed = parseAndCleanJson(rawText);
        } catch {
            ErrorReporter.warn(SOURCE.AGENT_RUNNER, aiText(
                'Compaction returned malformed JSON; attempting self-repair...',
                '压缩生成的 JSON 存在语法残缺，尝试自愈解析中...',
            ));
            parsed = attemptJsonSelfRepair(rawText);
        }

        if (!parsed) {
            throw new Error(aiText(
                'Could not recover a valid CompactedSummary from the LLM response.',
                '无法从 LLM 返回内容中自愈提炼出有效的 CompactedSummary！',
            ));
        }

        // 规范化字段补齐，杜绝 null 导致的 TS 越界
        const finalSummary: CompactedSummary = {
            goal: parsed.goal || aiText('Complete the current development task', '完成当前开发任务'),
            constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
            done: Array.isArray(parsed.done) ? parsed.done : [],
            inProgress: Array.isArray(parsed.inProgress) ? parsed.inProgress : [],
            blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
            decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
            nextSteps: Array.isArray(parsed.nextSteps) && parsed.nextSteps.length > 0 ? parsed.nextSteps : ['npm run compile', 'npm run test:unit'],
            criticalContext: Array.isArray(parsed.criticalContext) ? parsed.criticalContext : [],
            relevantFiles: Array.isArray(parsed.relevantFiles) ? parsed.relevantFiles : [],
            artifactRefs: Array.isArray(parsed.artifactRefs) ? parsed.artifactRefs : [],
            lastStableRunEventId: parsed.lastStableRunEventId || 'evt_latest'
        };

        // 4. 将概况同步写入本地 runs 存储目录，保存为 summary.json 与 summary.md
        if (getHistoryPolicy().persistence === 'off') return finalSummary;
        const storageDir = getRunStorageDir(topicId, runId);
        const jsonPath = path.join(storageDir, 'summary.json');
        const mdPath = path.join(storageDir, 'summary.md');

        fs.writeFileSync(jsonPath, JSON.stringify(finalSummary, null, 2), 'utf-8');
        
        // 渲染极其精美的 markdown 概况供前台直接阅读和 Inspector 时间线加载
        const mdContent = aiText(`# CWTools AI Agent Compacted Memory

> **Current run**: [${runId}] | **Generated at**: ${new Date().toLocaleString()}

---

## Goal
${finalSummary.goal}

## Constraints
${finalSummary.constraints.map(c => `- ${c}`).join('\n') || '*No special constraints recorded*'}

## Next Steps
${finalSummary.nextSteps.map(n => `- \`${n}\``).join('\n')}

---

## Relevant Files
${finalSummary.relevantFiles.map(f => `- **${path.basename(f.path)}** (reason: ${f.reason})  
  Path: [${f.path}](file:///${f.path.replace(/\\/g, '/')})`).join('\n') || '*No relevant files recorded*'}

## Work State
- **Done**:
${finalSummary.done.map(d => `  - [x] ${d}`).join('\n') || '  *No completed work recorded*'}
- **In Progress**:
${finalSummary.inProgress.map(i => `  - [ ] ${i}`).join('\n') || '  *No in-progress work recorded*'}
- **Blocked**:
${finalSummary.blocked.map(b => `  - [!] ${b}`).join('\n') || '  *No blockers recorded*'}

---

## Decisions
${finalSummary.decisions.map(d => `- ${d}`).join('\n') || '*No major decisions recorded*'}

## Critical Context
${finalSummary.criticalContext.map(cx => `- ${cx}`).join('\n') || '*No critical context recorded*'}

---
*Ledger stable point: \`${finalSummary.lastStableRunEventId}\`*
`, `# 🧠 CWTools AI Agent 历史状态记忆与压缩看板 (Compacted Memory)

> **当前运行**: [${runId}] | **分析时刻**: ${new Date().toLocaleString()}

---

## 🎯 最高核心目标 (Goal)
${finalSummary.goal}

## 🛡️ 系统设计准则与约束 (Constraints)
${finalSummary.constraints.map(c => `- ${c}`).join('\n') || '*无特别约束*'}

## 📅 下一步必须执行的子步骤 (Next Steps)
${finalSummary.nextSteps.map(n => `- \`${n}\``).join('\n')}

---

## 📂 核心关联文件 (Relevant Files)
${finalSummary.relevantFiles.map(f => `- **${path.basename(f.path)}** (理由: ${f.reason})  
  路径: [${f.path}](file:///${f.path.replace(/\\/g, '/')})`).join('\n') || '*无关联文件记录*'}

## 🔬 进行中与已完成任务状态
- **已圆满攻克 (Done)**:
${finalSummary.done.map(d => `  - [x] ${d}`).join('\n') || '  *无已完成记录*'}
- **进行中状态 (In Progress)**:
${finalSummary.inProgress.map(i => `  - [ ] ${i}`).join('\n') || '  *无进行中记录*'}
- **阻塞因素/技术债务 (Blocked)**:
${finalSummary.blocked.map(b => `  - [!] ${b}`).join('\n') || '  *无阻塞记录*'}

---

## 💡 不可逆重大技术决策 (Decisions)
${finalSummary.decisions.map(d => `- ${d}`).join('\n') || '*暂未发生重大变更决策*'}

## 🛠️ 核心代码诊断与上下文细节 (Critical Context)
${finalSummary.criticalContext.map(cx => `- ${cx}`).join('\n') || '*无核心细节记录*'}

---
*Ledger 稳定点指向: \`${finalSummary.lastStableRunEventId}\`*
`);
        fs.writeFileSync(mdPath, mdContent, 'utf-8');
        ErrorReporter.debug(SOURCE.AGENT_RUNNER, aiText(
            `Compacted history persisted: ${jsonPath}`,
            `历史状态压缩已持久化: ${jsonPath}`,
        ));
        
        return finalSummary;
    } catch (err: any) {
        ErrorReporter.warn(SOURCE.AGENT_RUNNER, aiText(
            `History compaction failed; falling back to a minimal state: ${err.message}`,
            `历史压缩执行失败，退回到兜底状态: ${err.message}`,
        ));
        // 返回最低限度兜底以防止死锁
        return {
            goal: aiText('Continue the development task', '持续推进任务开发'),
            constraints: [],
            done: [],
            inProgress: [],
            blocked: [],
            decisions: [],
            nextSteps: ['npm run compile', 'npm run test:unit'],
            criticalContext: [],
            relevantFiles: [],
            artifactRefs: [],
            lastStableRunEventId: 'evt_latest'
        };
    }
}

/**
 * 清洗 Markdown 并解析纯 JSON
 */
function parseAndCleanJson(text: string): any {
    let cleanText = text.trim();
    // 剔除 ```json ... ``` 包裹
    const jsonMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (jsonMatch) {
        cleanText = jsonMatch[1]!.trim();
    }
    return JSON.parse(cleanText);
}

/**
 * 针对 JSON 残缺大段截断的极其健壮的手动正则模糊提炼与自愈
 */
function attemptJsonSelfRepair(text: string): any {
    const result: any = {
        goal: '',
        constraints: [],
        done: [],
        inProgress: [],
        blocked: [],
        decisions: [],
        nextSteps: [],
        criticalContext: [],
        relevantFiles: [],
        artifactRefs: [],
        lastStableRunEventId: 'evt_latest'
    };

    try {
        // 尝试抓取 goal 字段
        const goalMatch = text.match(/"goal"\s*:\s*"([^"]+)"/);
        if (goalMatch) result.goal = goalMatch[1];

        // 尝试抓取各数组字段
        const extractStringArray = (fieldName: string): string[] => {
            const regex = new RegExp(`"${fieldName}"\\s*:\\s*\\[([\\s\\S]*?)\\]`);
            const arrayMatch = text.match(regex);
            if (arrayMatch && arrayMatch[1]) {
                const words = arrayMatch[1].match(/"([^"]+)"/g);
                if (words) {
                    return words.map(w => w.replace(/^"|"$/g, ''));
                }
            }
            return [];
        };

        result.constraints = extractStringArray('constraints');
        result.done = extractStringArray('done');
        result.inProgress = extractStringArray('inProgress');
        result.blocked = extractStringArray('blocked');
        result.decisions = extractStringArray('decisions');
        result.nextSteps = extractStringArray('nextSteps');
        result.criticalContext = extractStringArray('criticalContext');
        result.artifactRefs = extractStringArray('artifactRefs');

        // 尝试匹配 relevantFiles
        const filesRegex = /"relevantFiles"\s*:\s*\[([\s\\S]*?)\]/;
        const filesMatch = text.match(filesRegex);
        if (filesMatch && filesMatch[1]) {
            const block = filesMatch[1];
            const fileBlocks = block.match(/\{\s*([\s\S]*?)\s*\}/g);
            if (fileBlocks) {
                for (const fb of fileBlocks) {
                    const pathMatch = fb.match(/"path"\s*:\s*"([^"]+)"/);
                    const reasonMatch = fb.match(/"reason"\s*:\s*"([^"]+)"/);
                    if (pathMatch) {
                        result.relevantFiles.push({
                            path: pathMatch[1],
                            reason: reasonMatch ? reasonMatch[1] : aiText('Core related file', '核心关联文件')
                        });
                    }
                }
            }
        }
    } catch {
        // Repair failure returns skeleton
    }

    return result;
}
