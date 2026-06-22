export type ChatLocale = 'en' | 'zh-cn';

export interface ChatModeMeta {
    label: string | null;
    bodyClass: string;
}

export interface ChatI18nText {
    locale: ChatLocale;
    promptExamples: string[];
    modeLabels: Record<string, ChatModeMeta>;
    slashDescriptions: Record<string, string>;
    artifact: {
        emptyTitle: string;
        emptySubtitle: string;
        emptyFilterTitle: string;
        emptyFilterSubtitle: string;
        status: Record<string, string>;
    };
    buttons: {
        cancelGeneration: string;
        send: string;
    };
    markdown: {
        waitingForChoice: string;
    };
    settings: {
        unselectedProvider: string;
        unsetModel: string;
        defaultEndpoint: string;
        automatic: string;
        localModel: string;
        apiKeyConfigured: string;
        apiKeyMissing: string;
        inlinePrefix: string;
        inlineSameProvider: string;
        inlineOff: string;
        writeAuto: string;
        writeConfirm: string;
        writeAutoReview: string;
        writeFull: string;
        contextPrefix: string;
        mcpUnit: string;
        providerChip: string;
        writeChip: string;
        reasoningChip: string;
    };
    live: {
        waitingForOutput: string;
        thoughts: string;
        tools: string;
        text: string;
        subtask: string;
        starting: string;
        back: string;
        subagent: string;
        realtimeProcess: string;
        reads: string;
        writes: string;
        thinkingDetails: string;
        compactingContext: string;
        compactingContextDetail: string;
        contextCompacted: string;
        contextCompactionFailed: string;
    };
    annotations: {
        plan: AnnotationI18nText;
        orchestratorPlan: AnnotationI18nText;
        walkthrough: AnnotationI18nText;
        blueprint: AnnotationI18nText;
    };
    runs: {
        groups: {
            model: string;
            tools: string;
            files: string;
            permissions: string;
            validation: string;
            context: string;
            subagents: string;
            other: string;
        };
        inspector: {
            noEvent: string;
            args: string;
            argRepairs: string;
            targetPaths: string;
            toolResult: string;
            fullResult: string;
            openFullContent: string;
            error: string;
            preview: string;
            truncated: string;
            fileChange: string;
            path: string;
            diff: string;
            subagentResult: string;
            task: string;
            changeset: string;
            steps: string;
            tokens: string;
            compactionDone: string;
            goal: string;
            nextSteps: string;
            selectEventHint: string;
            contextUsage: string;
            agentLabel: string;
        };
    };
    manager: {
        tabs: { agents: string; runs: string; artifacts: string; tasks: string };
        overview: {
            topics: string; artifacts: string; steps: string; messages: string;
            run: string; mode: string; workflow: string; status: string;
            none: string; running: string; idle: string;
        };
        runs: {
            noRun: string; runId: string; status: string;
            metrics: { tokens: string; cost: string; tools: string; calls: string };
            openMemory: string; cleanLargeResults: string; modifiedFiles: string;
            subAgentChangeSets: string; compactedMemory: string;
            cleaned: string;
            stepsTitle: string; noSteps: string;
            eventDetail: string; closeInspector: string;
            copyEventJson: string; copiedEvent: string;
            steps: { thought: string; thinking: string; toolCall: string; toolResult: string; execError: string };
        };
        tasks: { noTasks: string };
        agents: {
            noLanes: string; phase: string; done: string; running: string;
            failed: string; task: string; steps: string; tokens: string;
        };
    };
}

export interface AnnotationI18nText {
    title: string;
    hint: string;
    approve: string;
    approved: string;
    submit: string;
    submitted: string;
    addTitle: string;
    placeholder: string;
    confirm: string;
    cancel: string;
    edit: string;
}

