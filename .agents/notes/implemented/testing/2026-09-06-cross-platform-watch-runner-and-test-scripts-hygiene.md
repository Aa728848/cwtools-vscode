# Agent Note: Cross-Platform Watch Runner and Test Scripts Hygiene

Status: implemented

## Problem
1. **`test:watch` 命令在 Windows Shell 下失效或阻塞**：
   - 原命令 `tsc -w -p . & vscode-test --config ./.config/vscode-test.js -w` 在 Windows PowerShell 下由于单 `&` 是保留的调用操作符直接抛出语法错误；而在 Windows CMD 下，单 `&` 为串行等待，由于 `tsc -w` 常驻监听不会退出，导致 `vscode-test -w` 永远无法启动。
2. **`test:unit` 存在不必要的 `npx` 寻址开销与风格不一致**：
   - 项目在 `devDependencies` 中已声明并安装 `ts-mocha`，但在 `test:unit` 中使用了 `npx ts-mocha`，而在 `test:rules-sync` 中直接使用 `ts-mocha`，存在额外开销与规范不统一。

## Decision
1. **新增跨平台 Watch 调度器 `tools/run-watch-test.cjs`**：
   - 并行启动 `tsc -w` 与 `vscode-test -w`。
   - 监听 `SIGINT`、`SIGTERM` 与 `exit` 事件，在主进程中断或任意子进程异常退出时，利用跨平台进程树清理逻辑（Windows 下 `taskkill /T /F`，POSIX 下 `SIGTERM`）彻底释放后台子进程，杜绝孤儿进程占用。
2. **重构 `package.json` 中的 `scripts`**：
   - 将 `test:watch` 指向 `node tools/run-watch-test.cjs`。
   - 将 `test:unit` 中的 `npx ts-mocha` 统一收拢为 `ts-mocha`。

## Alternatives considered
- **引入 `concurrently` 或 `npm-run-all` 依赖包**：
  - *未采纳原因*：增加外部依赖会膨胀 `node_modules` 与 `package-lock.json`，且需维护额外包升级成本。本项目工具链一贯倾向使用自包含的 Node.js 脚本（如 `run-overlay-e2e.cjs`、`run-all-fsx-tests.cjs`），保持仓库零额外运行时依赖。
- **让开发者在两个不同终端手动分别启动**：
  - *未采纳原因*：牺牲了一键启动的开发体验，且原命令在 CI 或脚本中如果误调仍会留下不可用的隐患。

## Consequences
- `npm run test:watch` 在 Windows PowerShell、CMD 以及 Linux/macOS 环境下均可无缝一键并发启动 watch 监听。
- `test:unit` 与 `test:rules-sync` 统一了调用风格，且单元测试（2350+ 项）与发布门禁（`check:release`）验证全绿通过。
