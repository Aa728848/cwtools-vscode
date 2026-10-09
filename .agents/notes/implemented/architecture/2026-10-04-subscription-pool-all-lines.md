# Agent Note: 号池接入全部订阅线路与设置页草稿保护

Status: implemented

## Problem

多账号号池内核（`pool/accountPool.ts`）此前只接了 Antigravity。其余六条线路仍是单账号：
`codex-chatgpt`、`kimi-code-plan`、`workbuddy-subscription`、`minimax-code`、
`claude-subscription`、`commandcode`（静态 API Key）。

后果与接入 Antigravity 之前相同：一个账号撞到 429 就是整轮失败；想同时用两个账号只能
手工来回登录；一个被撤销的令牌会让用户以为整条线路不可用。

直接为六条线路各写一份适配器是不可取的——它们的差异其实很小（身份键、别名、续期调用、
失败分类），而共享的规则（旧凭据迁移、主账号镜像、存储形状、容错）占了绝大部分代码。
重复六遍必然漂移。

## Decision

### 新增 `pool/oauthAccountPool.ts`：通用「OAuth 凭据号池」工厂

把 `AccountPoolCore` 的钩子收敛成一份**规格**，各线路只交规格。工厂统一处理三件容易写错
的事：

- **旧单凭据迁移**：号池建立前的那份凭据被投影为主账号，升级不再是「什么都没了」；
- **主账号镜像**：主账号同步回单凭据槽位，让仍读旧槽位的路径继续工作；
- **存储边界**：号池存在 SecretStorage 里，那里只有字符串，因此 `parseOAuthPoolData` 在
  边界上解开 JSON。不这样做的话号池会永远读成空池。

### 新增 `pool/subscriptionPools.ts`：各线路的凭据解析与身份键

| 线路 | 身份键 | 随凭据一起进池的线路属性 |
| --- | --- | --- |
| `claude-subscription` | uuid → email | scopes（`user:inference` 是「这是不是订阅凭据」的判据） |
| `minimax-code` | 桌面记录槽 → 来源文件 | **区域**（模型清单与端点都由它决定） |
| `workbuddy-subscription` | uid → uin → 域+昵称 | **域、后端、区域**（跨区发模型是 400） |
| `kimi-code-plan` | 令牌 userId → email | expiresIn |
| `codex-chatgpt` | accountId（套餐/工作区边界） | — |
| `commandcode` | userId → email → key 名 | —（静态 Key，无到期、无续期） |

共同的取舍：**身份键不是令牌**。令牌每次轮换都会变，用令牌做键会在每次续期后把同一账号看成
新账号并产生幽灵行。凡是凭据里有稳定账号标识就用它；没有时回落到线路自己的记录槽身份，
仍不可用则返回 undefined（此时每次登录视为独立账号，是诚实的降级）。

### 新增 `pool/poolRegistry.ts`：provider → 号池注册表

- **惰性建池**：只有真正用过某条线路才为它建池，避免启动时为六条线路各读一次安全存储；
- **幂等 seed**：自带桌面账号的线路（MiniMax Code、WorkBuddy）在**账号选择之前**把凭据并入
  池子。来源有**两个**——桌面端文件扫描 + 本插件托管存储——只扫桌面会让一个纯托管登录态
  留在池外（卡片显示着它，池却读成空，号池区就此隐藏，且该账号从不参与调度）；
  seed 失败只记日志，不让选择失败；
- **别名 id 共用一个池**：`poolId` 让指向同一份凭据的两个 provider id（Command Code 的两条
  线路共用一把 Key）落到同一个池实例上。各自建池会得到两个内存文档与写队列却写同一槽位，
  后写的那次会丢掉前一条线路刚加的账号；
- **`providerIds()`**：对外枚举本注册表覆盖的线路，供设置页一次取全部线路的池；
- **一个池子里同一个账号只能有一行**：`read()` 按去重键收敛重复行，主账号标记转移到留下的
  那一行，粘性策略记的 `activeAccountId` 若指向被合并掉的行则清除。这条规则同时**修复旧
  文档**：在身份键还不完整的版本里写下的重复行，会在下一次写入时被自动合并。
- 统一暴露 select / recordUsage / noteRateLimited / noteAuthFailure / listAccounts /
  strategy / setPrimary / clearCooldown / addAccount / removeAccount / providerIds。

Antigravity 也改为复用同一工厂，删掉了它自己那份等价实现。

