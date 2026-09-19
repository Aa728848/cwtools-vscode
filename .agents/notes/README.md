# Agent Notes

本目录是 `cwtools-vscode` 项目的架构与工程变更决策日志（Agent Notes 体系）。
每次进行非平凡的代码修改、架构重构、功能开发或流程变更时，均需在此记录对应的决策与改动上下文。

---

## 1. 核心哲学与信息归属（One Home Per Fact）

整个仓库遵循「每个事实只有一个家（One home per fact）」原则：

- **`README.md` / 用户与协议文档**：面向使用者的功能行为、用户界面与公开契约。
- **`ARCHITECTURE.md`**：系统模块边界、核心主循环（Loop）、扩展点与数据流。
- **`AGENTS.md`**：编码代理每次会话必读的硬性命令与常驻法令（Standing orders）。
- **Agent Notes（本目录）**：**技术决策的唯一归宿**。专门承载代码与普通文档无法承载的深层设计原因（Why）、权衡考量与放弃的备选方案（What we gave up）。

其他文档仅使用 Markdown 相对链接引用具体 Note，严禁在多处冗余复制长篇决策规则。

---

## 2. 目录结构与命名规范

所有笔记严格遵循如下双轴路径拓扑：

```text
.agents/notes/{lifecycle}/{class}/YYYY-MM-DD-slug.md
```

- **`{lifecycle}`（生命周期）**：
  - `proposed/`：提议中，处于方案评审或讨论阶段（`Status: proposed`）。
  - `implemented/`：已实现并合并入库（`Status: implemented`）。笔记必须如实反映实际落地的代码现状，并随代码重构实时就地同步（见下文）。
  - `rejected/`：经评估被拒绝或放弃采纳（`Status: rejected — <单行拒绝原因>`）。保留在库中以防未来重蹈覆辙。
  - `archived/`：历史遗留、已被后续变更完全取代或失效的记录（`Status: archived`）。永久冻结。
- **`{class}`（封闭 6 分类）**：
  必须为以下 6 类之一，严禁自行扩充类别：
  - `feature`：新增功能或外部可见能力。
  - `bug-fix`：修复缺陷或边界异常。
  - `simplification`：代码简化、冗余消减、小范围收口与重构。
  - `architecture`：架构边界变动、组件解耦、协议层重塑。
  - `process`：开发流程、CI/CD、发布打包或规则系统变更。
  - `testing`：测试套件、回归夹具或测试基线改进。
- **`YYYY-MM-DD-slug.md`（文件名）**：
  - 以当前变动的提出/实现日期开头（例如 `2026-09-20`）。
  - 后接简明英文短横线命名（slug），如 `backend-lsp-review-closure-and-hygiene-convergence.md`。

---

## 3. 决策所有权原则（Owning Note）与前置查阅

### 3.1 修改功能前的查阅流程（Pre-edit Review）
在对现有子系统、复杂功能或架构逻辑做非平凡修改前，AI 必须先进行前置检索：
1. **定位决策所有者（Owning Note）**：按功能领域分类（如 `architecture/`、`feature/`）检索 `.agents/notes/implemented/` 中的历史笔记。
2. **审阅历史约束与被否决方案**：重点阅读 `Alternatives considered` 与 `Consequences`，了解当初为什么采用当前设计、放弃了哪些备选方案，避免提出已被验证不可行或有安全隐患的方案。

### 3.2 决策所有权（The Owning Note Rule）
- **更新既有 Note 即满足规则**：如果当前修改是现有功能机制的调整、代码重命名、路径迁移或实现重构，且原决策意图仍然成立，**必须直接原地更新拥有该决策的既有 Note（Owning Note）**中的路径、符号与机制陈述，**严禁为每一次局部代码微调创建重复的新 Note**。
- **何时新建 Note**：
  - 没有任何既有 Note 拥有该项决策；
  - 或者当前变动做出了与历史决策**完全相反、颠覆性或全新的设计决策**（此时新 Note 必须显式相对链接指向被取代的旧 Note）。
- **完全取代与合并（Consolidation）**：
  当一个新变更彻底淘汰并取代旧特性时，新 Note 应吸收旧 Note 中仍具参考价值的备选方案与经验总结，并在同一变更中归档或移除完全失效的旧记录。

---

## 4. 格式规范与生命周期骨架

所有 Agent Note 头部三行必须严格一致：

```markdown
# Agent Note: <简要标题>

Status: <proposed | implemented | rejected — <一句话原因> | archived>
```

### 4.1 `proposed/` 结构（方案设计态）
```markdown
## Problem
<描述所面临的问题、背景、缺陷症状或现状。>

## Proposal
<描述提议的设计方案。此时可使用未来时态表达计划。>

## Alternatives considered
<强制必填：调研中评估过的备选方案及未采纳原因。>

## Acceptance criteria
<验收标准：可观测的行为或测试断言。>

## Risks
<潜在风险与权衡。>
```

### 4.2 `implemented/` 结构（交付事实态）
```markdown
## Problem
<描述所面临的问题背景与改动动机。>

## Decision
<清晰阐述实际落地交付的设计与实施细节。交付态必须使用客观事实叙述（即“做了什么”/“现在的行为是什么”），严禁保留计划式或规格腔口吻（禁用 ## Proposal、## Plan、## Acceptance criteria）。>

## Alternatives considered
<强制必填：列出评估过但被否决的备选方案及明确原因。>

## Consequences
<该决策带来的直接收益、对系统或上下游的影响、带来的后续约束或已知权衡。>
```

---

## 5. 核心纪律

1. **同变更提交**：任何非平凡变更必须在同一提交/PR 中包含或同步更新对应的 Agent Note，不得代码先行或脱节补录。
2. **交付态写事实并实时保鲜**：`implemented/` 目录下的笔记反映系统真实代码基线。后续代码变更了路径、配置名、默认值或接口时，必须在同一变更中原地修正笔记陈述，保持笔记与交付代码的一致性。
3. **禁止全局 INDEX 文件**：不要维护集中的 `INDEX.md` 或 `TABLE_OF_CONTENTS.md`。目录树即天然索引，避免多分支并行合并时的冲突。
4. **强制备选方案（Alternatives considered）**：技术决策必须有对比，明确记录被否决的方案及其理由，防止无休止的重新辩论。
5. **规范简体中文书写**：所有 Agent Note 的标题与正文必须使用规范的简体中文书写（代码符号、配置项、API 名称、文件路径及文件名 slug 等除外）。必要时应补充 Mermaid 流程图与输入输出图辅助阐述系统流转。