const EN: ChatI18nText = {
    locale: 'en',
    promptExamples: [
        'Check LSP errors in the current file and fix them',
        'Add a scripted_trigger that checks planet owner traits',
        'Explain the difference between from, root, and prev scopes',
        'Create an on_action that replenishes escort ships every month',
        'Add a mineral-cost building under common/buildings',
        'Fix the scope error in the current effect block',
        'Analyze the current file and list possible syntax issues',
        'Add validation guards to this scripted_effect',
        'Add immediate variable initialization to the current event',
        'Explain the difference between scripted_trigger and limit',
        'Optimize this loop that checks every planet',
        'Create a modifier formula based on empire technology level',
    ],
    modeLabels: {
        build: { label: null, bodyClass: 'build-mode' },
        plan: { label: 'Plan Mode - read-only planning, no file changes', bodyClass: 'plan-mode' },
        explore: { label: 'Explore Mode - inspect project structure', bodyClass: 'explore-mode' },
        general: { label: 'Utility Mode - scripts, tools, and non-PDXScript tasks', bodyClass: 'utility-mode' },
        utility: { label: 'Utility Mode - scripts, tools, and non-PDXScript tasks', bodyClass: 'utility-mode' },
        review: { label: 'Review Mode - code review', bodyClass: 'review-mode' },
        loc_translator: { label: 'Translation Mode - localisation file translation', bodyClass: 'build-mode' },
        loc_writer: { label: 'Writing Mode - localisation content creation', bodyClass: 'build-mode' },
        orchestrator: { label: 'Multi-Agent Execution - DAG dispatch and parallel collaboration', bodyClass: 'orchestrator-mode' },
        script: { label: 'Script Mode - dynamic PDXScript workflow pipeline', bodyClass: 'script-mode' },
    },
    slashDescriptions: {
        '/init': 'Scan the project and generate Agent profile + CWTOOLS.md',
        '/clear': 'Clear the current conversation and start a new topic',
        '/compact': 'Summarize the active Agent context while keeping the topic transcript',
        '/fork': 'Fork the conversation from the current point',
        '/archive': 'Archive the current topic',
        '/workflow:list': 'List available AI workflows',
        '/workflow:save': 'Save the current process as a reusable AI workflow',
        '/workflow:off': 'Turn off the active AI workflow',
        '/mode:build': 'Switch to Build mode',
        '/mode:plan': 'Switch to Plan mode',
        '/mode:explore': 'Switch to Explore mode',
        '/mode:utility': 'Switch to Utility mode',
        '/mode:review': 'Switch to Review mode',
        '/mode:orchestrator': 'Switch to multi-agent Orchestrator mode',
        '/mode:script': 'Switch to Script Mode',
    },
    artifact: {
        emptyTitle: 'No Artifacts',
        emptySubtitle: 'Plans, blueprints, diagnostics, diffs, and walkthroughs will appear here.',
        emptyFilterTitle: 'No items in this filter',
        emptyFilterSubtitle: 'Switch back to All to view other artifacts.',
        status: {
            pending: 'pending',
            running: 'running',
            done: 'done',
            failed: 'failed',
        },
    },
    buttons: {
        cancelGeneration: 'Cancel generation (Esc)',
        send: 'Send',
    },
    markdown: {
        waitingForChoice: 'Waiting for your choice...',
    },
    settings: {
        unselectedProvider: 'No provider selected',
        unsetModel: 'No model configured',
        defaultEndpoint: 'Default endpoint',
        automatic: 'automatic',
        localModel: 'Local model',
        apiKeyConfigured: 'API key configured',
        apiKeyMissing: 'API key missing',
        inlinePrefix: 'Inline',
        inlineSameProvider: 'same provider',
        inlineOff: 'Inline: off',
        writeAuto: 'Auto write',
        writeConfirm: 'Confirm writes',
        writeAutoReview: 'Auto approve',
        writeFull: 'Full access',
        contextPrefix: 'context',
        mcpUnit: 'MCP',
        providerChip: 'Provider',
        writeChip: 'Write',
        reasoningChip: 'Reasoning',
    },
    live: {
        waitingForOutput: 'Waiting for output',
        thoughts: 'thoughts',
        tools: 'tools',
        text: 'text',
        subtask: 'Subtask',
        starting: 'Starting...',
        back: 'Back',
        subagent: 'Subagent',
        realtimeProcess: 'Live process',
        reads: 'reads',
        writes: 'writes',
        thinkingDetails: 'Thinking details',
        compactingContext: 'Compacting context',
        compactingContextDetail: 'Summarizing older turns while preserving goals, decisions, and recent progress',
        contextCompacted: 'Context compacted',
        contextCompactionFailed: 'Context compaction failed',
    },
    annotations: {
        plan: {
            title: 'Inline annotations',
            hint: 'Click a section to add annotations',
            approve: 'Approve execution',
            approved: 'Started...',
            submit: 'Submit annotations',
            submitted: 'Submitted',
            addTitle: 'Add annotation',
            placeholder: 'Enter annotation...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
        orchestratorPlan: {
            title: 'Multi-agent plan annotations',
            hint: 'Approval starts DAG dispatch and parallel execution',
            approve: 'Start multi-agent',
            approved: 'Multi-agent started...',
            submit: 'Submit annotations',
            submitted: 'Submitted',
            addTitle: 'Add annotation',
            placeholder: 'Enter annotation...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
        walkthrough: {
            title: 'Walkthrough annotations',
            hint: 'Click a section to request changes',
            approve: 'Confirm complete',
            approved: 'Confirmed',
            submit: 'Request revision',
            submitted: 'Submitted',
            addTitle: 'Request changes',
            placeholder: 'Tell the AI what needs to change...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
        blueprint: {
            title: 'Design blueprint annotations',
            hint: 'Click a section to add annotations',
            approve: 'Approve blueprint',
            approved: 'Blueprint approved',
            submit: 'Submit annotations',
            submitted: 'Submitted',
            addTitle: 'Add annotation',
            placeholder: 'Enter annotation...',
            confirm: 'Confirm',
            cancel: 'Cancel',
            edit: 'Edit',
        },
    },
    manager: {
        tabs: { agents: 'Agents', runs: 'Runs', artifacts: 'Artifacts', tasks: 'Tasks' },
        // placeholder — EN manager block already present below
        overview: { topics: 'Topics', artifacts: 'Artifacts', steps: 'Steps', messages: 'Messages', run: 'Run', mode: 'Mode', workflow: 'Workflow', status: 'Status', none: 'none', running: 'running', idle: 'idle' },
        runs: {
            noRun: 'No active run recorded',
            runId: 'Run ID',
            status: 'Status',
            metrics: { tokens: 'Tokens', cost: 'Cost', tools: 'Tools', calls: 'calls' },
            openMemory: 'Open Memory',
            copyEventJson: 'Copy Event JSON',
            copiedEvent: 'Copied Event',
            cleanLargeResults: 'Clean Large Results',
            cleaned: 'Cleaned {deleted} large result file(s), kept {kept}, reclaimed {size}.',
            modifiedFiles: 'Modified Files',
            subAgentChangeSets: 'Sub-Agent Change Sets',
            compactedMemory: 'Compacted Memory',
            stepsTitle: 'Steps',
            noSteps: 'No steps recorded in this run',
            eventDetail: 'Event Detail',
            closeInspector: 'Close',
            steps: { thought: 'Thought / reasoning', thinking: 'Thinking process', toolCall: 'Tool Call', toolResult: 'Tool Result', execError: 'Execution Error' },
        },
        tasks: { noTasks: 'No tasks yet' },
        agents: { noLanes: 'No active orchestrator lanes', phase: 'Phase', done: 'Done', running: 'Running', failed: 'Failed', task: 'Task', steps: 'steps', tokens: 'tokens' },
    },
    runs: {
        groups: {
            model: 'Model Calls',
            tools: 'Tool Invocations',
            files: 'File Changes',
            permissions: 'Permissions',
            validation: 'Validation',
            context: 'Context & Memory',
            subagents: 'Sub-Agents',
            other: 'Other',
        },
        inspector: {
            noEvent: 'No event selected',
            args: 'Arguments',
            argRepairs: 'Argument Repairs',
            targetPaths: 'Target Paths',
            toolResult: 'Tool Result',
            fullResult: 'Full Result',
            openFullContent: '📂 Open full content',
            error: 'Error',
            preview: 'Preview',
            truncated: '... (truncated)',
            fileChange: 'File Change',
            path: 'Path',
            diff: 'Diff',
            subagentResult: 'Sub-Agent Result',
            task: 'Task',
            changeset: 'Files Written',
            steps: 'Steps',
            tokens: 'Tokens',
            compactionDone: '📦 Context Compaction Complete',
            goal: 'Goal',
            nextSteps: 'Next Steps',
            selectEventHint: 'Select an event to view details',
            contextUsage: 'Context usage',
            agentLabel: 'Agent',
        },
    },
};

const ZH_CN: ChatI18nText = {
    locale: 'zh-cn',
    promptExamples: [
        '检查当前文件的 LSP 错误并修复',
        '为 scripted_trigger 添加检查星球所有者特性的条件',
        '解释 from、root、prev 这三个作用域的区别',
        '创建一个每月给舰队补充护卫舰的 on_action',
        '在 common/buildings 中添加一个需要矿物的新建筑',
        '修复当前效果块中的作用域错误',
        '分析当前文件并列出潜在的语法问题',
        '给这个 scripted_effect 添加错误检测逻辑',
        '为当前事件添加 immediate 触发器初始化变量',
        '解释 scripted_trigger 和 limit 的区别',
        '帮我优化这个循环检查所有星球的触发器',
        '创建一个基于帝国科技等级的 modifier 公式',
    ],
    modeLabels: {
        build: { label: null, bodyClass: 'build-mode' },
        plan: { label: '计划模式 - 只读规划，不修改文件', bodyClass: 'plan-mode' },
        explore: { label: '分析模式 - 探索项目结构', bodyClass: 'explore-mode' },
        general: { label: '泛用模式 - 脚本、工具与非 PDXScript 工程任务', bodyClass: 'utility-mode' },
        utility: { label: '泛用模式 - 脚本、工具与非 PDXScript 工程任务', bodyClass: 'utility-mode' },
        review: { label: '审查模式 - 代码审查', bodyClass: 'review-mode' },
        loc_translator: { label: '翻译模式 - 本地化文件翻译', bodyClass: 'build-mode' },
        loc_writer: { label: '写作模式 - 本地化内容创作', bodyClass: 'build-mode' },
        orchestrator: { label: '多 Agent 执行 - DAG 分派与并行协作', bodyClass: 'orchestrator-mode' },
        script: { label: '脚本模式 - 动态流水线并行处理 PDXScript', bodyClass: 'script-mode' },
    },
    slashDescriptions: {
        '/init': '扫描项目，生成 Agent 画像和 CWTOOLS.md',
        '/clear': '清空当前对话，开始新话题',
        '/compact': '压缩 Agent 活动上下文，同时保留话题聊天记录',
        '/fork': '从当前位置分叉对话',
        '/archive': '归档当前话题',
        '/workflow:list': '列出可用 AI 工作流',
        '/workflow:save': '保存当前过程为可复用 AI 工作流',
        '/workflow:off': '关闭当前 AI 工作流',
        '/mode:build': '切换到构建模式',
        '/mode:plan': '切换到计划模式',
        '/mode:explore': '切换到分析模式',
        '/mode:utility': '切换到泛用模式',
        '/mode:review': '切换到审查模式',
        '/mode:orchestrator': '切换到多 Agent 执行模式',
        '/mode:script': '切换到脚本模式',
    },
    artifact: {
        emptyTitle: '暂无 Artifacts',
        emptySubtitle: '计划、蓝图、诊断、Diff 和 Walkthrough 会在这里集中出现。',
        emptyFilterTitle: '当前筛选无内容',
        emptyFilterSubtitle: '切回“全部”查看其他 Artifacts。',
        status: {
            pending: '等待中',
            running: '运行中',
            done: '完成',
            failed: '失败',
        },
    },
    buttons: {
        cancelGeneration: '取消生成 (Esc)',
        send: '发送',
    },
    markdown: {
        waitingForChoice: '等待你的选择...',
    },
    settings: {
        unselectedProvider: '未选择 Provider',
        unsetModel: '未设置模型',
        defaultEndpoint: '默认端点',
        automatic: '自动',
        localModel: '本地模型',
        apiKeyConfigured: 'API Key 已配置',
        apiKeyMissing: 'API Key 未配置',
        inlinePrefix: '补全',
        inlineSameProvider: '同主模型',
        inlineOff: '补全: 关闭',
        writeAuto: '写入自动',
        writeConfirm: '写入确认',
        writeAutoReview: '自动审批',
        writeFull: '完全放行',
        contextPrefix: '上下文',
        mcpUnit: 'MCP',
        providerChip: 'Provider',
        writeChip: '写入',
        reasoningChip: '推理',
    },
    live: {
        waitingForOutput: '等待输出',
        thoughts: '思考',
        tools: '工具',
        text: '文本',
        subtask: '子任务',
        starting: '正在启动...',
        back: '返回',
        subagent: '子代理',
        realtimeProcess: '探索过程',
        reads: '读取',
        writes: '写入',
        thinkingDetails: '思考详情',
        compactingContext: '正在压缩上下文',
        compactingContextDetail: '整理较早的对话，同时保留目标、关键决策和最新进展',
        contextCompacted: '上下文压缩完成',
        contextCompactionFailed: '上下文压缩失败',
    },
    annotations: {
        plan: {
            title: '在线批注',
            hint: '点击段落添加批注',
            approve: '同意执行',
            approved: '已开始执行...',
            submit: '提交批注',
            submitted: '已提交',
            addTitle: '添加批注',
            placeholder: '输入批注内容...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
        orchestratorPlan: {
            title: '多 Agent 计划批注',
            hint: '确认后进入 DAG 分派与并行执行',
            approve: '启动多 Agent',
            approved: '已启动多 Agent...',
            submit: '提交批注',
            submitted: '已提交',
            addTitle: '添加批注',
            placeholder: '输入批注内容...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
        walkthrough: {
            title: 'Walkthrough 批注',
            hint: '点击段落添加批注要求',
            approve: '确认完成',
            approved: '已确认',
            submit: '重新修改',
            submitted: '已提交',
            addTitle: '提出修改要求',
            placeholder: '告诉 AI 哪里需要如何修改...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
        blueprint: {
            title: '设计蓝图批注',
            hint: '点击段落添加批注',
            approve: '同意蓝图',
            approved: '蓝图已批准',
            submit: '提交批注',
            submitted: '已提交',
            addTitle: '添加批注',
            placeholder: '输入批注内容...',
            confirm: '确定',
            cancel: '取消',
            edit: '编辑',
        },
    },
    manager: {
        tabs: { agents: 'Agents', runs: 'Runs', artifacts: 'Artifacts', tasks: '任务' },
        overview: { topics: '话题', artifacts: 'Artifacts', steps: '步骤', messages: '消息', run: '运行', mode: '模式', workflow: '工作流', status: '状态', none: '无', running: '运行中', idle: '空闲' },
        runs: {
            noRun: '暂无运行记录',
            runId: '运行 ID',
            status: '状态',
            metrics: { tokens: 'Tokens', cost: '费用', tools: '工具', calls: '次' },
            openMemory: '查看记忆',
            copyEventJson: '复制事件 JSON',
            copiedEvent: '已复制',
            cleanLargeResults: '清理大型结果',
            cleaned: '已清理 {deleted} 个大型结果文件，保留 {kept} 个，回收 {size}。',
            modifiedFiles: '修改文件',
            subAgentChangeSets: '子 Agent 变更集',
            compactedMemory: '压缩记忆',
            stepsTitle: '步骤记录',
            noSteps: '本次运行暂无步骤记录',
            eventDetail: '事件详情',
            closeInspector: '关闭',
            steps: { thought: '思考 / 推理', thinking: '思考过程', toolCall: '工具调用', toolResult: '工具结果', execError: '执行错误' },
        },
        tasks: { noTasks: '暂无任务' },
        agents: { noLanes: '暂无活跃的编排器通道', phase: '阶段', done: '完成', running: '运行中', failed: '失败', task: '任务', steps: '步骤', tokens: 'tokens' },
    },
    runs: {
        groups: {
            model: '模型调用',
            tools: '工具调用',
            files: '文件变更',
            permissions: '权限',
            validation: '校验',
            context: '上下文与记忆',
            subagents: '子 Agent',
            other: '其他',
        },
        inspector: {
            noEvent: '无选中事件',
            args: '参数',
            argRepairs: '参数修复',
            targetPaths: '影响路径',
            toolResult: '工具结果',
            fullResult: '完整结果',
            openFullContent: '📂 打开完整内容',
            error: '错误',
            preview: '预览',
            truncated: '... (已截断)',
            fileChange: '文件变更',
            path: '路径',
            diff: 'Diff',
            subagentResult: '子 Agent 结果',
            task: '任务',
            changeset: '变更集',
            steps: '步骤',
            tokens: 'Tokens',
            compactionDone: '上下文压缩完成',
            goal: '目标',
            nextSteps: '下一步',
            selectEventHint: '选择一个事件以查看详情',
            contextUsage: '上下文使用率',
            agentLabel: 'Agent',
        },
    },
};

export function normalizeChatLocale(locale?: string | null): ChatLocale {
    return (locale || '').toLowerCase().startsWith('zh') ? 'zh-cn' : 'en';
}

export function getChatI18n(locale?: string | null): ChatI18nText {
    return normalizeChatLocale(locale) === 'zh-cn' ? ZH_CN : EN;
}
