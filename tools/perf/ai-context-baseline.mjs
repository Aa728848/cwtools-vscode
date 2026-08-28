/**
 * AI static-context baseline measurement (docs/ai-agent-reliability-efficiency-plan.md
 * §9 phase 0 "测量基线", table structure mirrors §2.1).
 *
 * Loads the real PromptBuilder / TOOL_DEFINITIONS / runnerPolicy from
 * client/extension/ai under a minimal `vscode` stub (same hook pattern as
 * client/test/unit/memoryParser.test.ts) and measures the static per-request
 * context — system prompt + tool schemas — with the repo's own
 * estimateTokenCount heuristic (client/extension/ai/agentRunner.ts).
 *
 * Fixture: an empty temp workspace (no CWTOOLS.md, project profile, project
 * knowledge, memory, or installed skills), languageId forced to 'stellaris'.
 * Dynamic context (editor state, user input, conversation history, injected
 * memory/blueprint) is not part of these numbers.
 *
 * Usage: npm run baseline:ai-context  — writes docs/ai-context-baseline.md
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(repoRoot, 'tools', 'perf', 'index.cjs'));

require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2020', esModuleInterop: true },
});

// ─── vscode stub (module._load hook, same as the unit tests) ────────────────
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (_key, defaultValue) => defaultValue }),
    workspaceFolders: [],
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
    showErrorMessage: () => Promise.resolve(undefined),
  },
  Uri: { file: (p) => ({ fsPath: p }) },
};
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, ...args);
};

const loadTs = (rel) => require(path.join(repoRoot, ...rel.split('/')));

const { PromptBuilder } = loadTs('client/extension/ai/promptBuilder.ts');
const { TOOL_DEFINITIONS } = loadTs('client/extension/ai/tools/definitions.ts');
const {
  filterToolDefinitionsForMode,
} = loadTs('client/extension/ai/runnerPolicy.ts');
const { toolDisclosureService } = loadTs('client/extension/ai/runner/toolDisclosure.ts');
const { estimateTokenCount } = loadTs('client/extension/ai/agentRunner.ts');

// ─── Measurement ─────────────────────────────────────────────────────────────
const GAME_ID = 'stellaris';
const MODES = ['build', 'plan', 'explore', 'review'];
const PARALLEL_SLIM_BUILDERS = 8;

function measure(label, prompt, tools) {
  const promptTokens = estimateTokenCount(prompt);
  const toolTokens = estimateTokenCount(JSON.stringify(tools));
  return { label, toolCount: tools.length, promptTokens, toolTokens, total: promptTokens + toolTokens };
}

function toolsForMode(mode, options) {
  const modeTools = filterToolDefinitionsForMode(TOOL_DEFINITIONS, mode, options);
  return toolDisclosureService.initialTools(modeTools, {
    mode,
    domain: 'paradox',
    dynamicSupported: true,
    loaded: new Set(),
  });
}

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cwtools-ai-baseline-'));
let report;
try {
  const builder = new PromptBuilder(workspaceRoot);

  const rows = MODES.map(mode => measure(
    mode,
    builder.buildSystemPromptForMode(mode, undefined, GAME_ID),
    toolsForMode(mode),
  ));
  const slimBuild = measure(
    'build (slim)',
    builder.buildSlimSystemPromptForMode('build', undefined, GAME_ID),
    toolsForMode('build', { useSlimPrompt: true }),
  );
  const blueprintDef = TOOL_DEFINITIONS.find(d => d.function.name === 'write_design_blueprint');
  if (!blueprintDef) throw new Error('write_design_blueprint not found in TOOL_DEFINITIONS');
  const blueprintSchemaTokens = estimateTokenCount(JSON.stringify(blueprintDef));

  const build = rows.find(r => r.label === 'build');
  const slimParallelWorst = slimBuild.total * PARALLEL_SLIM_BUILDERS;

  report = renderReport({ rows, slimBuild, build, blueprintSchemaTokens, slimParallelWorst });
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}

const outPath = path.join(repoRoot, 'docs', 'ai-context-baseline.md');
fs.writeFileSync(outPath, report, 'utf8');
console.log(`Wrote ${path.relative(repoRoot, outPath)}`);

// ─── Report rendering ────────────────────────────────────────────────────────
function renderReport({ rows, slimBuild, build, blueprintSchemaTokens, slimParallelWorst }) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const generatedAt = new Date().toISOString();
  let commit = 'unknown';
  let workingTree = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    workingTree = execSync('git status --porcelain --untracked-files=no', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim().length > 0 ? 'dirty' : 'clean';
  } catch { /* git unavailable — record as unknown */ }
  const measuredInputs = [
    'client/extension/ai/promptBuilder.ts',
    'client/extension/ai/tools/definitions.ts',
    'client/extension/ai/runnerPolicy.ts',
    'client/extension/ai/agentRunner.ts',
  ];
  const inputFingerprint = createHash('sha256');
  for (const input of measuredInputs) {
    inputFingerprint.update(input);
    inputFingerprint.update('\0');
    inputFingerprint.update(fs.readFileSync(path.join(repoRoot, input)));
    inputFingerprint.update('\0');
  }
  const inputSha256 = inputFingerprint.digest('hex').slice(0, 24);

  const modeTable = rows.map(r =>
    `| ${r.label} | ${r.toolCount} | ${fmt(r.promptTokens)} | ${fmt(r.toolTokens)} | ${fmt(r.total)} |`,
  ).join('\n');
  return `<!-- GENERATED FILE — run \`npm run baseline:ai-context\` to regenerate. -->
# AI 静态上下文基线 / AI Static-Context Baseline

对应 [ai-agent-reliability-efficiency-plan.md](./ai-agent-reliability-efficiency-plan.md) §9 阶段 0（测量基线），表格与 §2.1 同构。

- 生成时间：${generatedAt}
- 生成时基础 Commit：${commit}（工作树：${workingTree}；报告可能包含尚未提交的测量输入）
- 测量输入 SHA-256：${inputSha256}
- Token 估算：仓库自身 \`estimateTokenCount\`（\`client/extension/ai/agentRunner.ts\`），适合相对比较，不等同于供应商计费。
- Fixture：空临时 workspace（无 CWTOOLS.md、project profile、project knowledge、记忆、已安装技能），languageId 固定为 \`${GAME_ID}\`。
- 工具 Schema 按 mode/domain 过滤后，使用自动披露的首轮工具集并以 \`JSON.stringify\` 估算。
- 不含动态上下文（编辑器状态、用户输入、对话历史、注入的记忆/blueprint）；真实项目 workspace 的数字只会更大。

## 与 §2.1 同构的基线数字（Stellaris build 模式）

| 项目 | 估算 token |
| --- | ---: |
| 系统提示词 | ${fmt(build.promptTokens)} |
| ${build.toolCount} 个工具定义 | ${fmt(build.toolTokens)} |
| 首轮静态输入合计 | ${fmt(build.total)} |
| slim build 静态输入（${slimBuild.toolCount} 个工具） | ${fmt(slimBuild.total)} |
| ${PARALLEL_SLIM_BUILDERS} 个并行 slim builder 的首轮静态输入 | 最差约 ${fmt(slimParallelWorst)} |
| \`write_design_blueprint\` 单个工具 Schema | ${fmt(blueprintSchemaTokens)} |

## 分模式明细

| 模式 | 工具数 | 系统提示词 | 工具 Schema | 静态合计 |
| --- | ---: | ---: | ---: | ---: |
${modeTable}
| ${slimBuild.label} | ${slimBuild.toolCount} | ${fmt(slimBuild.promptTokens)} | ${fmt(slimBuild.toolTokens)} | ${fmt(slimBuild.total)} |

## 与 §6.1 目标预算的差距

| Agent 类型 | 目标 | 当前基线 |
| --- | ---: | ---: |
| 主 Agent（build 静态合计） | 约 8,000 | ${fmt(build.total)} |
| slim/专职子 Agent（slim build 静态合计） | ≤4,000 | ${fmt(slimBuild.total)} |
`;
}
