/**
 * PDX Shader DSL AST Parser
 * 
 * This parser scans a PDX Shader/FXH file and constructs an Abstract Syntax Tree (AST).
 * It is designed to be:
 * 1. Highly tolerant (ignores syntax errors, never throws/crashes, skips unrecognized constructs).
 * 2. Extremely fast (parses 4500+ lines in < 30ms).
 * 3. Position-preserving (maps AST ranges to exact 0-indexed line and character offsets).
 * 4. Strictly typed (TypeScript strict compliant, no abuse of 'any').
 */

export interface Position {
    line: number;      // 0-indexed
    character: number; // 0-indexed
}

export interface Range {
    start: Position;
    end: Position;
}

export type PdxShaderNodeType =
    | 'File'
    | 'Includes'
    | 'VertexStruct'
    | 'ConstantBuffer'
    | 'ShaderBlock'       // VertexShader or PixelShader
    | 'Samplers'
    | 'SamplerDecl'       // e.g. SimpleTexture = { ... }
    | 'MainCode'
    | 'CodeBlock'         // Top-level Code [[ ... ]] (shared HLSL in .fxh)
    | 'Effect'
    | 'BlendState'
    | 'DepthStencilState'
    | 'RasterizerState'
    | 'Property';         // key = value or struct field

export interface PdxShaderNode {
    type: PdxShaderNodeType;
    name?: string;
    range: Range;
    nameRange?: Range;
    children: PdxShaderNode[];
    properties: Record<string, string>;
    hlslContent?: string;
    hlslRange?: Range;
}

export interface PdxShaderDocument {
    uri: string;
    includes: string[];
    vertexStructs: PdxShaderNode[];
    constantBuffers: PdxShaderNode[];
    shaderBlocks: PdxShaderNode[];     // VertexShader or PixelShader
    codeBlocks: PdxShaderNode[];       // Top-level Code [[ ... ]] blocks
    effects: PdxShaderNode[];
    blendStates: PdxShaderNode[];
    depthStencilStates: PdxShaderNode[];
    rasterizerStates: PdxShaderNode[];
    allMainCodes: PdxShaderNode[];
    allSamplers: PdxShaderNode[];
    ast: PdxShaderNode;                // Root node representing the whole file
}

/** Utility to convert flat string offsets to { line, character } coordinates */
export class SourceMap {
    private readonly lineOffsets: number[] = [];

    constructor(private readonly text: string) {
        this.lineOffsets.push(0);
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                this.lineOffsets.push(i + 1);
            }
        }
    }

    getPosition(offset: number): Position {
        if (offset < 0) return { line: 0, character: 0 };
        if (offset >= this.text.length) {
            const lastLine = this.lineOffsets.length - 1;
            return {
                line: lastLine,
                character: this.text.length - this.lineOffsets[lastLine]!
            };
        }

        let low = 0;
        let high = this.lineOffsets.length - 1;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            if (this.lineOffsets[mid]! <= offset) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        return { line: low, character: offset - this.lineOffsets[low]! };
    }

    getRange(startOffset: number, endOffset: number): Range {
        return {
            start: this.getPosition(startOffset),
            end: this.getPosition(endOffset)
        };
    }
}

