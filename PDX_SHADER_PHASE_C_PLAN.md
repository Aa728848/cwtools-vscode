# Phase C：PDX Shader Language Server 实施计划

> **前置依赖**：Phase B（TextMate Grammar）已完成并验收。
> **目标**：在 Phase B 的语法高亮基础上，提供智能编辑能力（跳转、补全、诊断、悬浮提示）。
> **预计工作量**：5–8 天
> **优先级**：中（视 Modder 社区反馈决定启动时机）

---

## 1. 功能规划

### 1.1 能力矩阵

| 能力 | 优先级 | 复杂度 | 依赖 |
|---|---|---|---|
| Include 路径跳转 | P0 | 低 | DocumentLinkProvider |
| Effect 内部名称跳转 | P0 | 中 | 自定义 PDX AST |
| ConstantBuffer 变量悬浮提示 | P1 | 中 | 自定义 PDX AST |
| Sampler 变量补全 | P1 | 中 | 自定义 PDX AST |
| Effect 引用补全 | P1 | 中 | 自定义 PDX AST |
| 基础诊断（未定义 Effect 引用） | P2 | 中高 | 跨文件 AST |
| ConstantBuffer 变量补全（HLSL 内） | P2 | 高 | HLSL 嵌入区域分析 |
| Sampler 类型检查 | P3 | 高 | 语义分析 |
| Effect 重命名 | P3 | 高 | 跨文件重构 |

### 1.2 分阶段交付

#### C1：文件级导航（Include 跳转 + 文档符号）— 1–2 天

最小可用集，不需要完整的 AST 解析。

#### C2：文件内智能（Effect/MainCode 跳转 + Sampler 补全）— 2–3 天

需要单文件 PDX AST 解析。

#### C3：跨文件智能（未定义引用诊断 + 变量补全）— 2–3 天

需要工作区级别的符号索引。

---

## 2. 架构设计

### 2.1 总体架构选择

**方案对比**：

| 方案 | 描述 | 优缺点 |
|---|---|---|
| A. 独立 Language Server（LSP） | 用 Node.js/TypeScript 实现独立 LSP 进程 | 标准化但架构重，需要独立进程 |
| B. Extension Host 内联 Provider | 在 Extension Host 中直接注册 VS Code Provider | 轻量，与现有架构一致 |
| C. 扩展现有 F# LSP | 在 CWTools Server 中添加 PDX Shader 支持 | 复用基础设施但增加 F# 维护成本 |

**选择方案 B**：在 Extension Host 中内联实现。

理由：
- PDX Shader 的 DSL 层非常简单（只有十几个关键字），不需要独立 LSP 进程的复杂度。
- 与项目现有架构（Extension Host Provider 模式）一致。
- 可以直接复用 `IndexService` 和文件系统 API。
- 按需加载：只在打开 `.shader`/`.fxh` 文件时激活。

### 2.2 模块结构

```
client/extension/
  shaderSupport/
    shaderParser.ts          — PDX Shader DSL 解析器
    shaderSymbols.ts         — 文档符号提取
    shaderIndex.ts           — 工作区级 Shader 符号索引
    shaderProvider.ts        — VS Code Provider 聚合注册
    providers/
      documentLink.ts        — Include 路径跳转
      documentSymbol.ts      — 文档符号大纲
      definition.ts          — 定义跳转（Effect → MainCode）
      completion.ts          — 补全（Effect 名、Sampler 名、属性值）
      hover.ts               — 悬浮提示（变量类型、Sampler 配置）
      diagnostics.ts         — 基础诊断
      rename.ts              — 重命名（Phase C3）
```

### 2.3 PDX Shader AST 设计

