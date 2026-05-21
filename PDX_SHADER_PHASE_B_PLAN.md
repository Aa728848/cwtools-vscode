# Phase B：PDX Shader TextMate Grammar 实施计划

> **目标**：为 `.shader` 和 `.fxh` 文件提供精确的语法高亮，覆盖 Paradox 自定义 DSL 外壳和嵌入的 HLSL 代码块。
> **预计工作量**：2–3 天
> **优先级**：中高（Modder 日常编辑 shader 的体验基础）

---

## 1. 背景与动机

### 1.1 现状

- 当前插件对 `.shader` / `.fxh` 文件 **没有任何语法支持**。
- `release/package.json` 的 `contributes` 中没有 `languages` 和 `grammars` 节。
- 用户打开 shader 文件时，VS Code 会将其当作纯文本（Plain Text），没有任何着色。
- 现有的 HLSL 插件无法直接使用，因为 PDX DSL 外壳会被当作语法错误。

### 1.2 PDX Shader 语法分析

通过分析 `D:\Steam\steamapps\common\Stellaris\gfx\FX\` 下的 71 个文件，总结出以下语法结构：

#### 1.2.1 顶层 DSL 关键字

| 关键字 | 作用 | 示例 |
|---|---|---|
| `Includes` | 引用头文件列表 | `Includes = { "constants.fxh" }` |
| `VertexStruct` | 顶点结构体声明 | `VertexStruct VS_INPUT { ... };` |
| `ConstantBuffer` | 常量缓冲区声明 | `ConstantBuffer( Common, 0, 0 ) { ... }` |
| `VertexShader` | 顶点着色器块 | `VertexShader = { ... }` |
| `PixelShader` | 像素着色器块 | `PixelShader = { ... }` |
| `Code` | 共享代码块 | `Code [[ ... ]]` |
| `MainCode` | 命名着色器入口 | `MainCode Name ConstantBuffers = { ... } [[ ... ]]` |
| `Effect` | 渲染效果定义 | `Effect Simple { VertexShader = "..." }` |
| `BlendState` | 混合状态 | `BlendState Name { ... }` |
| `DepthStencilState` | 深度模板状态 | `DepthStencilState Name { ... }` |
| `RasterizerState` | 光栅化状态 | `RasterizerState Name { ... }` |
| `Samplers` | 采样器声明块 | `Samplers = { TextureName = { ... } }` |

#### 1.2.2 DSL 属性键

| 键 | 上下文 | 值类型 |
|---|---|---|
| `Index` | Samplers | 整数 |
| `MagFilter` / `MinFilter` / `MipFilter` | Samplers | 字符串枚举 |
| `AddressU` / `AddressV` | Samplers | 字符串枚举 |
| `BlendEnable` | BlendState | `yes` / `no` |
| `SourceBlend` / `DestBlend` | BlendState | 字符串枚举 |
| `ConstantBuffers` | MainCode | 花括号列表 |

#### 1.2.3 特殊语法

- `[[ ... ]]`：嵌入 HLSL 代码的双方括号定界符
- `@ifdef` / `@endif`：PDX 预处理指令（注意 **不是** `#ifdef`，这是 DSL 层的条件编译）
- `#comment`：以 `#` 开头的 DSL 层注释（在 `[[ ]]` 外部）
- `#ifdef` / `#endif`：标准 C 预处理指令（在 `[[ ]]` 内部）
- `//`：标准行注释（两层都使用）
- `;` 结尾的结构体（有些有分号，有些没有）

#### 1.2.4 `.fxh` 文件的特殊性

`.fxh` 头文件内容可以是：
- 纯 DSL + 嵌入 HLSL（如 `standardfuncsgfx.fxh`）
- 纯预处理器宏定义（如 `defines_glsl.fxh`）— 这类文件整体就是 HLSL 风格
- 混合（如 `vertex_structs.fxh`，外层是 `VertexStruct` DSL，内含 `@ifdef`）

---

## 2. 设计方案

### 2.1 语言注册