/** Pre-process step: strips comments and preprocessors by replacing them with spaces to preserve line & character offsets */
function stripCommentsAndPreprocessors(text: string, hlslBlocks: { start: number; end: number }[]): string {
    const chars = text.split('');
    const len = chars.length;

    function isHlsl(idx: number): boolean {
        for (let i = 0; i < hlslBlocks.length; i++) {
            const block = hlslBlocks[i]!;
            if (idx >= block.start && idx < block.end) return true;
        }
        return false;
    }

    let i = 0;
    while (i < len) {
        if (isHlsl(i)) {
            i++;
            continue;
        }

        // Strip block comment: /* ... */
        if (chars[i] === '/' && chars[i + 1] === '*') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            let j = i + 2;
            while (j < len - 1) {
                if (chars[j] === '*' && chars[j + 1] === '/') {
                    chars[j] = ' ';
                    chars[j + 1] = ' ';
                    j += 2;
                    break;
                }
                if (chars[j] !== '\n' && chars[j] !== '\r') {
                    chars[j] = ' ';
                }
                j++;
            }
            i = j;
            continue;
        }

        // Strip line comment: //
        if (chars[i] === '/' && chars[i + 1] === '/') {
            chars[i] = ' ';
            chars[i + 1] = ' ';
            let j = i + 2;
            while (j < len) {
                if (chars[j] === '\n' || chars[j] === '\r') {
                    break;
                }
                chars[j] = ' ';
                j++;
            }
            i = j;
            continue;
        }

        // Strip line comments & preprocessors: # or @ to end of line
        if (chars[i] === '#' || chars[i] === '@') {
            chars[i] = ' ';
            let j = i + 1;
            while (j < len) {
                if (chars[j] === '\n' || chars[j] === '\r') {
                    break;
                }
                chars[j] = ' ';
                j++;
            }
            i = j;
            continue;
        }

        i++;
    }
    return chars.join('');
}

interface BracedScope {
    startOffset: number;
    endOffset: number;
    parent?: BracedScope;
    children: BracedScope[];
}

