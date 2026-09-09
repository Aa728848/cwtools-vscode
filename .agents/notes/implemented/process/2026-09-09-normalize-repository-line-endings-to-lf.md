# Agent Note: 规范化仓库文本文件行尾至 LF 并配置 EditorConfig

Status: implemented

## Problem
在对项目工作区进行行尾检查时，发现主仓库中存在严重的混合行尾（Mixed EOL）与 CRLF/LF 不一致问题：
1. 共有 26 个文件在单文件内部同时混杂了 CRLF（`\r\n`）与 LF（`\n`），个别文件（如 `.vscode/tasks.json`）还存在孤立 CR 字符。
2. 共有 36 个文本/配置文件全篇采用 CRLF，与仓库绝大多数文件（782 个纯 LF）不一致。
3. 构建脚本 `tools/build-release-readme.js` 中显式执行了 `.replace(/\n/g, '\r\n')`，导致构建 `release/README.md` 时会被强制覆写为 CRLF。
4. 混合行尾对 Agent 工具（如精确文本替换 `edit`、Diff/Patch 计算引擎 `diffEngine.ts`）以及字符串逐行比对极为有害，会导致替换匹配失败、虚假空行差异与 Git 变更污染。

## Decision
1. **行尾规范化转换**：
   - 将主仓库中全部 62 个存在 CRLF 或单文件混用的文本文件一次性转换为标准的 LF。
   - 对包含 UTF-8 BOM 的文件（如 `client/test/sample/localisation/irm_l_english.yml`、`client/test/sample/common/defines/irm_defines.txt`、`build/Program.fs`、`src/Languages/Languages.csproj` 等）严格保留其原始 BOM 签名，确保 Paradox 本地化文件及 .NET 工程编码预期不被破坏。
2. **构建脚本收口**：
   - 移除 `tools/build-release-readme.js` 中的 CRLF 替换逻辑，统一输出纯 LF 换行的 `release/README.md`。
3. **引入 EditorConfig**：
   - 在项目根目录添加 `.editorconfig`，声明 `end_of_line = lf`、`charset = utf-8` 和 `insert_final_newline = true`，防止本地编辑器在 Windows 环境下保存时二次引入 CRLF。

## Alternatives considered
1. **仅依赖 `.gitattributes` 并在检出时依赖 Git 自动转换**：
   - 否决。虽然仓库已配置 `* text=auto eol=lf`，但已提交历史或未重新规范化的工作区文件依然驻留 CRLF，在 Windows 本地编辑或运行脚本时若不改变磁盘上的实际字节，Agent 工具和本地测试仍会持续遭遇混合行尾问题。
2. **同时处理外部 Git 子模块（`submodules/*`）**：
   - 否决。`.gitmodules` 中管理的子模块（如 `cwtools`、`cwtools-stellaris-config`）属于独立仓库，其维护生命周期与提交策略独立，跨子模块无差别修改会导致外部仓库工作区脏污，根据本仓库 `AGENTS.md` 规范必须保持子模块独立管理。

## Consequences
- 彻底消除了主仓库内全部 26 处单文件混合换行与 36 处纯 CRLF 文本文件，全仓 843 个文本文件达到 100% 统一为 LF。
- 保证了 Agent 文本编辑工具、差异比对引擎与静态检查的确定性，消除了由于隐藏 `\r` 导致的不可见字符匹配失败风险。
- 执行 `npm run build:docs`、`npm run compile`、`npm run typecheck:test` 均完全通过且保持 LF 状态。
