# Agent Notes

本目录是 `cwtools-vscode` 项目的架构与工程变更决策日志（Agent Notes 体系）。
每次进行非平凡的代码修改、架构重构、功能开发或流程变更时，均需在此记录对应的决策与改动上下文。

---

## 1. 目录结构与命名规范

所有笔记严格遵循如下路径拓扑：

```text
.agents/notes/{lifecycle}/{class}/YYYY-MM-DD-slug.md
```

- **`{lifecycle}`（生命周期）**：
  - `proposed/`：提议中，处于方案评审或讨论阶段（`Status: proposed`）。
  - `implemented/`：已实现并合并入库（`Status: implemented`）。
  - `rejected/`：经评估被拒绝或放弃采纳（`Status: rejected`）。
  - `archived/`：历史遗留、已被后续变更取代或失效的记录（`Status: archived`）。
- **`{class}`（封闭分类）**：
  必须为以下 6 类之一，严禁自行扩充类别：
  - `feature`：新增功能或外部可见能力。
  - `bug-fix`：修复缺陷或边界异常。
  - `simplification`：代码简化、冗余消减、小范围收口与重构。
  - `architecture`：架构边界变动、组件解耦、协议层重塑。
  - `process`：开发流程、CI/CD、发布打包或规则系统变更。
  - `testing`：测试套件、回归夹具或测试基线改进。
- **`YYYY-MM-DD-slug.md`（文件名）**：
  - 以当前变更日期开头（例如 `2026-09-04`）。
  - 后接简明英文短横线命名（slug），如 `backend-lsp-review-closure-and-hygiene-convergence.md`。

---

## 2. 格式规范与模板

所有 Agent Note 必须严格遵循以下 Markdown 结构骨架：

```markdown
# Agent Note: <简要标题>

Status: <proposed | implemented | rejected | archived>

## Problem
<描述所面临的问题、背景、缺陷症状或需要重构的现状。说明为什么需要本次变动。>

## Decision
<清晰阐述所做出的设计决定与实施细节。交付态请使用客观事实叙述（即“做了什么”），而非未来时或计划式口吻。>

## Alternatives considered
<强制必填：列出在方案调研或实施过程中评估过的备选方案，并明确说明为什么未采用它们。>

## Consequences
<描述该决策带来的直接收益、对现有系统或上下游的影响、带来的后续约束或已知权衡。>
```

---

## 3. 核心纪律

1. **同变更提交**：任何非平凡变更必须在同一提交/PR 中包含对应的 Agent Note，不得代码先行或脱节补录。
2. **禁止全局 INDEX 文件**：不要维护集中的 `INDEX.md` 或 `TABLE_OF_CONTENTS.md`。目录树即天然索引，避免多分支并行合并时的文件冲突。
3. **强制备选方案（Alternatives considered）**：技术决策必须有对比，明确记录被否决的方案及其理由。
4. **交付态写事实**：`implemented` 目录下的笔记是交付物的一部分，必须如实反映实际落地的代码、测试与验证基线。
5. **必须使用中文书写**：所有 Agent Note 的标题与正文必须使用规范的简体中文书写（代码符号、配置项、API 名称、文件路径及文件名 slug 等除外）。必要时应补充 Mermaid 流程图与输入输出图辅助阐述系统流转。