### 请求路径

- **OpenAI 兼容流式路径**（覆盖 Kimi、WorkBuddy、MiniMax、Command Code）：429 时冷却当前
  账号并**换一个账号重放同一请求体**；`Retry-After` 被解析（秒或 HTTP 日期两种写法）并夹到
  10 分钟上限；
- **Responses 路径**（Codex）：429 走同一套换号；401 仍是「强制续期一次再重放」；
- **Claude 路径**：401 的强制续期带上「排除当前账号」，因此账号 A 的凭据真的死了时，池会
  把它停用并交出账号 B；
- **登录/登出**：每个 OAuth 登录完成后把账号并入池子（去重键让重复登录变成原地重新授权）；
  Command Code 的 Key 也可入池，静态 Key 没有续期函数，但轮转、冷却与吊销停用仍生效。

### 设置面

新增通用「账号池」区块（对任何已接池的线路生效）：策略选择器（顺序耗尽 / 轮询 / 粘性）+
账号行（主账号标记、冷却倒计时、失效提示），以及「设为主账号」/「清除冷却」/「移除」。
凭据材料不越过 Webview 边界——行里只有别名、路由状态与到期时刻。

### 设置表单是草稿

设置页的整张表单是一个**未保存草稿**：`settingsFormSignature()` 与 `settingsFormBaseline`
（`client/webview/chatPanel.ts`）判定「有没有未保存改动」，账号状态与草稿的基线是分开的两回事。
`showSettingsPage` 的调用者因此分成两类，由 `keepDraft`
（`!reloadForm && !settingsSavePending && settingsHasUnsavedDraft()`）在**同一处**判定：

- **可以丢草稿**：保存（`saveSettings` 置 `settingsSavePending`）、撤销（"Discard"）、首次打开
  设置页（这两处调用点传 `reloadForm = true`）。这一路照旧从 `current` 整体重建表单，并在末尾
  重新取基线。`reloadForm` 是**显式**信号而不是「有没有草稿」的推论：撤销按钮正是在用户有草稿
  时才按的，靠推论会让它变成空操作；
- **不能丢草稿**：其余每一次 `settingsData` 推送。登录完成、刷新账号、签到、号池变化都会调用
  `buildAndSendSettingsData(true, ...)`，**一次推送同时带来账号状态与已保存配置**，而账号状态
  只是又一份待展示数据。这一路**只**重画账号状态：短路的提前 `return` 位于全部表单字段写入之前，
  于是 provider 下拉、endpoint、model、上下文、档位、草稿基线一律原样保留，也不重取基线。

两条由此得出的规则：

1. **重画账号状态必须按「下拉框当前值」而不是已保存的 provider 进行**。短路分支因此调用
   `updateApiKeyStatus(selectedPoolProviderId() || savedProviderId, providers)`；否则用户在下拉里
   选中 B 线后登录，会看到 A 线的账号卡片亮起「已登录」。各线路分支内的
   `setAddAccountControl` / 账号状态 HTML 也就只作用于正在看的那条线路；
2. **仅被表单编辑的字段才受草稿保护**。inline 补全与工具调用路由是**已保存偏好**而非
   draft 字段（保存时从 DOM 读回，打开设置页时也由 `current` 重画并写回 DOM），所以草稿保护要
   把 inline provider / inline model / translation provider / translation model 的当前值**跨重建
   读回并复原**；`#settingsProvider` 的选项集合则照旧按最新的 provider 数据重建（它的取值来自
   `current`），**只有选中项**遵循草稿；草稿选中的线路真的消失时回落到已保存线路。
   由此 `updateTranslationModelSelect` / `updateInlineProviderSelect` / `updateInlineModelSelect`
   提到模块级并显式接收 `providers` / `ollamaModels` / `savedProviderId`，不再从 `showSettingsPage`
   的闭包里隐式取当前配置。

三条必须一起遵守的渲染约束：

1. **一次推送带上全部线路的池**（`subscriptionPools`，按 provider id 归类，而非单个
   `subscriptionPool`）。设置表单是**草稿**：用户可以切换 provider 下拉框而不保存，只推送
   已保存 provider 的池会让号池区停留在上一条线路上（表现为「切换供应商时号池卡在前一个」）。
   后台刷新（快捷换模型）只取当前线路，不必为七个池各读一次安全存储；