```typescript
// client/extension/shaderSupport/shaderParser.ts

/** PDX Shader 文件的 AST 节点类型 */
export type PdxShaderNodeType =
  | 'File'
  | 'Includes'
  | 'VertexStruct'
  | 'ConstantBuffer'
  | 'ShaderBlock'       // VertexShader = { ... } 或 PixelShader = { ... }
  | 'Samplers'
  | 'SamplerDecl'
  | 'MainCode'
  | 'CodeBlock'         // Code [[ ... ]]
  | 'Effect'
  | 'BlendState'
  | 'DepthStencilState'
  | 'RasterizerState'
  | 'Property'          // key = value
  | 'HlslBlock'         // [[ ... ]] 内容
  | 'StructField'
  | 'PreprocessorDirective';

export interface PdxShaderNode {
  type: PdxShaderNodeType;
  name?: string;                    // 标识符名称
  range: { start: Position; end: Position };
  nameRange?: { start: Position; end: Position };
  children: PdxShaderNode[];
  properties: Record<string, string>;  // 简单属性 key=value
  hlslContent?: string;             // [[ ]] 内的原始 HLSL 文本
  hlslRange?: { start: Position; end: Position };
}

export interface PdxShaderDocument {
  uri: string;
  includes: string[];               // 引用的 .fxh 文件名
  vertexStructs: PdxShaderNode[];
  constantBuffers: PdxShaderNode[];
  shaderBlocks: PdxShaderNode[];     // VertexShader/PixelShader 块
  codeBlocks: PdxShaderNode[];       // 顶层 Code [[ ]] 块
  effects: PdxShaderNode[];
  blendStates: PdxShaderNode[];
  allMainCodes: PdxShaderNode[];     // 从 shaderBlocks 提取的所有 MainCode
  allSamplers: PdxShaderNode[];      // 从 shaderBlocks 提取的所有 Sampler
}
```

### 2.4 解析器策略

PDX Shader DSL 足够简单，**不需要**完整的 lexer + parser 架构。采用**正则驱动的分段解析**：

1. **第一遍**：用正则识别所有 `[[ ]]` 区域，标记为 HLSL 区域
2. **第二遍**：在非 HLSL 区域中，用正则逐行解析 DSL 结构：
   - `^\s*(Includes|VertexStruct|ConstantBuffer|VertexShader|PixelShader|Effect|BlendState|Code|MainCode|...)`
   - 追踪花括号嵌套深度
3. **第三遍**：提取符号表（所有命名实体及其位置）

**性能目标**：`pdxmesh.shader`（4546 行）解析时间 < 50ms。

---

## 3. 分阶段实施详情

### 3.1 Phase C1：文件级导航

#### 3.1.1 Include 路径跳转（DocumentLinkProvider）

```typescript
// providers/documentLink.ts
export class PdxShaderDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    // 匹配 Includes = { "file.fxh" ... } 中的文件名
    // 解析为相对于当前文件所在目录的路径
    // 返回可点击的 DocumentLink
  }
}
```

**匹配规则**：
- 扫描 `Includes = {` 和 `}` 之间的区域
- 提取所有 `"filename.fxh"` 字符串
- 文件路径解析：相对于当前 `.shader` / `.fxh` 文件的目录

**测试用例**：
- 基本跳转：点击 `"constants.fxh"` 跳转到同目录的 `constants.fxh`
- 不存在的文件：显示为不可点击（或提示文件不存在）
- 多个 Include：列表中每个文件都可点击

#### 3.1.2 文档符号大纲（DocumentSymbolProvider）

```typescript
// providers/documentSymbol.ts
export class PdxShaderDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    // 返回层级结构：
    // ├── VertexStruct VS_INPUT          (Class)
    // ├── ConstantBuffer Common          (Struct)
    // ├── VertexShader                   (Module)
    // │   ├── MainCode VertexShaderSimple  (Function)
    // │   └── MainCode VertexShaderBillboard (Function)
    // ├── PixelShader                    (Module)
    // │   └── MainCode PixelShaderStandard  (Function)
    // ├── BlendState BlendState          (Property)
    // └── Effect Simple                  (Event)
  }
}
```

**VS Code Symbol Kind 映射**：

| PDX 元素 | VS Code SymbolKind |
|---|---|
| VertexStruct | `Class` |
| ConstantBuffer | `Struct` |
| VertexShader / PixelShader 块 | `Module` |
| MainCode | `Function` |
| Effect | `Event` |
| BlendState | `Property` |
| Sampler | `Field` |
| Code 块 | `Namespace` |

**好处**：
- 用户可以在大纲视图（Outline）中快速浏览 shader 结构
- `Ctrl+Shift+O` 快速跳转到任意 MainCode/Effect
- `pdxmesh.shader`（4546 行）中有数十个 MainCode，大纲视图至关重要

### 3.2 Phase C2：文件内智能

#### 3.2.1 定义跳转（DefinitionProvider）