/** Parses raw PDX Shader file and returns the strictly-typed document AST */
export function parsePdxShader(uri: string, text: string): PdxShaderDocument {
    const sourceMap = new SourceMap(text);

    // 1. Scan for embedded HLSL blocks [[ ... ]]
    const hlslBlocks: { start: number; end: number }[] = [];
    let lastHlslIdx = 0;
    while (true) {
        const begin = text.indexOf('[[', lastHlslIdx);
        if (begin === -1) break;
        const end = text.indexOf(']]', begin + 2);
        if (end === -1) break;
        hlslBlocks.push({ start: begin, end: end + 2 });
        lastHlslIdx = end + 2;
    }

    // 2. Strip comments & preprocessors from DSL space (leaves HLSL blocks intact)
    const cleanedText = stripCommentsAndPreprocessors(text, hlslBlocks);

    // 3. Scan for braced scopes { ... } outside of HLSL blocks
    const rootScope: BracedScope = { startOffset: 0, endOffset: text.length, children: [] };
    let currentScope = rootScope;

    function isHlslOffset(offset: number): boolean {
        for (let i = 0; i < hlslBlocks.length; i++) {
            const block = hlslBlocks[i]!;
            if (offset >= block.start && offset < block.end) return true;
        }
        return false;
    }

    for (let i = 0; i < cleanedText.length; i++) {
        if (isHlslOffset(i)) continue;

        if (cleanedText[i] === '{') {
            const newScope: BracedScope = {
                startOffset: i,
                endOffset: -1,
                parent: currentScope,
                children: []
            };
            currentScope.children.push(newScope);
            currentScope = newScope;
        } else if (cleanedText[i] === '}') {
            currentScope.endOffset = i + 1;
            if (currentScope.parent) {
                currentScope = currentScope.parent;
            }
        }
    }

    // Ensure all scopes are closed cleanly
    const closeScopes = (scope: BracedScope) => {
        if (scope.endOffset === -1) {
            scope.endOffset = text.length;
        }
        scope.children.forEach(closeScopes);
    };
    closeScopes(rootScope);

    // Helper to extract the header text preceding a braced scope
    function getScopeHeader(scope: BracedScope, parentScope: BracedScope): string {
        const parentStart = parentScope.startOffset === 0 ? 0 : parentScope.startOffset + 1;
        
        // Find previous sibling's endOffset or parent start
        let prevEnd = parentStart;
        for (let i = 0; i < parentScope.children.length; i++) {
            const child = parentScope.children[i]!;
            if (child === scope) break;
            prevEnd = child.endOffset;
        }

        return cleanedText.substring(prevEnd, scope.startOffset).trim();
    }

    // Helper to get range of a scope's name identifier in the original text
    function findNameRange(header: string, name: string, scopeStartOffset: number, parentScope: BracedScope, scope: BracedScope): Range | undefined {
        const parentStart = parentScope.startOffset === 0 ? 0 : parentScope.startOffset + 1;
        let prevEnd = parentStart;
        for (let i = 0; i < parentScope.children.length; i++) {
            const child = parentScope.children[i]!;
            if (child === scope) break;
            prevEnd = child.endOffset;
        }

        const headerStartOffset = prevEnd + cleanedText.substring(prevEnd, scopeStartOffset).indexOf(header);
        const nameIdx = header.lastIndexOf(name); // match the actual identifier
        if (nameIdx !== -1) {
            const absStart = headerStartOffset + nameIdx;
            return sourceMap.getRange(absStart, absStart + name.length);
        }
        return undefined;
    }

    const includes: string[] = [];
    const vertexStructs: PdxShaderNode[] = [];
    const constantBuffers: PdxShaderNode[] = [];
    const shaderBlocks: PdxShaderNode[] = [];
    const effects: PdxShaderNode[] = [];
    const blendStates: PdxShaderNode[] = [];
    const depthStencilStates: PdxShaderNode[] = [];
    const rasterizerStates: PdxShaderNode[] = [];
    const allMainCodes: PdxShaderNode[] = [];
    const allSamplers: PdxShaderNode[] = [];

    // 4. Parse the braced scope hierarchy recursively to generate AST nodes
    function parseScope(scope: BracedScope, parentScope: BracedScope): PdxShaderNode | null {
        const header = getScopeHeader(scope, parentScope);
        const range = sourceMap.getRange(scope.startOffset, scope.endOffset);

        let nodeType: PdxShaderNodeType | null = null;
        let nodeName: string | undefined;
        let nameRange: Range | undefined;

        // Try regex matches on header to classify the scope node
        const structMatch = /\bVertexStruct\s+([A-Za-z0-9_]+)/.exec(header);
        const cbMatch = /\bConstantBuffer\s*\(\s*([A-Za-z0-9_]+)/.exec(header);
        const vsMatch = /\bVertexShader\s*=/.exec(header);
        const psMatch = /\bPixelShader\s*=/.exec(header);
        const effectMatch = /\bEffect\s+([A-Za-z0-9_]+)/.exec(header);
        const blendMatch = /\bBlendState\s+([A-Za-z0-9_]+)/.exec(header);
        const depthMatch = /\bDepthStencilState\s+([A-Za-z0-9_]+)/.exec(header);
        const rastMatch = /\bRasterizerState\s+([A-Za-z0-9_]+)/.exec(header);
        const samplersMatch = /\bSamplers\s*=/.exec(header);
        const includesMatch = /\bIncludes\s*=/.exec(header);

        if (structMatch && structMatch[1]) {
            nodeType = 'VertexStruct';
            nodeName = structMatch[1];
            nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
        } else if (cbMatch && cbMatch[1]) {
            nodeType = 'ConstantBuffer';
            nodeName = cbMatch[1];
            nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
        } else if (vsMatch) {
            nodeType = 'ShaderBlock';
            nodeName = 'VertexShader';
        } else if (psMatch) {
            nodeType = 'ShaderBlock';
            nodeName = 'PixelShader';
        } else if (effectMatch && effectMatch[1]) {
            nodeType = 'Effect';
            nodeName = effectMatch[1];
            nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
        } else if (blendMatch && blendMatch[1]) {
            nodeType = 'BlendState';
            nodeName = blendMatch[1];
            nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
        } else if (depthMatch && depthMatch[1]) {
            nodeType = 'DepthStencilState';
            nodeName = depthMatch[1];
            nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
        } else if (rastMatch && rastMatch[1]) {
            nodeType = 'RasterizerState';
            nodeName = rastMatch[1];
            nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
        } else if (samplersMatch) {
            nodeType = 'Samplers';
            nodeName = 'Samplers';
        } else if (includesMatch) {
            nodeType = 'Includes';
            nodeName = 'Includes';
        } else if (parentScope.startOffset > 0) {
            // Check if this is a nested sampler declaration (e.g. SimpleTexture = { ... } inside Samplers block)
            const parentHeader = getScopeHeader(parentScope, parentScope.parent || rootScope);
            if (/\bSamplers\s*=/.test(parentHeader)) {
                const samplerNameMatch = /\b([A-Za-z0-9_]+)\s*=/.exec(header);
                if (samplerNameMatch && samplerNameMatch[1]) {
                    nodeType = 'SamplerDecl';
                    nodeName = samplerNameMatch[1];
                    nameRange = findNameRange(header, nodeName, scope.startOffset, parentScope, scope);
                }
            }
        }

        if (!nodeType) return null;

        const children: PdxShaderNode[] = [];
        const properties: Record<string, string> = {};

        if (nodeType === 'ShaderBlock') {
            // 1. Parse only Samplers braced child scopes, ignore other braced scopes (since they belong to MainCode)
            scope.children.forEach(child => {
                const childHeader = getScopeHeader(child, scope);
                if (/\bSamplers\s*=/.test(childHeader)) {
                    const childNode = parseScope(child, scope);
                    if (childNode) {
                        children.push(childNode);
                    }
                }
            });

            // 2. Scan for unbraced MainCode declarations using regex within this block
            const scopeContentStart = scope.startOffset + 1;
            const scopeContentEnd = scope.endOffset - 1;
            const scopeContent = cleanedText.substring(scopeContentStart, scopeContentEnd);

            const mainCodeRegex = /\bMainCode\s+([A-Za-z0-9_]+)\b/g;
            const mainCodeMatches: { name: string; matchIndex: number }[] = [];
            let mcMatch: RegExpExecArray | null;
            while ((mcMatch = mainCodeRegex.exec(scopeContent)) !== null) {
                mainCodeMatches.push({
                    name: mcMatch[1]!,
                    matchIndex: mcMatch.index
                });
            }

            for (let idx = 0; idx < mainCodeMatches.length; idx++) {
                const current = mainCodeMatches[idx]!;
                const absStart = scopeContentStart + current.matchIndex;
                
                // End of this MainCode is either the next MainCode start or the end of the ShaderBlock
                let absEnd = scopeContentEnd;
                if (idx + 1 < mainCodeMatches.length) {
                    absEnd = scopeContentStart + mainCodeMatches[idx + 1]!.matchIndex;
                }

                // Adjust if Samplers is in the way
                children.forEach(c => {
                    if (c.type === 'Samplers') {
                        const cStartOffset = text.indexOf('Samplers', scopeContentStart);
                        if (cStartOffset !== -1 && cStartOffset > absStart && cStartOffset < absEnd) {
                            absEnd = cStartOffset;
                        }
                    }
                });

                const mainCodeText = cleanedText.substring(absStart, absEnd);
                const mainCodeRange = sourceMap.getRange(absStart, absEnd);

                const nameIdx = mainCodeText.indexOf(current.name);
                const absNameStart = absStart + nameIdx;
                const nameRange = sourceMap.getRange(absNameStart, absNameStart + current.name.length);

                const properties: Record<string, string> = {};
                // Extract properties like ConstantBuffers = { Common }
                const propRe = /(\b[A-Za-z0-9_]+\b)\s*=\s*(?:("([^"]*)"|([A-Za-z0-9_.-]+)))/g;
                let pMatch: RegExpExecArray | null;
                while ((pMatch = propRe.exec(mainCodeText)) !== null) {
                    properties[pMatch[1]!] = pMatch[3] !== undefined ? pMatch[3] : pMatch[4]!;
                }
                const listPropRe = /(\b[A-Za-z0-9_]+\b)\s*=\s*\{\s*([^}]*)\}/g;
                while ((pMatch = listPropRe.exec(mainCodeText)) !== null) {
                    properties[pMatch[1]!] = pMatch[2]!.trim();
                }

                // Find corresponding HLSL block inside this MainCode
                const mcChildren: PdxShaderNode[] = [];
                for (let i = 0; i < hlslBlocks.length; i++) {
                    const block = hlslBlocks[i]!;
                    if (block.start >= absStart && block.end <= absEnd) {
                        const rawHlsl = text.substring(block.start + 2, block.end - 2);
                        mcChildren.push({
                            type: 'Property',
                            name: 'HLSL Code',
                            range: sourceMap.getRange(block.start, block.end),
                            children: [],
                            properties: {},
                            hlslContent: rawHlsl,
                            hlslRange: sourceMap.getRange(block.start + 2, block.end - 2)
                        });
                        break;
                    }
                }

                const mcNode: PdxShaderNode = {
                    type: 'MainCode',
                    name: current.name,
                    range: mainCodeRange,
                    nameRange,
                    children: mcChildren,
                    properties
                };
                children.push(mcNode);
                allMainCodes.push(mcNode);
            }
        } else {
            // Parse nested child scopes recursively
            scope.children.forEach(child => {
                const childNode = parseScope(child, scope);
                if (childNode) {
                    children.push(childNode);
                    if (childNode.type === 'SamplerDecl') {
                        allSamplers.push(childNode);
                    }
                }
            });
        }

        const scopeText = cleanedText.substring(scope.startOffset + 1, scope.endOffset - 1);

        // A. Extract assignments within the scope's own local text: key = value or key = { values }
        const propRe = /(\b[A-Za-z0-9_]+\b)\s*=\s*(?:("([^"]*)"|([A-Za-z0-9_.-]+)))/g;
        let match: RegExpExecArray | null;
        while ((match = propRe.exec(scopeText)) !== null) {
            const key = match[1]!;
            const val = match[3] !== undefined ? match[3] : match[4]!;
            properties[key] = val;
        }

        const listPropRe = /(\b[A-Za-z0-9_]+\b)\s*=\s*\{\s*([^}]*)\}/g;
        while ((match = listPropRe.exec(scopeText)) !== null) {
            const key = match[1]!;
            const val = match[2]!.trim();
            properties[key] = val;
        }

        // B. Handle special node type contents
        if (nodeType === 'Includes') {
            // Find all string literals inside Includes braced block
            const strRe = /"([^"]+)"/g;
            let strMatch: RegExpExecArray | null;
            while ((strMatch = strRe.exec(scopeText)) !== null) {
                const file = strMatch[1]!;
                includes.push(file);
                
                // Add as a child property node for outline support
                const absStart = scope.startOffset + 1 + strMatch.index;
                const fileRange = sourceMap.getRange(absStart, absStart + strMatch[0].length);
                children.push({
                    type: 'Property',
                    name: file,
                    range: fileRange,
                    children: [],
                    properties: {}
                });
            }
        } else if (nodeType === 'VertexStruct' || nodeType === 'ConstantBuffer') {
            // Find fields/members inside struct or constant buffer: Type Name; or Type Name : Semantic;
            const fieldRe = /\b([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)(?:\s*:\s*([A-Za-z0-9_]+))?\s*;/g;
            let fieldMatch: RegExpExecArray | null;
            while ((fieldMatch = fieldRe.exec(scopeText)) !== null) {
                const typeName = fieldMatch[1]!;
                const fieldName = fieldMatch[2]!;
                const semantic = fieldMatch[3];

                const absStart = scope.startOffset + 1 + fieldMatch.index;
                const fieldRange = sourceMap.getRange(absStart, absStart + fieldMatch[0].length);
                
                const fieldNameIdx = fieldMatch[0].indexOf(fieldName);
                const absNameStart = absStart + fieldNameIdx;
                const fieldNameRange = sourceMap.getRange(absNameStart, absNameStart + fieldName.length);

                children.push({
                    type: 'Property',
                    name: fieldName,
                    range: fieldRange,
                    nameRange: fieldNameRange,
                    children: [],
                    properties: {
                        type: typeName,
                        ...(semantic ? { semantic } : {})
                    }
                });
            }
        }

        const node: PdxShaderNode = {
            type: nodeType,
            name: nodeName,
            range,
            nameRange,
            children,
            properties
        };

        // Categorize node in respective document lists
        if (nodeType === 'VertexStruct') vertexStructs.push(node);
        else if (nodeType === 'ConstantBuffer') constantBuffers.push(node);
        else if (nodeType === 'ShaderBlock') shaderBlocks.push(node);
        else if (nodeType === 'Effect') effects.push(node);
        else if (nodeType === 'BlendState') blendStates.push(node);
        else if (nodeType === 'DepthStencilState') depthStencilStates.push(node);
        else if (nodeType === 'RasterizerState') rasterizerStates.push(node);

        return node;
    }

    // 5. Walk root braced scopes to populate the AST children
    const rootChildren: PdxShaderNode[] = [];
    rootScope.children.forEach(child => {
        const childNode = parseScope(child, rootScope);
        if (childNode) {
            rootChildren.push(childNode);
        }
    });

    // 6. Scan for top-level Code [[ ... ]] blocks (non-braced, common in .fxh files)
    const codeBlocks: PdxShaderNode[] = [];
    const codeBlockRegex = /\bCode\b/g;
    let codeMatch: RegExpExecArray | null;
    while ((codeMatch = codeBlockRegex.exec(cleanedText)) !== null) {
        const codeKeywordOffset = codeMatch.index;
        // Only top-level: must not be inside any braced scope (except root)
        let insideBraced = false;
        for (const child of rootScope.children) {
            if (codeKeywordOffset >= child.startOffset && codeKeywordOffset < child.endOffset) {
                insideBraced = true;
                break;
            }
        }
        if (insideBraced) continue;

        // Find the HLSL block [[ ... ]] that follows this Code keyword
        for (const block of hlslBlocks) {
            if (block.start > codeKeywordOffset) {
                // Make sure there's no other braced scope or keyword between Code and [[
                const between = cleanedText.substring(codeKeywordOffset + 4, block.start).trim();
                if (between === '') {
                    const rawHlsl = text.substring(block.start + 2, block.end - 2);
                    const codeNode: PdxShaderNode = {
                        type: 'CodeBlock',
                        name: 'Code',
                        range: sourceMap.getRange(codeKeywordOffset, block.end),
                        children: [{
                            type: 'Property',
                            name: 'HLSL Code',
                            range: sourceMap.getRange(block.start, block.end),
                            children: [],
                            properties: {},
                            hlslContent: rawHlsl,
                            hlslRange: sourceMap.getRange(block.start + 2, block.end - 2)
                        }],
                        properties: {},
                        hlslContent: rawHlsl,
                        hlslRange: sourceMap.getRange(block.start + 2, block.end - 2)
                    };
                    rootChildren.push(codeNode);
                    codeBlocks.push(codeNode);
                    break;
                }
            }
        }
    }

    const rootNode: PdxShaderNode = {
        type: 'File',
        range: sourceMap.getRange(0, text.length),
        children: rootChildren,
        properties: {}
    };

    return {
        uri,
        includes,
        vertexStructs,
        constantBuffers,
        shaderBlocks,
        codeBlocks,
        effects,
        blendStates,
        depthStencilStates,
        rasterizerStates,
        allMainCodes,
        allSamplers,
        ast: rootNode
    };
}