2. **区块在每条线路的分支之前渲染**。各线路分支拿到状态后普遍提前 `return`，放在某一条分支
   之后会让它只在部分线路上可达（Codex 分支就是提前返回的，通用区块曾因此对 Codex 永不可见）；
3. **池动作按「正在看的线路」而非已保存的 provider** 执行。策略/主账号/清除冷却/移除这几条
   消息因此都带上 `providerId`，否则用户在草稿里改的是 A 线，改动的却是已保存的 B 线。

区块只在**该线路账号数为 0** 时隐藏：1 个账号也照常显示，好让用户知道它在参与调度。

### 账号额度的展示

每个账号行下面画它自己的额度。额度是**非机密的账号事实**（能随号池摘要过 Webview 边界），
但它是**展示数据而不是路由状态**：不进号池文档、不影响可调度性，读取失败只让这一行没有数字，
绝不把账号停用。

- **按需读取**：额度要打上游请求，因此在区块真正上屏后才问一次（`requestSubscriptionPoolQuota`），
  而不是随每次设置刷新一起取，也不与账号摘要捆绑；
- **按账号缓存与单飞**：缓存键是账号身份，否则切换账号会拿到上一个账号的数字；
- **各线路自己的面**（均在参照实现里实测过）：

| 线路 | 额度面 | 备注 |
| --- | --- | --- |
| `workbuddy-subscription` | `POST /billing/meter/get-user-resource` | `data.Response.Data.Accounts[]`；多套餐**求和**；容量与周期计数是两套独立数字，各成一个仪表 |
| `kimi-code-plan` | `GET {coding}/v1/usages` | coding 主机（非 OAuth 主机）；兼容 `usages{}` 与 `usage`+`limits[]` 两种形状 |
| `claude-subscription` | `GET /api/oauth/usage` | `utilization` 在这个面上是 **0-100 的百分数**（响应头里同名字段是 0-1） |
| `codex-chatgpt` | 复用账号状态里的 `rateLimits` | 不额外发请求 |
| `commandcode` | 复用账号状态（`/alpha/billing/credits` 等） | 额度**按 Key** 记账；只报余额时就画成数值 |
| `minimax-code` | `GET /v1/api/openplatform/coding_plan/remains` | **只带 bearer**：不伪造官方客户端的 `yy`/`x-signature` 第一方标记（冒用官方应用是封号理由） |

`pool/quotaWindows.ts` 把各线路的形状收敛成统一仪表，其中**比例缺失但报金额**的窗口仍然产出仪表
（画成数值）：一个只报余额的额度是真实事实，丢掉它会显示成「什么都没有」。

### 回归测试

新增 `client/test/unit/subscriptionPools.test.ts`（24 例）：工厂的文档解析与坏行跳过、
静态 Key 线路永不触发续期、过期即轮换并保留账号行、**并发续期单飞**、**`expiresAt: 0` 视为
已过期**、旧单凭据投影、六条线路的身份键与线路属性（含 WorkBuddy 必须带域）、失败分类只认
认证类 4xx、注册表的惰性建池与复用、排除已尝试账号后**确实换到另一个账号**、429 冷却后绕行、
失效停用但保留行、**seed 幂等**、策略与主账号切换、摘要绝不含凭据。

`client/test/unit/poolSeeding.test.ts`（3 例）：**仅托管来源**的账号能进池并被选中、两来源合并
不重复、重复登录原地更新。测试桩必须**真的持久化**——一个空写入的桩会让每次读池都成空池，
从而掩盖被测缺陷。

`client/test/unit/poolRegistry.test.ts`（4 例）：`poolId` 使**别名 id 共用一个池实例**（否则
后写覆盖先写）、未声明 `poolId` 的线路**各自独立**（WorkBuddy 账号不得被 MiniMax 选中）、
`providerIds()` 枚举、别名线路只 seed 一次。

`client/test/unit/subscriptionQuota.test.ts`（11 例）：WorkBuddy 账单的嵌套形状与多套餐求和、
容量与周期各成一个仪表、无时区周期时间按本地时间解析、只有余额的额度画成数值而不编造比例、
边界校验丢弃无名称的仪表并夹取比例。

