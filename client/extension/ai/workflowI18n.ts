import type { AiWorkflow } from './workflowRegistry';

export type WorkflowLocale = 'en' | 'zh-cn';

export interface WorkflowUiLabels {
    selectorPlaceholder: string;
    noWorkflowSelected: string;
    phaseUnit: string;
    phasesUnit: string;
    requiredCheckUnit: string;
    requiredChecksUnit: string;
}

interface LocalizedPhaseText {
    title: string;
    description: string;
}

interface LocalizedWorkflowText {
    title: string;
    description: string;
    phases: Record<string, LocalizedPhaseText>;
    verification: Record<string, string>;
}

const WORKFLOW_TEXT: Record<string, Record<WorkflowLocale, LocalizedWorkflowText>> = {
    'diagnostic-fix': {
        en: {
            title: 'Diagnostic Fix',
            description: 'Automatically fix CWTools LSP diagnostics in the current file or workspace.',
            phases: {
                collect: {
                    title: 'Collect Diagnostics',
                    description: 'Retrieve and classify all diagnostics from the target file(s).',
                },
                analyze: {
                    title: 'Analyze Errors',
                    description: 'Classify each diagnostic (code logic, forward ref, vanilla warning, asset ref).',
                },
                fix: {
                    title: 'Apply Fixes',
                    description: 'Fix each real error using the Error Fix Protocol.',
                },
                verify: {
                    title: 'Verify',
                    description: 'Re-run diagnostics to ensure zero real errors remain.',
                },
            },
            verification: {
                'zero-errors': 'get_diagnostics returns zero real (non-cache) errors.',
            },
        },
        'zh-cn': {
            title: '诊断修复',
            description: '自动修复当前文件或工作区中的 CWTools LSP 诊断问题。',
            phases: {
                collect: {
                    title: '收集诊断',
                    description: '获取并归类目标文件中的所有诊断问题。',
                },
                analyze: {
                    title: '分析错误',
                    description: '区分代码逻辑、前向引用、原版缓存警告和资产引用等问题。',
                },
                fix: {
                    title: '应用修复',
                    description: '按错误修复协议逐个修复真实错误。',
                },
                verify: {
                    title: '验证结果',
                    description: '重新运行诊断，确认没有真实错误残留。',
                },
            },
            verification: {
                'zero-errors': 'get_diagnostics 返回 0 个真实错误（不含缓存类问题）。',
            },
        },
    },
    'loc-generation': {
        en: {
            title: 'Localisation Generation',
            description: 'Generate missing localisation entries for new or existing game entities.',
            phases: {
                scan: {
                    title: 'Scan for Missing Keys',
                    description: 'Identify entities with missing localisation keys.',
                },
                generate: {
                    title: 'Generate Entries',
                    description: 'Create localisation entries using write_localisation.',
                },
                verify: {
                    title: 'Verify',
                    description: 'Confirm all generated keys resolve correctly.',
                },
            },
            verification: {
                'keys-present': 'All generated localisation keys are searchable via grep.',
            },
        },
        'zh-cn': {
            title: '本地化生成',
            description: '为新的或已有的游戏实体生成缺失的本地化条目。',
            phases: {
                scan: {
                    title: '扫描缺失键',
                    description: '识别缺少本地化 key 的实体。',
                },
                generate: {
                    title: '生成条目',
                    description: '使用 write_localisation 创建本地化条目。',
                },
                verify: {
                    title: '验证结果',
                    description: '确认生成的所有 key 都能正确解析。',
                },
            },
            verification: {
                'keys-present': '所有生成的本地化 key 都能通过 grep 查询到。',
            },
        },
    },
    'event-chain-design': {
        en: {
            title: 'Event Chain Design',
            description: 'Design and plan a new event chain with common/ subsystem review, scope chains, rewards, and dependencies.',
            phases: {
                archetype: {
                    title: 'Archetype Study',
                    description: 'Find and study a vanilla event chain of similar complexity.',
                },
                'common-review': {
                    title: 'Common Capability Review',
                    description: 'Inventory common/ directories and choose engine subsystems for progression, agency, rewards, and cleanup.',
                },
                topology: {
                    title: 'Pipeline Topology',
                    description: 'Map the entry point, intermediate nodes, and outcomes.',
                },
                rewards: {
                    title: 'Reward Implementation',
                    description: 'Map outcomes to concrete entity families discovered from the active TypeDefs and project knowledge graph.',
                },
                blueprint: {
                    title: 'Blueprint',
                    description: 'Write the design blueprint with common review, subsystem plan, scope chains, rewards, and cleanup.',
                },
            },
            verification: {
                'common-review-written': 'The blueprint records common/ directories considered, selected, and rejected with rationale.',
                'reward-plan-written': 'The blueprint maps rewards and outcomes to concrete common entity families.',
                'blueprint-written': 'A design_blueprint.md has been created in the topic directory.',
            },
        },
        'zh-cn': {
            title: '事件链设计',
            description: '设计并规划新的事件链，包括作用域链和依赖关系。',
            phases: {
                archetype: {
                    title: '原型研究',
                    description: '寻找并研究复杂度相近的原版事件链。',
                },
                topology: {
                    title: '流程拓扑',
                    description: '梳理入口、中间节点和结局分支。',
                },
                blueprint: {
                    title: '设计蓝图',
                    description: '写出包含作用域链和 ID 分配的设计蓝图。',
                },
            },
            verification: {
                'blueprint-written': '主题目录中已创建 design_blueprint.md。',
            },
        },
    },
    'rules-sync-review': {
        en: {
            title: 'Rules Sync Review',
            description: 'Review the project after a CWTools rules update to identify new or changed diagnostics.',
            phases: {
                triage: {
                    title: 'Triage',
                    description: 'Collect all diagnostics and categorize by type and severity.',
                },
                'deep-dive': {
                    title: 'Deep Dive',
                    description: 'Inspect representative errors from the top 3 categories.',
                },
                report: {
                    title: 'Report',
                    description: 'Generate an actionable summary with priority-ranked recommendations.',
                },
            },
            verification: {},
        },
        'zh-cn': {
            title: '规则同步审查',
            description: '在 CWTools 规则更新后审查项目，识别新增或变化的诊断问题。',
            phases: {
                triage: {
                    title: '问题分流',
                    description: '收集所有诊断，并按类型和严重程度归类。',
                },
                'deep-dive': {
                    title: '深入检查',
                    description: '检查前三类问题中的代表性错误。',
                },
                report: {
                    title: '生成报告',
                    description: '输出按优先级排序、可执行的建议摘要。',
                },
            },
            verification: {},
        },
    },
    'asset-wiring': {
        en: {
            title: 'Asset Wiring',
            description: 'Find and wire sprite/sound assets to entities with missing or invalid references.',
            phases: {
                scan: {
                    title: 'Scan Missing Assets',
                    description: 'Collect all sprite/sound diagnostic errors.',
                },
                resolve: {
                    title: 'Resolve Candidates',
                    description: 'Find matching vanilla or project assets for each missing reference.',
                },
                apply: {
                    title: 'Apply Wiring',
                    description: 'Replace invalid asset references with verified candidates.',
                },
                verify: {
                    title: 'Verify',
                    description: 'Re-run diagnostics to confirm all asset references resolve.',
                },
            },
            verification: {
                'no-asset-errors': 'No sprite or sound reference diagnostics remain.',
            },
        },
        'zh-cn': {
            title: '资产接线',
            description: '为缺失或无效引用的实体查找并接入 sprite/sound 资产。',
            phases: {
                scan: {
                    title: '扫描缺失资产',
                    description: '收集所有 sprite/sound 相关诊断错误。',
                },
                resolve: {
                    title: '匹配候选',
                    description: '为每个缺失引用查找可用的原版或项目资产。',
                },
                apply: {
                    title: '应用接线',
                    description: '用已验证的候选资产替换无效引用。',
                },
                verify: {
                    title: '验证结果',
                    description: '重新运行诊断，确认所有资产引用都能解析。',
                },
            },
            verification: {
                'no-asset-errors': '不再存在 sprite 或 sound 引用诊断问题。',
            },
        },
    },
};

