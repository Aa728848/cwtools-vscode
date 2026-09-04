# Agent Note: AI System Prompt Evidence Hierarchy and PDXScript BOM Enforcement

Status: implemented

## Problem
在 AI 代码生成辅助与 Paradox 游戏文件写入中，存在两项核心痛点：
1. **模型幻觉生成虚构脚本**：AI 在缺乏硬性约束时，容易主观猜测或臆造不存在的 Clausewitz 脚本触发器（triggers）、效果（effects）或修正（modifiers），生成看似合理但 LSP 立即全盘报错的无效代码。
2. **BOM 编码对游戏引擎的致命破坏**：
   - Paradox 引擎对编码极为敏感：本地化文件（`localisation/*.yml`）强制要求 UTF-8 with BOM；
   - 相反，所有游戏逻辑脚本（`common/`, `events/`, `gfx/`, `interface/` 等目录下的 `.txt`/`.gui` 等）**严禁包含 BOM**。如果脚本文件首字节存在 UTF-8 BOM（`\uFEFF`），解析器将直接报语法错误，严重时直接导致游戏在启动加载阶段崩溃退出。
   - 旧代码中若模型或调用方盲目传入 `encoding: 'utf8bom'`，系统会如实写入，造成游戏脚本损坏。

## Decision
1. **植入证据层级（Evidence Hierarchy）系统提示词**：
   - 在 `baseSystem.ts` 根系统提示词中确立核心防线：禁止幻觉猜测未验证的属性与触发器；在编写代码或形成方案前，必须主动查验 CWT 规则、原版数据（Vanilla）及现有项目代码进行实证交叉校验。
2. **在文件写入层实施强制 PDXScript 无 BOM 编码保护**：
   - 彻底重构 `fileTools.ts` 中的编码决策矩阵：
     - 识别为本地化路径（`isLocalisationPath`）的 YAML 文件，统一强制写入 UTF-8 BOM。
     - 属于非本地化逻辑脚本的文件，**绝对禁止添加 BOM**；即便传入 `encoding: 'utf8bom'`，也无条件强制回退为普通 UTF-8（无 BOM），防止引擎解析崩溃。
     - 若旧文件本身遗留了 BOM，在明确指定 `encoding: 'utf8'` 时主动剥除首字节 BOM 标记。
3. **补齐单测与工具契约描述**：
   - 在 `agentToolSafety.test.ts` 中编写端到端断言，验证在请求 `utf8bom` 写入普通脚本时字节流前 3 字节绝不包含 `0xEF, 0xBB, 0xBF`。
   - 在 `definitions.ts` 中更新工具参数说明，对编码规范做出明确的领域声明。

## Alternatives considered
- **完全遵循模型或上层传递的 `encoding` 意图**：
  - *未采纳原因*：通用 LLM 缺乏对 Paradox 引擎文件特定编码陷阱的深刻认知，容易在调用时随机携带 `utf8bom`；领域工具必须承担起“安全兜底护栏”的职责，主动防御不合规操作。
- **由 LSP 后端报错后提示用户或 Agent 手动修复**：
  - *未采纳原因*：写入时预防比产生损坏文件后再提示修复成本更低，在写入门禁直接防范可保障工作区代码时刻处于游戏可读状态。

## Consequences
- 彻底消除了因写入 BOM 导致的游戏启动崩溃与语法解析失败。
- AI 生成的代码质量显著提升，杜绝了低级语法捏造。
- 强化了领域专属文件工具的健壮性与安全性。
