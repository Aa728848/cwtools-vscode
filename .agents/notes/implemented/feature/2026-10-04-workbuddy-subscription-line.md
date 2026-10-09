# Agent Note: 接入 WorkBuddy / CodeBuddy 订阅线路

Status: implemented

## Problem

腾讯 **WorkBuddy / CodeBuddy 订阅**此前完全没有接入。它是一条与用户常用的自定义
OpenAI 兼容线路完全不同的产品：模型由腾讯网关按订阅权益服务，凭据来自 CodeBuddy 桌面端
或官方浏览器授权，且有两个会把请求直接打回 400 的硬约束。

参照实现（`dsh-chatgpt-subscription`）已对该订阅做过实测，本线路把那些结论逐条落地，
而不是从其它 OpenAI 兼容线路推断。

## Decision

### 新增模块

- `client/extension/ai/workbuddy/types.ts`：协议常量与区域规则。
  - Provider id 特意取 `workbuddy-subscription` 而不是 `workbuddy`：后者是用户常用的
    自定义线路名，占用它等于在安装本扩展时覆盖或隐藏用户自己的 API；
  - **区域是凭据属性，不是请求属性**：`*.workbuddy.ai` / `*.codebuddy.ai` 走国际区
    `https://www.<apex>`，其余走国区 `https://copilot.tencent.com`；
  - `convergeWorkBuddyEffort`：把目录声明的默认档收敛到最近的标准档，**并列时向上取**
    （与姊妹 Kimi 线路对 `medium` 的映射一致）；无法识别的档位排在中间档而不是极值，
    因此永远不会静默选中最便宜或最贵的一档。
- `client/extension/ai/workbuddy/credentials.ts`：桌面扫描、托管存储与原子写回。
  - 桌面账号**只读优先**：仍在有效期内原样使用；
  - 续期后把新的 `auth` 块**原子写回原文件**（临时文件 + rename），只改 `auth`，其它字段
    原样保留。桌面端的 refresh token 会轮换，只写进本插件自己的存储会让 IDE 手里剩一个
    已作废的 token 并掉线；
  - **桌面账号不可删除**：`removable` 只对托管账号为 true，桌面账号只能在本扩展中隐藏。
- `client/extension/ai/workbuddy/client.ts`：网关请求、令牌续期与浏览器授权。
  - 身份头是网关门控的一部分（`x-user-id`、`x-enterprise-id`、`x-tenant-id`、
    `x-domain`、`x-product`、`x-ide-name`、`x-requested-with` 与 CLI User-Agent）；国际区
    额外要求匹配的 `Origin`/`Referer`，缺它直接 401；
  - **凭据在身份确定之后才落盘**：浏览器授权只回 `auth` 块、不说这是哪个账号，先存后改
    正是「同一账号被存成两条记录」的成因。
- `client/extension/ai/workbuddy/modelCatalog.ts`：`/v3/config` 实时目录。
  - `/v1/models` 在这条线路上是 404，所以**不能**走通用发现；
  - 逐模型读取真实上下文上限、输出上限、图片支持与思考档位，不做按模型名猜测；
  - 区分**默认服务长度**（`contextWindow.defaultLength`）与**模型上限**
    （`maxAllowedSize`）：本线路不发送显式长度参数，所以 DSH 的压缩与溢出判断必须按
    前者计算；
  - 按区域隔离缓存（两个区模型清单不同，跨区发模型返回 400 `code 11102`），失败时保留
    上一次快照而不是清空；快照装载时并入网关服务却不公布的模型；
  - **每一次查询都是「实时缓存优先 → 内置表兜底」**：`resolveWorkBuddyCatalogEntry` 是唯一
    的解析入口，思考档位、默认档与输出上限都从它派生，因此不会出现「卡片按一份表显示、
    请求按另一份表校验」的错位。两个来源都不认识该 id 时返回 `undefined`；
  - 解析出的条目带 `regions`（一次读取只问一个区，故即本次加载的区域）；内置表条目按实测
    标注。