const UI_LABELS: Record<WorkflowLocale, WorkflowUiLabels> = {
    en: {
        selectorPlaceholder: 'Workflow',
        noWorkflowSelected: 'No workflow selected',
        phaseUnit: 'phase',
        phasesUnit: 'phases',
        requiredCheckUnit: 'required check',
        requiredChecksUnit: 'required checks',
    },
    'zh-cn': {
        selectorPlaceholder: '工作流',
        noWorkflowSelected: '未选择工作流',
        phaseUnit: '阶段',
        phasesUnit: '阶段',
        requiredCheckUnit: '必需检查',
        requiredChecksUnit: '必需检查',
    },
};

export function normalizeWorkflowLocale(locale?: string | null): WorkflowLocale {
    const normalized = (locale || '').toLowerCase();
    return normalized.startsWith('zh') ? 'zh-cn' : 'en';
}

export function getWorkflowUiLabels(locale?: string | null): WorkflowUiLabels {
    return UI_LABELS[normalizeWorkflowLocale(locale)];
}

export function localizeWorkflow(workflow: AiWorkflow, locale?: string | null): AiWorkflow {
    const normalizedLocale = normalizeWorkflowLocale(locale);
    const text = WORKFLOW_TEXT[workflow.id]?.[normalizedLocale] ?? WORKFLOW_TEXT[workflow.id]?.en;
    if (!text) return workflow;

    return {
        ...workflow,
        title: text.title,
        description: text.description,
        phases: workflow.phases.map(phase => {
            const translated = text.phases[phase.id];
            return translated
                ? { ...phase, title: translated.title, description: translated.description }
                : phase;
        }),
        verification: workflow.verification.map(step => ({
            ...step,
            description: text.verification[step.id] ?? step.description,
        })),
    };
}