在 `release/package.json` 的 `contributes` 中新增：

```jsonc
"languages": [
  {
    "id": "pdx-shader",
    "aliases": ["PDX Shader", "Paradox Shader"],
    "extensions": [".shader", ".fxh"],
    "configuration": "./language-configuration-pdxshader.json"
  }
],
"grammars": [
  {
    "language": "pdx-shader",
    "scopeName": "source.pdx-shader",
    "path": "./syntaxes/pdxshader.tmLanguage.json",
    "embeddedLanguages": {
      "source.hlsl": "hlsl"
    }
  }
]
```

### 2.2 语言配置文件

创建 `release/language-configuration-pdxshader.json`：

```json
{
  "comments": {
    "lineComment": "//",
    "blockComment": ["/*", "*/"]
  },
  "brackets": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["[[", "]]"]
  ],
  "autoClosingPairs": [
    { "open": "{", "close": "}" },
    { "open": "[", "close": "]" },
    { "open": "(", "close": ")" },
    { "open": "\"", "close": "\"" },
    { "open": "[[", "close": "]]" }
  ],
  "surroundingPairs": [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
    ["\"", "\""]
  ],
  "folding": {
    "markers": {
      "start": "^\\s*(\\[\\[|\\{)",
      "end": "^\\s*(\\]\\]|\\})"
    }
  }
}
```

### 2.3 TextMate Grammar 设计

#### 2.3.1 Scope 命名规范