- `client/extension/ai/workbuddy/fallbackModels.ts`：离线内置模型表。
  - `FALLBACK_MODELS`（47 条）**逐字转录**自一次真实的 `/v3/config` 读取，唯一的 id 共
    47 个：含国区 30 个、含国际区 25 个、两区共有 8 个；表里出现过的最小档位词汇是
    low/medium/high/xhigh/max；
  - `UNPUBLISHED_MODELS`（3 条：`gpt-6-sol`、`gpt-6-luna`、`gemini-3.8-flash`）记录网关
    实测服务却不在 `/v3/config` 里公布的模型。这三个 id 在 `FALLBACK_MODELS` 里已有同名
    条目且数值一致，因此按 id 去重后总量仍是 47；重复声明是为了让「未公布」这一事实单独可见；
  - 有 14 个条目的 `defaultReasoningEffort`（`medium`）**落在自己的档位表**
    （`low`/`high`/`max`）**之外**，这是网关用更宽词汇表命名默认档的真实行为，不是笔误。
    表里原样保留，由 `resolveWorkBuddyModelEntry` 在**读取时**用 `convergeWorkBuddyEffort`
    收敛。若把 `medium` 原样当默认档送出去，档位解析会丢弃它、请求不带 `reasoning_effort`，
    而这条线路在不带该字段时返回**空的 reasoning_content**；
  - 7 个非思考模型（`default-model`、`default`、`deep-model`、`glm-5.0`、`glm-4.7`、
    `glm-4.6`、`hunyuan-chat`）档位表为空，必须退化成**没有控件**而不是空选项的下拉；
  - `builtinWorkBuddyModelsForRegion(region)`：按区域过滤，`undefined` 表示区域未知，
    返回**两区并集**；
  - `withUnpublishedWorkBuddyModels(catalog, region)`：把未公布模型并入实时目录，已公布的
    条目永远优先，只填负载没提到的 id；
  - `DEFAULT_VISIBLE_MODEL_IDS` 以 `glm-5.3` 领头，它是**两区都服务**的旗舰，因此也是
    内置的 `defaultModel`。
- `client/extension/ai/workbuddy/accountStatus.ts`：设置卡片的本地汇总，只输出计数与标志，
  凭据材料不进入 webview。

### `aiService.ts`

- **两条硬约束在 `sanitizeRequest` 里保证**：`stream: true`（`stream:false` → 400
  `code 11101`），以及首条消息必须是 system（国际区缺它 → 400 `code 11128`）。调用方没给
  系统提示时补一条中性 system，而不是发出一个已知会被拒的请求。
- 凭据解析在 `chatCompletion` 里做一次：bearer 与身份头**必须来自同一个账号**，因此身份头
  存在实例字段上、由两个 OpenAI 兼容请求构造器读取，调用方签名不变。
- API Key 槽位对这条线路**刻意不读**：一个陈旧的 Key 不该被发到订阅后端。

### 思考档位与模型清单的来源

- `getModelReasoningCapability`（`providers.ts`）为 `workbuddy-subscription` 增补分支：
  档位表来自上面那个唯一解析入口，**只保留 `ReasoningEffort` 合法值**；
  `canDisableThinking === true` 时才把 `'none'` 放进选项（网关对不支持的档位答
  400 `code 11150`）；`defaultValue` 取目录声明的默认档（读取时已收敛，因此必定落在
  自己的选项里——否则 `normalizeReasoningEffort` 会静默落到第一项，控件看起来有值却不生效）；
  档位表为空时返回 `NO_REASONING`，控件隐藏。
- `chatSettings.ts` 用 `workBuddyCatalogForSettings(region)` 取清单：实时目录命中就用它
  （并并入未公布模型），否则**按区域过滤内置表**；区域未知（未登录）时给**两区并集**。
  上下文窗口映射同样覆盖内置表条目。卡片默认模型跟着 `DEFAULT_VISIBLE_MODEL_IDS` 走，
  否则下拉第一项会变成网关自己的路由别名（`default` / `default-model`）。
- `providers/models/defaults.ts` 给该线路的 `defaultModel` 填 `glm-5.3`；`models` 保持
  空数组，由运行时目录与内置表填充。空 `defaultModel` 会让未登录时连一次请求都构造不出来。

### 设置面

卡片支持国区/国际区浏览器登录、重新扫描桌面账号与账号列表展示（区域、来源、有效性）。
协议链为 `webviewProtocol.ts` 的 `workbuddyLogin`/`workbuddyRefreshAccounts`、`types.ts`
的 HostMessage 与 `settingsData.workbuddyAccount`、`bridge.ts` 分发、`chatPanel.ts` 的按钮
绑定与状态渲染。

### 回归测试

新增 `client/test/unit/workbuddyBuiltinCatalog.test.ts`（9 例）：内置表总量与两区计数
（47 / 30 / 25 / 8）、区域过滤与并集、未公布模型的并入与去重、读取时收敛默认档、设置清单的
内置表兜底与实时优先、离线上下文窗口与输出上限、无缓存时按内置表校验档位（合法档位原样、
非法档位落回默认档、未知模型返回 `undefined`）。`providerThinkingParams.test.ts` 另加 2 例，
覆盖 `getModelReasoningCapability` 的新分支与「每个内置模型都有一个可用控件」。

