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
    上一次快照而不是清空。
- `client/extension/ai/workbuddy/accountStatus.ts`：设置卡片的本地汇总，只输出计数与标志，
  凭据材料不进入 webview。

### `aiService.ts`

- **两条硬约束在 `sanitizeRequest` 里保证**：`stream: true`（`stream:false` → 400
  `code 11101`），以及首条消息必须是 system（国际区缺它 → 400 `code 11128`）。调用方没给
  系统提示时补一条中性 system，而不是发出一个已知会被拒的请求。
- 凭据解析在 `chatCompletion` 里做一次：bearer 与身份头**必须来自同一个账号**，因此身份头
  存在实例字段上、由两个 OpenAI 兼容请求构造器读取，调用方签名不变。
- API Key 槽位对这条线路**刻意不读**：一个陈旧的 Key 不该被发到订阅后端。

### 设置面

卡片支持国区/国际区浏览器登录、重新扫描桌面账号与账号列表展示（区域、来源、有效性）。
协议链为 `webviewProtocol.ts` 的 `workbuddyLogin`/`workbuddyRefreshAccounts`、`types.ts`
的 HostMessage 与 `settingsData.workbuddyAccount`、`bridge.ts` 分发、`chatPanel.ts` 的按钮
绑定与状态渲染。

### 回归测试

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

## Consequences

- 用户既可以直接使用 CodeBuddy 桌面端已登录的账号（只读复用），也可以通过官方浏览器
  授权新增一个；两种来源在同一套凭据形状下工作。
- 桌面账号的续期会原子写回原文件，桌面端不会因为本扩展而掉线；删除只对托管账号开放。
- 模型清单、上下文窗口、图片支持与思考档位都随当前账号的区域从网关读取，新上架模型
  无需改代码。
- 请求始终是流式且首条为 system，因此不会触发该网关的两条 400。
- 令牌只进 VS Code SecretStorage 与桌面端自己的文件，不进设置文件、不进 webview。
