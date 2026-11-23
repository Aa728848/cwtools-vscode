# `submodules/cwtools` 维护速查与遗留观察

`submodules/cwtools` 是本仓库的 Git 子模块，同时也是可脱离父仓库独立构建与测试的 F# 核心库仓库（拥有独立 `cwtools.slnx`、CI 与冻结测试夹具）。父仓库仅通过 `src/Main/Main.fsproj`（库引用）与 `tools/rules-sync/stellaris-rules-sync.js`（`CWToolsCLI` 调用）单向消费它。

> **跨仓库边界**：先在 `submodules/cwtools` 内提交并推送，再在父仓库更新子模块指针；严禁将库改动与 `cwtools-stellaris-config` 规则数据混在同一提交中。

## 入口与 CLI 调用规则

| 用途 | 入口 |
| --- | --- |
| 作为 F# 库 | `CWTools.fsproj`（`STLGame(settings)`，参考 `src/Main/GameLoader.fs`） |
| 作为 CLI | `CWToolsCLI.fsproj`（子命令：`validate`、`list`、`parse`、`format`、`shader-abi-inventory`、`serialize`） |

使用 `CWToolsCLI` 时的硬性约束：
1. **全局参数必须放在子命令之前**（Argu `[<Inherit>]` + `[<Last>]` 约束）：
   ```powershell
   cwtools --game stl format path/to/file.txt   # 正确
   cwtools format path/to/file.txt --game stl   # 错误：missing argument '--game'
   ```
   `--game` 对所有子命令必选（包括 `parse` / `format`）；`validate` 与 `parse` 出错时退出码为 `1`。
2. **`--directory` 必须直接指向游戏/Mod 根目录**（直接含 `common`/`localisation`/`events` 等目录的层级）；指向其父目录会静默返回空结果。
3. **`serialize` 的缓存类型为位置参数**：`serialize [--outputcachefile <f>] <full|metadata>`（无 `--outputcachetype` 标志）。
4. **`list files` → `serialize metadata` 两步协议（刻意设计）**：
   - 第一步：`cwtools --game stl --directory <dir> list files` 将相对路径清单写入当前工作目录（CWD）的 `cwtools-files.csv`。
   - 第二步：`cwtools --game stl --directory <dir> serialize metadata` 从 `<dir>/cwtools-files.csv` 读回并并入 `CachedRuleMetadata.files`，使校验器无需磁盘 `stat` 即可验证原版文件路径字段。两步的 CWD 与 `--directory` 必须指向同一目录。

## 验证门禁

```bash
cd submodules/cwtools
dotnet build cwtools.slnx
dotnet test CWToolsTests/
cd ../.. && dotnet build src/Main/
```

- `dotnet test` 即使测试摘要显示 `0 failed`，仍可能因 Expecto `[E]` 级日志计数返回退出码 `1`；判断成败以摘要行为准。
- 如需针对活跃规则目录而非冻结夹具运行测试，设置环境变量 `CWTEST_STELLARIS_CONFIG=<path/to/cwtools-stellaris-config/config>`。

## 现存遗留观察（非阻塞，供后续专项处理）

- **退出码与测试摘要不一致**：Expecto 错误级日志会导致全通过时退出码仍为 `1`，需在测试宿主或 `submodules/cwtools/build/Program.fs` 统一收敛。
- **NuGet 打包链待整修**：`build.cmd PackTools` 受 `CheckFormat`（约 90 个 `.fs` 文件 fantomas 格式漂移）和非 SemVer 兜底版本号 `LocalBuild` 阻塞，且存在 `NU5125`/`NU5048` 弃用警告；`cwtoolscli.nuspec` 目前未被 `fsproj`/FAKE 消费。
- **CLI 缺少独立进程回归宿**：`CWToolsTests` 尚未直接起子进程覆盖 `CWToolsCLI` 的参数与退出码契约。
- **细节收敛候选**：`ErrorGame.recompute()` 目前无调用点（因属公开成员保留）；`format` 子命令的 `TryGetResult <@ File @>` 依赖声明顺序，后续可显式限定为 `<@ FormatArgs.File @>`；2 个 Shader 基线测试在缺少对应原版数据时会自动跳过。

历史修复记录见 `.agents/notes/implemented/` 中 `2026-10-07-cwtools-*` 系列 Agent Notes。