新增 `client/test/unit/workbuddySubscription.test.ts`（30 例）：区域/后端/续期来源映射、
档位收敛（含并列向上与未知档位居中）、凭据解析与身份键、托管存储的合并与损坏容忍、
桌面扫描只认 `*.info`、原子写回保留其它字段、网关身份头与国区/国际区差异、令牌续期合并
与轮换保留、登录轮询的 pending 语义与两种信封、身份先解析后保存、新登录取消旧登录、
目录解析（默认服务长度 vs 模型上限、图片工具跳过、档位收敛）、区域隔离与失败保留、
卡片汇总的 `removable`/`hidden`/`available`。

## Alternatives considered

1. **复用 `workbuddy` 作为 Provider id**：否决。那是用户常用的自定义线路名，占用它会覆盖
   用户自己的 API；参照实现也特意分开。
2. **把区域当成请求参数**：否决。区域是凭据属性，模型清单与额度都跟着账号走；当成请求
   参数会让模型选择器无法按当前账号过滤，跨区请求直接 400。
3. **沿用通用 `/v1/models` 发现**：否决（实测 404）。该端点的模型清单在 `/v3/config`。
4. **用目录的模型上限做上下文窗口**：否决。本线路不发送显式长度参数，按上限计算会让
   请求越过后端实际接受的窗口；必须用目录声明的默认服务长度。
5. **把 `{ effort }` 当成单档表**：否决。那只是默认值；实测这类模型接受
   `low`/`high`/`max`，按单档表开放会拒掉用户显式选择的档位。
6. **档位收敛时并列向下取**：否决（实现中发现的偏差）。参照实现实测并列向上，向下取会
   改变网关本来会选的思考深度。
7. **桌面账号续期后只写本插件存储**：否决。桌面端 refresh token 会轮换，不写回会让 IDE
   掉线。
8. **允许删除桌面账号**：否决。那是 IDE 的凭据文件；本扩展只提供隐藏。
9. **先存凭据再补身份**：否决。这正是同一账号出现两条记录的成因。
10. **未登录时让模型列表为空**：否决（本次修正）。空清单会让模型下拉没有任何选项，用户连
    自己能调用哪个模型都看不到；而区域未知时只给一区同样不行——两区清单不是包含关系
    （国区独有 `glm-5.1`/`deepseek-v4-pro`/`kimi-k2.5`/`hy4-preview-f`/`space-bunny`/
    `minimax-*`，国际区独有 `gpt-6-*`/`gemini-*`/`kimi-k3`/`deepseek-v4.1-flash-sg`），
    只给一区会让另一区的账号在登录前看不到自己唯一能用的模型。因此区域未知时给**两区并集**，
    一旦能确定区域就按该区域过滤。
11. **内置兜底表只抄一份精简子集**：否决。选择器与请求路径共用同一张表，裁剪会让某些模型在
    网关读不到时凭空消失；而且「未公布但可服务」的模型只有全量转录才认得出来。
12. **把内置表的 `medium` 默认档改成 `high` 写死**：否决。那会让转录不再逐字对应网关的
    声明，下一次核对时无法分辨「网关就是这么写的」与「我们改过」。收敛放在读取时。
13. **未知模型沿用调用方给的档位**：否决（本次修正）。内置表与实时目录都不描述的 id 没有
    可校验的档位集合，把任意取值原样发出去正是 400 `code 11150` 的成因。未知模型返回
    `undefined`，由调用方省略该字段。

## Consequences

- 用户既可以直接使用 CodeBuddy 桌面端已登录的账号（只读复用），也可以通过官方浏览器
  授权新增一个；两种来源在同一套凭据形状下工作。
- 桌面账号的续期会原子写回原文件，桌面端不会因为本扩展而掉线；删除只对托管账号开放。
- 模型清单、上下文窗口、图片支持与思考档位都随当前账号的区域从网关读取，新上架模型
  无需改代码；**未登录或网关不可达时**这些都由内置表回答，因此设置页在登录之前也是可用的。
- 思考深度控件在该线路上可见：档位表来自网关目录（离线时用内置表），只有网关声明可以
  关掉思考的模型才会出现「关闭思考」这一档。
- 网关服务却不公布的模型（`gpt-6-sol`、`gpt-6-luna`、`gemini-3.8-flash`）在实时目录
  加载后仍然可选。
- 请求始终是流式且首条为 system，因此不会触发该网关的两条 400。
- 令牌只进 VS Code SecretStorage 与桌面端自己的文件，不进设置文件、不进 webview。
