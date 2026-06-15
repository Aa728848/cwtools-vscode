# cwtools-mcp

为 CWTools 语义化 Mod 制作辅助提供的 MCP 服务器。

## 随 VS Code 扩展一同发布

打包后的构建会作为单个自包含文件捆绑进扩展。扩展在激活时还会将其复制到 globalStorage
中的一个**与版本无关的稳定路径**，这样外部 agent 就能指向一个会随扩展更新持续生效的位置，
无需修改版本号：

```
# 稳定路径（推荐——跨版本永不变化）：
<globalStorage>/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs
#   Windows: %APPDATA%/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs
#   macOS:   ~/Library/Application Support/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs
#   Linux:   ~/.config/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs

# 带版本号的路径（位于扩展目录内，每次发布都会变化）：
<vscode-extensions>/eddy.eddy-stellaris-cwt-<version>/bin/mcp/cwtools-mcp.cjs
```

外部 agent 用 `node` 运行它。它会自动探测已安装扩展的服务器二进制文件
（`bin/server/<platform>/CWTools Server`）、解压出的规则以及 globalStorage 中的原版缓存
——因此无需开发环境检出，也无需额外参数。它是**只读**的：文件写入交由宿主 agent 自身的环境处理。

## 用法

Stdio 传输（开发环境检出）：

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --stdio
```

可流式 HTTP 传输：

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --http --host 127.0.0.1 --port 3000
```

HTTP MCP 端点为 `/mcp`；在 `/healthz` 提供了一个轻量级健康检查。

## 原版游戏数据

CWTools 的语义结果会将你的 Mod 与**原版游戏缓存**结合。没有它，服务器仍可运行，但结果仅限
Mod 自身：原版 ID 不会出现，且 Mod 中对原版定义的引用会被报告为未定义错误。请提供以下之一：

```sh
# 从原版安装目录构建缓存（首次运行较慢，之后会缓存）
cwtools-mcp --workspace /path/to/mod --game stellaris --game-path "/path/to/Stellaris"

# 复用预构建的 <game>.cwb 缓存目录（例如 VS Code 扩展的 globalStorage/.cwtools）
cwtools-mcp --workspace /path/to/mod --game stellaris --cache "/path/to/.cwtools"
```

当目录同时包含 `<game>.cwb` 缓存和解压出的规则时（正如 VS Code 扩展的 globalStorage），
单独使用 `--cache` 即可；`--game-path` 仅在需要从零构建缓存时才需要。

如果两个参数都未给出，MCP 会**自动探测 globalStorage 中的 VS Code cwtools 扩展缓存**
（`Code`/`Code - Insiders`/`VSCodium`/`Cursor`）并复用它——所以只要你在扩展中至少打开过一次
该项目，就无需任何缓存参数。

当找不到任何缓存时，依赖原版的工具结果会带上 `vanillaCache.available = false` 以及一条警告，
这样客户端就不会把仅含 Mod 的答案当作完整答案。

## 规则来源

默认情况下，MCP 直接读取已安装扩展拉取到 globalStorage 中的规则目录。若要覆盖，请用 `--rules` 指向一个规则**目录**：

```sh
cwtools-mcp --workspace /path/to/mod --game stellaris --rules /path/to/rules-dir --stdio
```

优先级：`--rules <目录>` > 已安装扩展拉取的规则 > 开发环境检出（`submodules/…/config`）。

MCP 不使用捆绑的 `*-rules.zip`，也不会解压任何东西——规则必须是真实目录。`--rules` 传入 `.zip` 会直接报错。若以上来源都没有，校验能力将受限（请安装扩展或传 `--rules`）。

## 在 Codex 中使用

Codex 从 `~/.codex/config.toml` 读取 MCP 服务器（`[mcp_servers.<name>]`，与 Codex IDE 扩展共享）。
最快的方式——让 Codex 用一条命令替你添加，指向**稳定的 globalStorage 路径**（无版本号，可在更新后继续使用）：

```sh
codex mcp add cwtools -- node "%APPDATA%/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs" --game stellaris --stdio
```

（macOS/Linux：将路径替换为你所在平台的 `globalStorage` 位置。）你也可以直接让 Codex 自己运行那条
`codex mcp add …` 命令。等效的手动 TOML 配置：

```toml
[mcp_servers.cwtools]
command = "node"
args = [
  "C:/Users/<you>/AppData/Roaming/Code/User/globalStorage/eddy.eddy-stellaris-cwt/mcp/cwtools-mcp.cjs",
  "--game", "stellaris",
  "--stdio",
]
startup_timeout_sec = 30
tool_timeout_sec = 120
```

使用稳定的 globalStorage 路径意味着扩展更新时配置永不变化（扩展会在激活时把 bundle 重新同步到那里）。
省略 `--workspace` 可分析 Codex 启动服务器时所在的目录（其 cwd）；将 GUI 中的「工作目录」留空，
让它跟随当前打开的项目。在 TOML 中请使用正斜杠。启动一个 Codex 会话并运行 `/mcp`，确认服务器及其
21 个只读工具已连接——服务器还会发送 `instructions`，告诉模型何时使用它们。

依赖加载的结果（类型/作用域/规则/定义/诊断查询）会带有一个 `readiness` 字段。在项目仍在加载期间，
它们会返回 `status: "loading"` 和 `readiness.ready = false`，而不是一个具有误导性的空答案
——请轮询直到 `readiness.ready` 为 true（若有预构建缓存，仅需几秒）。

## 工具

本包暴露了为 CWTools 读取工具、诊断、项目/profile 知识、补全和符号导航生成的 schema，
另外还提供用于本地化和 PDX 块替换的受保护写入工具。