遵循 [TextMate Naming Conventions](https://macromates.com/manual/en/language_grammars#naming-conventions)：

| 语法元素 | Scope Name |
|---|---|
| DSL 关键字 (`VertexShader`, `Effect` 等) | `keyword.control.pdx-shader` |
| 结构体关键字 (`VertexStruct`) | `storage.type.struct.pdx-shader` |
| 缓冲区关键字 (`ConstantBuffer`) | `storage.type.buffer.pdx-shader` |
| HLSL 类型 (`float4`, `int3` 等) | `storage.type.hlsl.pdx-shader` |
| DSL 属性键 (`BlendEnable`, `Index`) | `variable.parameter.pdx-shader` |
| 字符串值 (`"Linear"`) | `string.quoted.double.pdx-shader` |
| 数字 | `constant.numeric.pdx-shader` |
| `yes` / `no` | `constant.language.boolean.pdx-shader` |
| `#` 行注释 (DSL) | `comment.line.number-sign.pdx-shader` |
| `//` 行注释 | `comment.line.double-slash.pdx-shader` |
| `/* */` 块注释 | `comment.block.pdx-shader` |
| `@ifdef` / `@endif` | `keyword.control.preprocessor.pdx-shader` |
| `#ifdef` / `#endif` (HLSL内) | 由嵌入的 HLSL grammar 处理 |
| `[[ ]]` 定界符 | `punctuation.section.embedded.begin/end.pdx-shader` |
| `[[ ]]` 内部代码 | `source.hlsl`（嵌入语法） |
| Effect/MainCode 名称 | `entity.name.function.pdx-shader` |
| Sampler/Buffer 名称 | `entity.name.type.pdx-shader` |
| 语义绑定 (`: POSITION`) | `variable.other.semantic.pdx-shader` |

#### 2.3.2 Grammar 核心模式

```
source.pdx-shader
├── meta.includes.pdx-shader          → Includes = { "..." }
├── meta.vertex-struct.pdx-shader     → VertexStruct Name { ... }
├── meta.constant-buffer.pdx-shader   → ConstantBuffer( ... ) { ... }
├── meta.shader-block.pdx-shader      → VertexShader/PixelShader = { ... }
│   ├── meta.samplers.pdx-shader      → Samplers = { ... }
│   └── meta.main-code.pdx-shader     → MainCode Name ... [[ HLSL ]]
├── meta.code-block.pdx-shader        → Code [[ HLSL ]]
├── meta.effect.pdx-shader            → Effect Name { ... }
├── meta.blend-state.pdx-shader       → BlendState Name { ... }
├── meta.depth-stencil.pdx-shader     → DepthStencilState Name { ... }
├── meta.rasterizer.pdx-shader        → RasterizerState Name { ... }
├── comment.line.number-sign          → # ...
├── comment.line.double-slash         → // ...
├── comment.block                     → /* ... */
└── embedded.hlsl                     → [[ ... ]] 内嵌入 source.hlsl
```

#### 2.3.3 嵌入 HLSL 策略

**关键设计决策**：`[[ ]]` 内的代码嵌入 `source.hlsl`。

VS Code 内置 HLSL 语法支持（`extensions/hlsl/syntaxes/hlsl.tmLanguage.json`），我们通过 `embeddedLanguages` 声明让 VS Code 自动在 `[[ ]]` 区域激活 HLSL 语法。

```json
{
  "begin": "\\[\\[",
  "end": "\\]\\]",
  "beginCaptures": { "0": { "name": "punctuation.section.embedded.begin.pdx-shader" } },
  "endCaptures": { "0": { "name": "punctuation.section.embedded.end.pdx-shader" } },
  "contentName": "source.hlsl",
  "patterns": [
    { "include": "source.hlsl" }
  ]
}
```

> **备注**：如果用户没有安装专门的 HLSL 扩展，VS Code 内置的 HLSL 支持（由 `extensions/hlsl` 提供）也能提供基本语法高亮。

---

## 3. 文件清单与目录结构

### 3.1 新增文件

| 文件路径 | 作用 |
|---|---|
| `release/syntaxes/pdxshader.tmLanguage.json` | TextMate Grammar 定义 |
| `release/language-configuration-pdxshader.json` | 语言编辑配置（注释/括号/折叠） |

### 3.2 修改文件

| 文件路径 | 修改内容 |
|---|---|
| `release/package.json` | 在 `contributes` 中新增 `languages` 和 `grammars` |

### 3.3 测试文件

| 文件路径 | 作用 |
|---|---|
| `client/test/unit/pdxshader-grammar.test.ts` | Grammar 单元测试 |
| `client/test/fixtures/shaders/simple.shader` | 测试用简单 shader 文件 |
| `client/test/fixtures/shaders/complex.shader` | 测试用复杂 shader 文件 |
| `client/test/fixtures/shaders/sample.fxh` | 测试用头文件 |

---

## 4. 分步实施

### Step 1：创建语言配置文件（0.5h）

创建 `release/language-configuration-pdxshader.json`，定义：
- 行注释 `//` 和块注释 `/* */`
- 括号配对（含 `[[ ]]`）
- 自动缩进规则
- 折叠标记

**验证**：手动打开 `.shader` 文件，确认 `Ctrl+/` 能正确切换注释。

### Step 2：构建 TextMate Grammar 核心（4–6h）

创建 `release/syntaxes/pdxshader.tmLanguage.json`，分层构建：

#### 2a. 基础层（注释和字面量）
- `#` 行注释
- `//` 行注释
- `/* */` 块注释
- 双引号字符串
- 数字（整数和浮点数）
- `yes` / `no` 布尔值

#### 2b. DSL 关键字层
- 顶层结构关键字：`Includes`, `VertexStruct`, `ConstantBuffer`, `VertexShader`, `PixelShader`, `Effect`, `BlendState`, `DepthStencilState`, `RasterizerState`
- 内部关键字：`MainCode`, `Code`, `Samplers`, `ConstantBuffers`
- PDX 预处理器：`@ifdef`, `@else`, `@endif`

#### 2c. HLSL 类型层（在 `[[ ]]` 外部也可能出现）
- `float`, `float2`, `float3`, `float4`, `float4x4`, `float3x3`
- `int`, `int2`, `int3`, `int4`
- `uint`, `uint4`
- `bool`
- `void`
- `sampler2D`, `sampler2DShadow`, `samplerCube`
- `Texture2D`, `TextureCube`, `SamplerState`

#### 2d. 语义绑定层
- `: POSITION`, `: TEXCOORD0..7`, `: COLOR`, `: PDX_POSITION`, `: PDX_COLOR`, `: SV_POSITION`, `: SV_TARGET`

#### 2e. 嵌入 HLSL 层
- `[[ ]]` 内的代码嵌入 `source.hlsl`

#### 2f. 名称识别层
- `Effect` / `BlendState` 后的标识符 → `entity.name`
- `MainCode` 后的标识符 → `entity.name.function`
- `VertexStruct` 后的标识符 → `entity.name.type`
- `ConstantBuffer(` 后的标识符 → `entity.name.type`
- `Samplers` 块内的 `名称 = { ... }` → `entity.name.type`

### Step 3：注册语言到 package.json（0.5h）

在 `release/package.json` 的 `contributes` 中添加 `languages` 和 `grammars` 节。

### Step 4：编写测试（2h）

#### 4a. Grammar Token 测试

使用 `vscode-tmgrammar-test` 或手工编写 scope 断言测试：

```typescript
// client/test/unit/pdxshader-grammar.test.ts
describe('PDX Shader Grammar', () => {
  it('应识别 Includes 关键字', () => { ... });
  it('应识别 VertexStruct 及其名称', () => { ... });
  it('应识别 ConstantBuffer 及其参数', () => { ... });
  it('应识别 MainCode 及其名称', () => { ... });
  it('应将 [[ ]] 内的代码标记为 source.hlsl', () => { ... });
  it('应识别 # 注释（DSL 层）', () => { ... });
  it('应识别 @ifdef/@endif 预处理器', () => { ... });
  it('应识别 Effect 定义及名称', () => { ... });
  it('应识别 BlendState 及属性', () => { ... });
  it('应识别 Sampler 声明块', () => { ... });
  it('应处理 .fxh 纯代码文件', () => { ... });
});
```

#### 4b. 手工验收测试

用 Stellaris 原版 shader 文件验证：
- `simple.shader`（最小 shader）
- `pdxmesh.shader`（最复杂的 shader，4546 行）
- `constants.fxh`（纯 Code [[ ]] 文件）
- `vertex_structs.fxh`（纯 VertexStruct + @ifdef 文件）
- `defines_glsl.fxh`（纯预处理器宏文件）
- `standardfuncsgfx.fxh`（混合 DSL + HLSL）

### Step 5：集成验证（1h）

- 运行 `npm run compile` 确认构建通过
- 运行 `npm run test:unit` 确认测试通过
- 运行 `npm run check:release` 确认发布门通过
- 实际启动插件，打开 Stellaris shader 文件验证效果

---

## 5. 测试策略

### 5.1 单元测试

| 测试点 | 方法 | 覆盖文件 |
|---|---|---|
| Grammar scope 正确性 | `vscode-textmate` 加载 grammar 并 tokenize 测试文本 | 测试 fixture |
| 所有 DSL 关键字识别 | 逐一验证每个关键字的 scope | fixture |
| HLSL 嵌入激活 | 验证 `[[ ]]` 内的 token scope 为 `source.hlsl` | fixture |
| 注释类型区分 | `#` vs `//` vs `/* */` 在不同上下文 | fixture |
| @ifdef/@endif | PDX 预处理器与 C 预处理器的区分 | fixture |
| 边界条件 | 空 `[[ ]]`、嵌套花括号、无分号结构体 | fixture |

### 5.2 集成测试

| 测试点 | 方法 |
|---|---|
| 文件类型关联 | 打开 `.shader` 文件，确认语言模式为 `PDX Shader` |
| 注释快捷键 | `Ctrl+/` 切换行注释 |
| 括号匹配 | `[[ ]]` 和 `{ }` 的匹配高亮 |
| 代码折叠 | 折叠 `[[ ]]` 和 `{ }` 块 |
| 原版文件兼容性 | 打开 Stellaris 所有 71 个 FX 文件，无语法错误高亮 |

### 5.3 回归测试

- 确认现有的 `.txt`、`.gui`、`.gfx`、`.yml`、`.asset` 文件不受影响。
- 确认 `npm run verify` 全部通过。

---

## 6. 风险评估

### 6.1 技术风险

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| HLSL 嵌入语法不可用 | 中 | VS Code 内置 `extensions/hlsl`，无需额外安装；若用户禁用了内置 HLSL，回退为无高亮但不报错 |
| `#` 注释与 HLSL `#define` 冲突 | 中 | 限制 `#` 注释规则仅在 `[[ ]]` 外部生效，`[[ ]]` 内部由嵌入的 HLSL grammar 处理 `#` 开头的预处理器 |
| `@ifdef` 语法不常见，regex 匹配需要精确 | 低 | 用 `@(ifdef\|else\|endif)\\b` 精确匹配 |
| `.fxh` 文件可能是纯 HLSL | 中 | Grammar 设计为宽容模式：如果文件没有 DSL 关键字，HLSL 类型和预处理器指令仍然能被高亮 |
| `ConstantBuffer` 内的 `#SEntityCustomDataInstance` 是注释非关键字 | 低 | 统一用 `#` 注释规则处理 |

### 6.2 兼容性风险

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| 其他 HLSL 插件与 pdx-shader 语言冲突 | 低 | 通过明确的 `.shader`/`.fxh` 文件关联，我们的语言优先；用户如果不想用 PDX 语法，可以手动切换 |
| `.fxh` 扩展名可能被其他插件占用 | 中 | 在文档中说明 pdx-shader 语言关联了 `.fxh`；如有冲突用户可在 `files.associations` 中覆盖 |
| VS Code 版本兼容 | 低 | TextMate Grammar 是 VS Code 最稳定的 API，从 1.0 就支持 |

### 6.3 维护风险

| 风险 | 等级 | 缓解措施 |
|---|---|---|
| Paradox 在新版本中引入新 DSL 关键字 | 低 | 只需在 grammar 中添加新关键字，不影响架构 |
| TextMate Grammar 复杂度膨胀 | 中 | 使用 `repository` 组织规则，保持模块化；每个顶层 DSL 结构独立定义 |

---

## 7. 后续扩展点（为 Phase C 准备）

Phase B 完成后，以下能力可以在 Phase C 中增量添加：

1. **Effect 名称引用跳转**：从 `VertexShader = "Name"` 跳转到 `MainCode Name`
2. **Sampler 名称补全**：在 HLSL 代码中补全 Sampler 变量名
3. **ConstantBuffer 变量补全**：在 HLSL 代码中补全 cbuffer 内声明的变量
4. **Include 路径跳转**：从 `Includes = { "file.fxh" }` 跳转到文件
5. **Effect 名称重命名**：同步重命名引用

Phase B 的 Grammar scope 命名已经为这些功能预留了语义标记（如 `entity.name.function`、`entity.name.type`），确保 Phase C 可以依赖这些 scope 进行符号提取。

---

## 8. 验收标准

- [ ] `.shader` 文件自动关联为 `PDX Shader` 语言
- [ ] `.fxh` 文件自动关联为 `PDX Shader` 语言
- [ ] 所有 12 个 DSL 顶层关键字正确高亮
- [ ] `[[ ]]` 内的 HLSL 代码获得完整的 HLSL 语法高亮
- [ ] `#` 注释（DSL 层）和 `//` 注释正确区分
- [ ] `@ifdef` / `@endif` 作为预处理器高亮
- [ ] Effect、MainCode、VertexStruct、ConstantBuffer 的名称正确高亮
- [ ] Sampler 属性键值正确高亮
- [ ] `Ctrl+/` 正确切换行注释
- [ ] `[[ ]]` 和 `{ }` 可折叠
- [ ] 所有 71 个 Stellaris 原版 FX 文件无异常
- [ ] `npm run compile` 通过
- [ ] `npm run test:unit` 通过（含新增的 grammar 测试）
- [ ] `npm run check:release` 通过