`client/test/unit/settingsPageDraft.test.ts`（6 例）：设置页草稿保护。测试**不复制被测逻辑**——
它用 TypeScript AST 从 `client/webview/chatPanel.ts` 里把 `showSettingsPage` 与
`settingsFormSignature` / `settingsHasUnsavedDraft` / `renderSettingsProviderOptions` 的原函数体
取出来，配一套最小 DOM 桩直接执行，因此断言的是随包发布的那条渲染路径。用例覆盖：草稿线路在
带账号状态的 `settingsData` 重渲染后仍然是下拉框的选中项、账号状态按草稿线路重画（区分不同线路
的账号卡片）、未改过 provider 时仍跟随已保存线路、保存后表单切换为已保存值且重取基线、
provider 数据变化时选项集合更新而草稿选中项保留、草稿线路消失时回落到已保存线路、显式重载（撤销 / 打开设置页）确实丢弃草稿。

## Alternatives considered

1. **为每条线路各写一份适配器**：否决。差异很小而共享规则很多，重复六遍必然漂移；
   工厂让差异集中在一处，可以被读出来。
1b. **把「账号状态」从设置页签名里拆出去，签名不变就只重画账号区**：否决。签名里
   `providers` / `current` / `ollamaModels` 都会随真实变化（拉取到模型目录、别处切换线路）
   而变，签名相等只覆盖很小一部分刷新；据此分流会让「该重画却没重画」的路径变多。判定
   「这次能不能丢草稿」的正确依据是**用户有没有草稿**，与账号状态怎么变无关。
1c. **把「撤销」也交给 `settingsHasUnsavedDraft()` 推断**：否决。撤销按钮正是在有草稿时才按，
   靠草稿存在来推断「这次要重建表单」会让撤销什么都不做；重载意图必须由调用点显式声明。
1d. **在完整重渲染后显式复原全部草稿字段**：否决。要复原的字段清单会随表单增长而腐化，
   而且 `settingsFormBaseline` 在重渲染开头被置空，复原时还得连着基线语义一起伪造；
   与其枚举所有字段，不如不进入那段代码。
2. **把线路特有的凭据字段丢掉，只存 token**：否决。区域、域、scope 都是**凭据属性**，
   丢掉它们会让请求发错区/失去订阅判据。
3. **用令牌做身份键**：否决。令牌每次轮换都变，会产生幽灵账号。
4. **让 seed 在每次选择时都跑**：否决。会反复扫描磁盘；改为每个池子一次，并把进行中的
   seed 单飞，避免并发选择各扫一遍。
5. **静态 Key 线路不接池**：否决。轮转、429 冷却与吊销停用对一个多 Key 的账号同样有用；
   只是没有续期函数，内核据规格自然跳过续期。
6. **把 429 换号放在各线路自己的调用点**：否决。两条请求路径（OpenAI 兼容流式、Responses）
   已经覆盖全部线路，放在那里即一次到位，也保证规则一致。

## 修复的真实缺陷（接入多账号时暴露）

1. **续期单飞是全局的，不是按凭据的**（Codex 与 Claude 的 store 各有一处）。单账号时无害，
   一旦池里有第二个账号，账号 B 会拿到账号 A 的续期 promise 并**收到 A 的凭据**。
   两处都改为按 refresh token 归类；Codex 的池内续期还改为**不写单凭据槽位**（否则池里当前
   账号的轮换会覆盖另一个账号）。
2. **`expiresAt: 0` 被误读为「永不过期」**。epoch 0 是**过去**，而 Antigravity 的测试凭据
   正是用 0 表示已过期；误读会让一个死令牌继续服役（实测表现为：并发用例拿到的仍是旧 token）。
   改为只把「未声明到期」视为不过期，声明的到期时刻按绝对时间比较。
3. **seed 漏掉托管存储**（经用户实机截图定位）。WorkBuddy / MiniMax Code 的 seed 只扫描
   桌面端文件，于是「只用本插件登录过」的情形读出**空池**：卡片照常显示该账号，号池区却
   隐藏，且该账号从不参与调度。改为两个来源合并（桌面扫描 + 托管存储），按身份键去重。
4. **设置面只推送已保存 provider 的池**（同一轮实机反馈）。用户在未保存的表单里切换 provider
   时号池区停在上一条线路上；改为一次推送全部线路，并按**下拉框当前值**取用。
5. **Codex 登录不入池**。其余五条线路在登录回调里 `addAccount`，Codex 只写单凭据槽位，因此
   第二个 ChatGPT 账号存下来了却永远无法参与轮转。补上登录后入池的回调。
