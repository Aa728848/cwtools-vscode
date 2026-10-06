# Agent Note: Command Code 逐模型能力表

Status: implemented

## Problem

`commandcode` / `commandcode-messages` 的**图片能力与思考档位此前按上游模型族推导**
（`upstreamGatewayCapability`），而不是按模型查表。

这在别的网关上大致够用，在 Command Code 上**不成立**：官方 CLI 自己的模型注册表是
「哪些模型接受图片、各自暴露哪些思考档位」的唯一权威来源，而公开的
`/provider/v1/models` 目录只带 id、显示名与上下文长度，对模态与思考档位**什么都不说**。
参照实现记录了两个具体代价：`deepseek/deepseek-v4.1-flash-fast` 曾在有思考档位的情况下
被当成无档位模型；`gpt-6-sol`、`gpt-6-luna`、`claude-opus-5-5`、`xai/grok-4.7` 等一批模型
同时从选择器里消失。

**同厂商内部就会自相矛盾**，因此前缀判断不可能正确：
`deepseek/deepseek-v4-flash` 纯文本，而 `deepseek/deepseek-v4.1-flash` 与
`deepseek/deepseek-v4-flash-vision-exp` 接受图片；`z-ai/glm-5.3-flash` 接受图片而
`zai-org/GLM-5.3` 不接受。

## Decision

新增 `client/extension/ai/commandcode/modelCapabilities.ts`：转录自官方 CLI 注册表的
**整张表**（85 个模型），以及围绕它的解析函数。

- **能力按精确 id 查表**：未知 id 回落到**纯文本 + 无档位**。方向是刻意选的——DSH 会把
  「不支持图片」变成一个用户可以换模型纠正的可见占位，而「支持图片」的错误会把字节发给
  一个拒绝整个请求的端点；
- **`off` 不逐字带出**：Command Code 把「不思考」写成一个叫 `off` 的档位，DSH 把同一件事
  写成 `none`。`commandCodeReasoningEfforts` 做这个翻译，因此表本身保持对来源的忠实转录；
- **`off` 也不上线路**：OpenAI 族线协议没有这个档位，`commandCodeWireEffort` 把它（以及
  `none`）丢弃，由**省略字段**表达——这正是官方 CLI 在其档位为 `off` 时所做的事；
- **免费档后缀回退**：公开目录列出 `meituan/LongCat-2.0:free`，而注册表写成
  `meituan/LongCat-2.0`。两者是同一个模型，`:free` 只是计费档后缀。查表精确匹配优先，
  未命中才剥掉后缀重试。不这样做的话，用户在选择器里挑中目录那个 id 时会**静默**失去
  图片输入与思考档位，而现场没有任何线索指向原因。

### 接线

- `providers.ts`：`commandcode` 的推理能力改为查表（`commandCodeReasoningEfforts`），
  不再走 `upstreamGatewayCapability`；思考参数规则改为经 `commandCodeWireEffort` 过滤；
- `providers/models/capabilities.ts`：新增 `isModelVisionCapableFor(providerId, model)`，
  对 Command Code 走表、其余走原有的子串表；
- `agentRunner.ts`：视觉能力检查改用该 provider 感知版本。这是图片附件被静默丢弃的那个
  判定点，因此它必须按 provider 取真值。

### 回归测试

新增 `client/test/unit/commandCodeCapabilities.test.ts`：表的完整性（>50 个条目、id 唯一）、
**provider 模型清单与表不漂移**（已发布的模型缺条目就会失去能力）、模态逐 id 判定
（含同厂商对照例）、未知 id 的保守回落、`off`→`none` 翻译且不外泄 `off`、
`off`/`none` 不上线路、免费档后缀回退、上下文窗口转录值。
`providers.test.ts` 的 Command Code 断言改为查表得到的真实值。

## Alternatives considered

1. **继续按模型名族推导**：否决。同厂商内部就自相矛盾，前缀判断无法正确；
   参照实现记录了它造成的具体缺档与缺模型。
2. **只转录用到的模型**：否决。表里没有的 id 不是「未知」而是「没有图片、没有档位」，
   漏一个真实模型就等于静默削掉它的能力。整张表共 85 条，成本可接受。
3. **把注册表的 `off` 原样发出**：否决。OpenAI 族线协议没有该档位，发出去是端点不接受的值。
4. **把 `off` 当作 DSH 的 `none` 直接发出**：否决。`none` 也是由省略字段表达，
   显式发送同样不是官方 CLI 的行为。
5. **要求用户手输 `meituan/LongCat-2.0`（去掉后缀）**：否决。用户是在目录里看到
   `:free` 那个 id 并选中它的；让查表在边界上处理拼写差异比教育用户更可靠。
6. **未知 id 乐观地假定支持图片**：否决。错误方向不对称，见上文。

## Consequences

- 图片输入与思考档位按官方 CLI 注册表逐模型判定；此前被错误归类的一批模型恢复正确能力。
- 未知模型按纯文本 + 无档位处理，是可纠正的降级而不是一个被拒绝的请求。
- `off` 只作为转录事实留在表里，对外一律表现为 `none`，且在线路上由省略字段表达。
- 目录与注册表的拼写差异（`:free`）在查表边界被吸收，不影响用户的选择。
- 回归测试锁定了「provider 模型清单 ⊆ 能力表」，因此以后新增模型时会立刻发现缺条目。