```typescript
// providers/definition.ts
export class PdxShaderDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Location | null {
    // Case 1: Effect 块内 VertexShader = "ShaderName"
    //   → 跳转到同文件中 MainCode ShaderName 的定义位置
    // Case 2: Effect 块内 PixelShader = "ShaderName"
    //   → 同上
    // Case 3: ConstantBuffers = { Common, Shadow, ... }
    //   → 跳转到 ConstantBuffer( Common, ... ) 的定义位置
  }
}
```

**需要解析的引用关系**：
- `Effect { VertexShader = "Name" }` → `MainCode Name [[ ... ]]`
- `Effect { PixelShader = "Name" }` → `MainCode Name [[ ... ]]`
- `MainCode ... ConstantBuffers = { Name1, Name2 }` → `ConstantBuffer( Name1, ... )`

#### 3.2.2 补全（CompletionProvider）

```typescript
// providers/completion.ts
export class PdxShaderCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    // Context 1: Effect 块内的 VertexShader = "|"
    //   → 补全所有 VertexShader 块内的 MainCode 名称
    // Context 2: Effect 块内的 PixelShader = "|"
    //   → 补全所有 PixelShader 块内的 MainCode 名称
    // Context 3: MainCode 的 ConstantBuffers = { |
    //   → 补全所有 ConstantBuffer 名称
    // Context 4: Sampler 属性值
    //   → 补全 "Linear", "Point", "Wrap", "Clamp", "Mirror" 等枚举
    // Context 5: BlendState 属性值
    //   → 补全 "SRC_ALPHA", "INV_SRC_ALPHA", "ONE", "ZERO" 等枚举
  }
}
```

**属性值枚举表**：

| 属性 | 可选值 |
|---|---|
| `MagFilter` / `MinFilter` | `Linear`, `Point`, `Anisotropic` |
| `MipFilter` | `Linear`, `Point`, `None` |
| `AddressU` / `AddressV` | `Wrap`, `Clamp`, `Mirror`, `Border` |
| `SourceBlend` / `DestBlend` | `SRC_ALPHA`, `INV_SRC_ALPHA`, `ONE`, `ZERO`, `SRC_COLOR`, `INV_SRC_COLOR`, `DEST_ALPHA`, `INV_DEST_ALPHA`, `DEST_COLOR`, `INV_DEST_COLOR` |
| `BlendEnable` | `yes`, `no` |
| `WriteMask` | `"RED"`, `"GREEN"`, `"BLUE"`, `"ALPHA"`, `"0x0F"` |
| `CullMode` | `none`, `cw`, `ccw` |
| `FillMode` | `solid`, `wireframe` |

#### 3.2.3 悬浮提示（HoverProvider）

```typescript
// providers/hover.ts
export class PdxShaderHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
    // Case 1: 悬浮在 ConstantBuffer 内的变量上
    //   → 显示类型信息
    // Case 2: 悬浮在 Sampler 名称上
    //   → 显示该 Sampler 的完整配置（Index, Filter, Address 等）
    // Case 3: 悬浮在 Effect 名称上
    //   → 显示该 Effect 绑定的 VS/PS 名称和 BlendState
    // Case 4: 悬浮在 MainCode 名称上
    //   → 显示该 MainCode 使用的 ConstantBuffers
  }
}
```

### 3.3 Phase C3：跨文件智能

#### 3.3.1 工作区 Shader 索引

```typescript
// shaderIndex.ts
export class ShaderIndex {
  private documents: Map<string, PdxShaderDocument> = new Map();

  /** 懒加载：首次需要时扫描工作区 */
  async ensureReady(): Promise<void>;

  /** 增量更新：文件变更时重新解析单个文件 */
  onDocumentChanged(uri: string): void;

  /** 全局查询 */
  findMainCode(name: string): { uri: string; node: PdxShaderNode }[];
  findConstantBuffer(name: string): { uri: string; node: PdxShaderNode }[];
  findEffect(name: string): { uri: string; node: PdxShaderNode }[];
  findAllEffectNames(): string[];
  findAllMainCodeNames(): string[];
}
```

**索引策略**：
- 遵循 `IndexService` 的懒加载模式（参考 `indexing/workspaceSymbolParser.ts`）
- 使用文件 watcher 监听 `.shader` / `.fxh` 文件变更
- 闲置后回收索引