6. **Codex 的号池区永不可见**：区块渲染调用位于 `isCodex` 分支的提前 `return` 之后。
7. **登录完成把用户未保存的 provider 选择冲掉**。签名里混了「账号状态」与「表单/当前配置」
   两类输入，于是只改变账号状态的一次推送也会让签名变化并走完整重渲染，从 `sel.innerHTML` 起
   把整张表单按 `current` 重置回已保存线路——用户在下拉里选中 B 线登录，界面跳回 A 线。修复即
   上面的「设置表单是草稿」：重画账号状态与重建表单分开，且账号状态按当前下拉值重画。
   只修下拉框的选中项是不够的——那样 endpoint / model / 上下文 / 档位会停留在已保存线路的值，
   表单会**自相矛盾**。
8. **模型目录拉取后重建选项集合会丢掉草稿**：`apiModelsFetched` 就地更新
   `settingsProviders` 的 `models` 并调用 `updateModelUI`，但下一次 `settingsData` 会带着
   **新的 models 数组**回来，签名因此变化并触发整体重建。草稿保护把「选项集合跟着 provider
   数据走、选中项跟着草稿走」拆开，这一条与上一条同因。

## Consequences

- 六条线路全部支持多账号：三种调度策略、429 冷却换号、账号级失效保留、设为主账号与清除
  冷却；静态 Key 线路同样支持轮转与吊销停用。
- 一条线路的池子损坏或超限不影响另一条：每条线路一份独立文档。
- 桌面端账号与插件账号在同一个池里参与调度；重复登录原地更新而不产生幽灵行。
- 摘要只含非凭据信息，卡片拿不到凭据材料。
- 设置页按**当前选中的供应商**显示号池，切换下拉框立即跟随（无需先保存）；池动作也只作用于
  该线路。
- 账号状态刷新（登录、刷新、签到、号池变化）**不再改动用户未保存的表单草稿**：下拉框、各字段与
  「有未保存改动」提示都原样保留，而账号卡片仍按当前选中的线路即时更新。
- 表单的草稿判定只有一处（`keepDraft`，基于 `reloadForm` / `settingsSavePending` /
  `settingsHasUnsavedDraft()`），且「有未保存改动」的判定复用同一个签名函数，两处不会漂移。
- 页面显隐收进 `presentSettingsPage(shouldShow)`（打开/重建与关闭共用一份实现），
  `showSettingsPage` 本身**不再直接增删 `settingsPage` 的 `active` 类**：草稿短路分支只重画账号区，
  不重新布局整张页面。
- WorkBuddy 的模型下拉框由网关 `/v3/config` 的实时目录填充（内置表不列该线路模型）；读取
  失败保留上一次快照而不是清空。
- **登录控件在有账号之后仍然可用**（改称「再添加一个账号」）：此前它被隐藏，使得一个账号
  登录之后**再也加不了第二个**，多账号在这几条线路上实际不可达。WorkBuddy 与 MiniMax Code
  本来就没隐藏，因此只有它们能加第二个账号。
- 号池的每行下方显示该账号的额度（能读到才显示；读不到就只是没有数字）。
- 额度读取失败**不是**凭据失败：它只让这一行没有数字，绝不写任何东西、也不让账号退出轮转。
- MiniMax 的**每日签到**刻意未做：该网关拒绝不带官方第一方签名头的请求，而同一项目在额度
  读取上选择不伪造第一方身份。属产品决策，需用户拍板。**WorkBuddy 的签到已实现**（用诚实请求头）。
- 额度与图片预算是**按线路**的，不是一条通用上限：各线路的额度互不通用，一刀切会拒绝掉
  其它线路上的合法请求（见 `requestImageBudget.ts` / `subscriptionFailure.ts`）。
- 线路的**身份键必须覆盖它的每一条来源**：WorkBuddy 从令牌 claim 回填 uid（资料端点是
  best-effort），Kimi 同样只有令牌里的身份。身份键缺失时 seed 行与登录行无法互认，一个账号
  会被存成两行。
- 单次使用的 refresh token 需要**按 token 单飞 + 拒绝墓碑**（MiniMax）：并发轮换会让除第一个
  之外全部拿到 `invalid_grant`，读起来像账号被吊销。
- **仍未做的**：真机验证。所有线路的 OAuth 流程与多账号轮转都由单元测试（mock transport）
  锁定契约，尚未在真实订阅账号上端到端跑过。
