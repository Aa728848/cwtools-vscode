# Agent Note: Antigravity 请求图片体积预算

Status: implemented

## Problem

Antigravity（Gemini / Claude）线路接受图片输入，但**没有请求级图片体积上限**。Google 对
带 inline data 的请求有约 20 MB 的上限，而同一个请求体里还要放系统指令、对话文本与工具
声明；图片密集的会话会把请求体一路撑到被 Google 拒收，而**让它失败的那几张图恰好是模型
最不需要的**（最早、最旧的那些）。

参照实现（`dsh-chatgpt-subscription`）已在其 Antigravity 适配器上实现该保护，并有测试
锁定行为。

## Decision

新增 `client/extension/ai/antigravity/imageBudget.ts`：

- `ANTIGRAVITY_MAX_REQUEST_IMAGE_BYTES = 12 * 1024 * 1024`：单个 Antigravity 请求允许
  携带的 base64 图片总量（12 MiB 留出足够余量给同一请求体里的文本与工具声明）。
- `offloadAntigravityRequestImages(messages)`：超出预算时**最旧的图片先被替换**为一条
  **模型可见的占位文本**（`ANTIGRAVITY_OMITTED_IMAGE_TEXT`），措辞与 DSH 自身占位一致，
  并明确要求模型「需要时重新读取文件或请用户重新附上」。
- **只作用于本次请求**：持久历史保持原样，所以下一轮如果仍然需要这张图，它依旧在那里。
- 本来就在预算内时**原样返回**（同一个数组引用），不做任何拷贝。

接线：`aiService.chatCompletion` 的 `antigravity` 分支在调用前对请求消息做一次处理，
被裁剪后的消息同时用于请求体与 Gemini 载荷构造，因此两者不可能不一致。

### 为什么不静默丢弃

被静默省略的图片**比一条说明更难诊断**：没有报错、没有计数，模型是在一个「图根本不存在」
的对话上作答的，而现场没有任何线索指向原因。占位文本让模型知道图缺失，也让用户从回答
里看出发生了什么。

### 流终结校验（本次核对，无需改动）

参照实现把「上游必然以 `finish_reason` 或 `data: [DONE]` 结束，两者皆缺即视为连接中断」
作为保护。本仓库的 `consumeAntigravityResponse` 已有等价校验
（`if (!finish && !doneMarker) throw invalid()`），并且对空响应、块级错误、
`promptFeedback.blockReason` 都有对应分支，因此本次不重复实现。

## Alternatives considered

1. **直接拒绝超限请求**：否决。用户看到的是整轮失败，而实际上只需要放弃最旧的那几张图。
2. **静默丢弃最旧的图片**：否决。比拒绝更糟——模型在一个缺图的对话上作答且现场无线索。
3. **按图片张数而不是字节数限制**：否决。单张图的体积差异极大（截图与照片可差一个数量
   级），张数无法映射到 Google 实际约束的字节上限。
4. **持久化裁剪结果**：否决。会话历史里的图片属于用户数据，且下一轮可能需要它；预算只
   是**本次请求**的约束。
5. **复用参照实现的常量与函数**：否决（架构上不可行）。那是另一个仓库的进程内模块；
   本仓库需要自己的实现与测试。

## Consequences

- 图片密集的会话不再因为请求体过大而被 Google 拒收；超限时最旧的图片被替换为可见占位。
- 常量（12 MiB）是本线路自己的取值，不是从别的线路复制来的数字；若上游约束变化，只需
  改这一个导出常量。
- 流终结校验沿用既有实现，本次核对确认无需改动。