#### 3.3.2 跨文件定义跳转

扩展 `DefinitionProvider`，当在当前文件中找不到定义时，查询 `ShaderIndex` 搜索其他文件。

#### 3.3.3 基础诊断

```typescript
// providers/diagnostics.ts
export class PdxShaderDiagnostics {
  // D001: Effect 引用了不存在的 MainCode
  // D002: MainCode 引用了不存在的 ConstantBuffer
  // D003: Includes 引用了不存在的文件
  // D004: 重复的 Effect 名称
  // D005: 重复的 MainCode 名称（同一 ShaderBlock 内）
}
```

---

## 4. 测试策略

### 4.1 单元测试

#### 解析器测试

```typescript
// client/test/unit/shaderParser.test.ts
describe('PdxShaderParser', () => {
  describe('基础解析', () => {
    it('应解析空文件', () => { ... });
    it('应解析 Includes 列表', () => { ... });
    it('应解析 VertexStruct 及其字段', () => { ... });
    it('应解析 ConstantBuffer 及其参数和字段', () => { ... });
    it('应解析 Code [[ ]] 块', () => { ... });
    it('应解析 MainCode 及其 ConstantBuffers 列表', () => { ... });
    it('应解析 Effect 及其属性', () => { ... });
    it('应解析 BlendState 及其属性', () => { ... });
    it('应解析 Samplers 块', () => { ... });
  });

  describe('边界条件', () => {
    it('应处理嵌套花括号', () => { ... });
    it('应处理空 [[ ]]', () => { ... });
    it('应处理注释中的关键字', () => { ... });
    it('应处理 @ifdef 条件块', () => { ... });
    it('应处理缺少分号的结构体', () => { ... });
  });

  describe('大型文件', () => {
    it('应在 50ms 内解析 pdxmesh.shader', () => { ... });
  });
});
```

#### Provider 测试

```typescript
// client/test/unit/shaderProviders.test.ts
describe('PdxShaderProviders', () => {
  describe('DocumentLinkProvider', () => {
    it('应为 Includes 中的文件名生成链接', () => { ... });
    it('应正确解析相对路径', () => { ... });
  });

  describe('DocumentSymbolProvider', () => {
    it('应为 simple.shader 生成正确的符号层级', () => { ... });
    it('应为 pdxmesh.shader 生成完整的符号树', () => { ... });
  });

  describe('DefinitionProvider', () => {
    it('应从 Effect 跳转到 MainCode', () => { ... });
    it('应从 ConstantBuffers 跳转到 ConstantBuffer', () => { ... });
  });

  describe('CompletionProvider', () => {
    it('应在 Effect 内补全 VertexShader 名称', () => { ... });
    it('应在 Sampler 内补全 Filter 枚举值', () => { ... });
  });
});
```

### 4.2 集成测试

| 测试点 | 方法 |
|---|---|
| Include 跳转 | 在 `pdxmesh.shader` 中 Ctrl+Click `"constants.fxh"` |
| 大纲视图 | 打开 `pdxmesh.shader`，验证 Outline 视图显示所有 MainCode 和 Effect |
| Effect → MainCode 跳转 | 在 `simple.shader` 中 F12 跳转 |
| 补全触发 | 在 Effect 块内输入 `VertexShader = "` 后弹出补全列表 |
| 悬浮提示 | 悬浮在 Sampler 名称上显示配置信息 |
| 诊断 | 故意拼错 MainCode 名称，验证红线出现 |

### 4.3 性能测试

| 指标 | 目标 |
|---|---|
| 解析 `pdxmesh.shader` (4546 行) | < 50ms |
| 文档符号提取 | < 10ms |
| 补全响应 | < 100ms |
| 工作区索引（71 个文件） | < 500ms |

---

## 5. 风险评估

### 5.1 技术风险

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| PDX DSL 解析器可能不够健壮 | 中 | 采用宽容解析模式：遇到不认识的语法直接跳过，不阻断后续解析 |
| HLSL 嵌入区域的变量名来自 DSL 层 | 高 | Phase C2 暂不提供 HLSL 内的变量补全；Phase C3 通过 AST 分析 ConstantBuffer 字段注入 |
| 跨文件解析性能 | 中 | 采用懒加载 + 增量更新模式，与 `IndexService` 架构一致 |
| `@ifdef` 条件编译导致符号不确定 | 中 | 忽略条件编译，将所有分支中的符号都纳入索引 |
| ConstantBuffer 内部的 `#SEntityCustomDataInstance` 等标记含义不明 | 低 | 当作注释处理，不影响字段解析 |

