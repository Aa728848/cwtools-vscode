---
name: release-extension
description: >-
  Use this skill when the user asks to release a new version of the extension,
  bump the version number, write changelogs, build cross-platform .NET servers,
  package universal VSIX, and publish to GitHub Releases.
---

# CWTools VSCode 插件版本发布与打包技能 (Release Extension Skill)

本技能定义了 CWTools VSCode 插件从改动梳理、版本号升级、双语更新日志编写、单源文档同步、全平台自包含语言服务器编译与 VSIX 打包，到最终 Git 提交打 Tag、推送并创建 GitHub Release 挂载安装包的全流程标准作业规范（SOP）。

---

## 流程概览

1. **改动梳理与版本确定**：对比上次 Release Tag 至今的所有 Commit，依据 SemVer 确定新版本号。
2. **版本号与更新日志同步**：
   - 升级 `package.json` 与 `release/package.json` 的 `version` 字段。
   - 在 `release/CHANGELOG.md` 顶部按中英双语格式撰写更新日志。
   - 在 `.agents/notes/implemented/process/YYYY-MM-DD-release-v<ver>.md` 记录流程决策。
3. **单源文档生成与预检**：
   - 运行 `npm run build:docs` 生成发布 README。
   - 运行 `npm run compile` 编译前端与 TypeScript。
   - 运行 `npm run check:release -- --skip-compile --skip-test` 执行发布门禁检查。
4. **全平台 Universal VSIX 打包**：
   - 执行根目录自动化打包脚本 `powershell -ExecutionPolicy Bypass -File ./package.ps1`。
   - 依次构建 win-x64（ReadyToRun）、linux-x64、osx-x64 自包含 F# LSP 服务端，并由 `@vscode/vsce package` 输出单通用 `.vsix`（大小约 140MB+）。
5. **Git 提交与打 Tag**：
   - 暂存相关文件并提交：`git commit -m "Bump version to <version> and add changelog"`。
   - 创建 Git 标签：`git tag v<version>`。
6. **推送与 GitHub Release 发布**：
   - 推送分支与标签至 GitHub（如遇网络连接问题，可临时设置本地代理环境变量 `$env:all_proxy="http://127.0.0.1:7890"`）。
   - 提取新版本更新日志并通过 `gh release create v<version> <vsix_file> --repo Aa728848/cwtools-vscode --title "v<version>" --notes-file <notes_file>` 发布。

---

## 详细步骤与执行命令

### 步骤 1：梳理近期提交与确定版本号

```powershell
# 1. 查找上一个发布 Tag
git describe --tags --abbrev=0

# 2. 查看自上个 Tag 以来的提交清单与改动摘要
git log <last_tag>..HEAD --oneline
git log <last_tag>..HEAD --stat

# 3. 确定版本升级类型：
# - 补丁版本 (Patch, 如 2.18.0 -> 2.18.1)：纯 Bug 修复、向下兼容的小调整。
# - 次版本 (Minor, 如 2.18.0 -> 2.19.0)：包含新特性、系统重构、大型架构升级。
```

### 步骤 2：更新版本号与编写变更日志

1. **更新版本号**（禁止仅改单处，保持根目录与 release 目录一致）：
   - `package.json` -> `"version": "<version>"`
   - `release/package.json` -> `"version": "<version>"`

2. **编写更新日志**（`release/CHANGELOG.md`）：
   在文件顶部的 `# Changelog` 之后追加最新区块：
   ```markdown
   ## [<version>] - YYYY-MM-DD

   ### 分类名称 / English Category Name
   - **[特性/修复/优化] 功能点描述（English Title）**：
     - 中文详述 1
     - 中文详述 2
     - English: [Feature/Fix/Optimization] English summary...
   ```

3. **记录 Agent Note**（遵循 `AGENTS.md`）：
   在 `.agents/notes/implemented/process/YYYY-MM-DD-release-v<version>.md` 中记录问题背景、版本决策、各模块变更与交付影响。

### 步骤 3：单源文档生成与门禁检查

```powershell
# 同步单源多语言文档与发布用 README
npm run build:docs

# 编译客户端代码与 Webview 资源
npm run compile

# 运行 Release 门禁检查（确保两处 package.json 版本一致、更新日志条目存在等）
npm run check:release -- --skip-compile --skip-test
```

### 步骤 4：全平台自包含 Universal VSIX 打包

调用自动化打包工具 `package.ps1`，该脚本会严格按顺序依次发布三平台 .NET 运行时，避免多目标锁冲突：

```powershell
powershell -ExecutionPolicy Bypass -File ./package.ps1
```

*打包产物*：`release/foreverskywalker-stellaris-cwtools-<version>.vsix`。

### 步骤 5：Git 提交与打 Tag

```powershell
# 暂存版本与日志文件
git add package.json release/package.json release/CHANGELOG.md .agents/notes/implemented/process/YYYY-MM-DD-release-v<version>.md

# 提交变更
git commit -m "Bump version to <version> and add changelog"

# 创建版本标签
git tag "v<version>"
```

### 步骤 6：推送到 GitHub 并创建 Release

```powershell
# 1. 如遇到 GitHub 网络连接限制，配置代理环境变量（如使用 7890 端口）：
$env:all_proxy = "http://127.0.0.1:7890"

# 2. 推送主分支与标签
git push origin main
git push origin "v<version>"

# 3. 提取当前版本的 Changelog 内容至临时文件
node -e "
const fs = require('fs');
const content = fs.readFileSync('release/CHANGELOG.md', 'utf8');
const match = content.match(/## \[<version>\] - [^\n]+([\s\S]*?)(?=\n## \[)/);
if (match) { fs.writeFileSync('.release-notes-temp.md', match[1].trim(), 'utf8'); }
"

# 4. 获取生成的 VSIX 路径
$vsix = (Get-ChildItem release/*.vsix | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName

# 5. 调用 gh CLI 创建 GitHub Release 并上传 VSIX
gh release create "v<version>" $vsix --repo Aa728848/cwtools-vscode --title "v<version>" --notes-file .release-notes-temp.md

# 6. 清理临时笔记文件
Remove-Item .release-notes-temp.md -Force
```

### 步骤 7：验证发布结果

```powershell
gh release view "v<version>" --repo Aa728848/cwtools-vscode
```
验证包含对应的 Tag、Release 描述以及挂载的 `.vsix` 资产包。