### 5.2 架构风险

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| Extension Host 内联 Provider 可能影响启动性能 | 中 | 按需激活：仅在打开 `.shader`/`.fxh` 文件时注册 Provider；索引懒加载 |
| 与现有 `IndexService` 的职责边界不清 | 低 | `ShaderIndex` 独立管理，不合并到 `IndexService`（因为 shader 文件是完全不同的语法体系） |
| Provider 代码膨胀 | 中 | 严格分层：解析器 → 符号表 → Provider；每个 Provider 独立文件 |

### 5.3 产品风险

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| Modder 实际改 shader 的频率低 | 中 | 先交付 Phase B（零成本提升），C1 作为低投入增值；C2/C3 视社区反馈决定 |
| 不同 PDX 游戏的 shader 格式可能有差异 | 低 | 当前只支持 Stellaris；后续可扩展 GameProfile 来处理差异 |
| 用户期望过高（以为有 IntelliSense 级别的 HLSL 支持） | 中 | 在文档中明确说明：HLSL 部分依赖 VS Code 内置支持，DSL 部分由我们提供 |

---

## 6. 与项目架构的整合

### 6.1 注册入口

在 `client/extension/extension.ts` 的 `activate` 中：

```typescript
// 按需激活 Shader 支持
import { registerShaderProviders } from './shaderSupport/shaderProvider';

// 在 activate 函数中
const shaderDisposables = registerShaderProviders(context);
context.subscriptions.push(...shaderDisposables);
```

### 6.2 与 GameProfile 的关系

当前 Shader 支持不依赖 GameProfile（所有 PDX 游戏的 shader 格式基本一致）。
如果后续需要区分游戏差异（如 CK3 可能引入新 DSL 关键字），可以在 `gameProfiles.ts` 中添加：

```typescript
interface GameProfile {
  // ...existing fields...
  shaderKeywords?: string[];           // 游戏特有的 DSL 关键字
  shaderSearchPaths?: string[];        // shader 文件搜索路径
}
```

### 6.3 与 AI Agent 的协作

Phase C 完成后，AI Agent 可以通过新工具查询 Shader 结构：

```typescript
// 未来可能的 AI Tool（不在 Phase C 范围内）
{
  name: "query_shader_structure",
  description: "查询 PDX Shader 文件的结构信息",
  // 返回 Effect 列表、MainCode 列表、ConstantBuffer 变量等
}
```

---

## 7. 验收标准

### C1 验收

- [ ] Include 路径可点击跳转到 `.fxh` 文件
- [ ] Outline 视图显示完整的 shader 结构层级
- [ ] `Ctrl+Shift+O` 可快速跳转到任意 MainCode / Effect
- [ ] 解析器对所有 71 个原版 FX 文件无崩溃

### C2 验收

- [ ] `F12` 从 `VertexShader = "Name"` 跳转到 `MainCode Name`
- [ ] `F12` 从 `ConstantBuffers = { Name }` 跳转到 `ConstantBuffer( Name, ... )`
- [ ] Effect 块内输入 `VertexShader = "` 弹出 MainCode 名称补全
- [ ] Sampler 属性输入时弹出枚举值补全
- [ ] 悬浮在 Effect/MainCode/Sampler 名称上显示信息

### C3 验收

- [ ] 跨文件 Include 链中的定义跳转生效
- [ ] Effect 引用不存在的 MainCode 显示诊断错误
- [ ] MainCode 引用不存在的 ConstantBuffer 显示诊断错误
- [ ] 重复 Effect 名称显示诊断警告
- [ ] 工作区索引在 500ms 内完成
- [ ] 文件修改后索引增量更新

### 整体验收

- [ ] `npm run compile` 通过
- [ ] `npm run test:unit` 通过（含所有新增测试）
- [ ] `npm run check:release` 通过
- [ ] 启动性能无可感知的退化
- [ ] 内存占用增长 < 5MB（工作区级索引）
