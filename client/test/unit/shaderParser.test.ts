import { expect } from 'chai';
import { parsePdxShader } from '../../extension/shaderSupport/shaderParser';

describe('PDX Shader AST Parser Unit Tests', () => {
    it('parses empty files cleanly without crashing', () => {
        const doc = parsePdxShader('file:///test.shader', '');
        expect(doc.uri).to.equal('file:///test.shader');
        expect(doc.includes).to.be.empty;
        expect(doc.vertexStructs).to.be.empty;
        expect(doc.constantBuffers).to.be.empty;
        expect(doc.effects).to.be.empty;
        expect(doc.ast.children).to.be.empty;
    });

    it('parses Includes lists correctly and tracks string values', () => {
        const text = `
            Includes = {
                "constants.fxh"
                "utils.fxh"
            }
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.includes).to.deep.equal(['constants.fxh', 'utils.fxh']);
        expect(doc.ast.children).to.have.lengthOf(1);
        
        const inclNode = doc.ast.children[0]!;
        expect(inclNode.type).to.equal('Includes');
        expect(inclNode.children).to.have.lengthOf(2);
        expect(inclNode.children[0]!.name).to.equal('constants.fxh');
        expect(inclNode.children[1]!.name).to.equal('utils.fxh');
    });

    it('parses VertexStruct with nested fields and types', () => {
        const text = `
            VertexStruct VS_INPUT
            {
                float4 vPosition  : POSITION;
                float2 vTexCoord  : TEXCOORD0;
            };
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.vertexStructs).to.have.lengthOf(1);
        
        const struct = doc.vertexStructs[0]!;
        expect(struct.type).to.equal('VertexStruct');
        expect(struct.name).to.equal('VS_INPUT');
        expect(struct.children).to.have.lengthOf(2);

        const field1 = struct.children[0]!;
        expect(field1.type).to.equal('Property');
        expect(field1.name).to.equal('vPosition');
        expect(field1.properties.type).to.equal('float4');
        expect(field1.properties.semantic).to.equal('POSITION');

        const field2 = struct.children[1]!;
        expect(field2.type).to.equal('Property');
        expect(field2.name).to.equal('vTexCoord');
        expect(field2.properties.type).to.equal('float2');
        expect(field2.properties.semantic).to.equal('TEXCOORD0');
    });

    it('parses ConstantBuffer fields and properties', () => {
        const text = `
            ConstantBuffer( VFXConstants, 1, 28 )
            {
                float4x4 WorldMatrix;
                float4 Erosion;
            }
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.constantBuffers).to.have.lengthOf(1);

        const cb = doc.constantBuffers[0]!;
        expect(cb.type).to.equal('ConstantBuffer');
        expect(cb.name).to.equal('VFXConstants');
        expect(cb.children).to.have.lengthOf(2);

        const f1 = cb.children[0]!;
        expect(f1.name).to.equal('WorldMatrix');
        expect(f1.properties.type).to.equal('float4x4');

        const f2 = cb.children[1]!;
        expect(f2.name).to.equal('Erosion');
        expect(f2.properties.type).to.equal('float4');
    });

    it('parses ShaderBlock and nested MainCode with embedded HLSL [[ ]]', () => {
        const text = `
            VertexShader =
            {
                MainCode VertexShaderSimple
                    ConstantBuffers = { Common }
                [[
                    VS_OUTPUT main(const VS_INPUT v)
                    {
                        return v;
                    }
                ]]
            }
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.shaderBlocks).to.have.lengthOf(1);
        expect(doc.allMainCodes).to.have.lengthOf(1);

        const mainCode = doc.allMainCodes[0]!;
        expect(mainCode.type).to.equal('MainCode');
        expect(mainCode.name).to.equal('VertexShaderSimple');
        expect(mainCode.properties.ConstantBuffers).to.equal('Common');

        // Verify HLSL content is extracted
        expect(mainCode.children).to.have.lengthOf(1);
        const hlslNode = mainCode.children[0]!;
        expect(hlslNode.name).to.equal('HLSL Code');
        expect(hlslNode.hlslContent).to.contain('VS_OUTPUT main');
        expect(hlslNode.hlslContent).to.contain('return v;');
    });

    it('parses Effect blocks and handles property assignments', () => {
        const text = `
            Effect Simple
            {
                VertexShader = "VertexShaderSimple"
                PixelShader = "PixelShaderSimple"
                Defines = { "IS_SHADOW" }
            }
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.effects).to.have.lengthOf(1);

        const effect = doc.effects[0]!;
        expect(effect.type).to.equal('Effect');
        expect(effect.name).to.equal('Simple');
        expect(effect.properties.VertexShader).to.equal('VertexShaderSimple');
        expect(effect.properties.PixelShader).to.equal('PixelShaderSimple');
        expect(effect.properties.Defines).to.equal('"IS_SHADOW"');
    });

    it('ignores DSL comments and preprocessors without shifting coordinate offsets', () => {
        const text = `
            // This is a comment
            VertexStruct VS_INPUT
            {
                /* nested block comment */
                float4 vPosition : POSITION;
                #SEntityCustomDataInstance
                float4 vColor : COLOR;
            };
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.vertexStructs).to.have.lengthOf(1);

        const struct = doc.vertexStructs[0]!;
        expect(struct.name).to.equal('VS_INPUT');
        expect(struct.children).to.have.lengthOf(2);

        expect(struct.children[0]!.name).to.equal('vPosition');
        expect(struct.children[1]!.name).to.equal('vColor');

        // Check if ranges are mapped correctly
        const positionOffset = text.indexOf('float4 vPosition : POSITION;');
        const expectedLine = text.substring(0, positionOffset).split('\n').length - 1;
        expect(struct.children[0]!.range.start.line).to.equal(expectedLine);
    });

    it('is highly tolerant of unrecognized or dangling braced syntax', () => {
        const text = `
            UnrecognizedKeyword =
            {
                SomeRandomProp = 42
            }
            VertexStruct VS_OK
            {
                float4 pos : POSITION;
            };
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        // VS_OK should still be successfully parsed!
        expect(doc.vertexStructs).to.have.lengthOf(1);
        expect(doc.vertexStructs[0]!.name).to.equal('VS_OK');
    });

    it('parses top-level Code [[ ]] blocks used in .fxh header files', () => {
        const text = `
            Code
            [[
                static const float3 SUN_DIFFUSE = float3(0.226f, 0.182f, 0.36f);
            ]]
        `;
        const doc = parsePdxShader('file:///test.fxh', text);
        expect(doc.codeBlocks).to.have.lengthOf(1);

        const codeBlock = doc.codeBlocks[0]!;
        expect(codeBlock.type).to.equal('CodeBlock');
        expect(codeBlock.name).to.equal('Code');
        expect(codeBlock.hlslContent).to.contain('SUN_DIFFUSE');
        expect(codeBlock.children).to.have.lengthOf(1);
        expect(codeBlock.children[0]!.name).to.equal('HLSL Code');
    });

    it('parses Samplers inside PixelShader blocks', () => {
        const text = `
            PixelShader =
            {
                Samplers =
                {
                    SimpleTexture =
                    {
                        Index = 0
                        MagFilter = "Linear"
                    }
                }
            }
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.shaderBlocks).to.have.lengthOf(1);

        const ps = doc.shaderBlocks[0]!;
        expect(ps.name).to.equal('PixelShader');
        // Samplers should be a child of PixelShader
        const samplers = ps.children.find(c => c.type === 'Samplers');
        expect(samplers).to.not.be.undefined;
        expect(doc.allSamplers).to.have.lengthOf(1);
        expect(doc.allSamplers[0]!.name).to.equal('SimpleTexture');
    });

    it('parses multiple MainCode blocks within one ShaderBlock', () => {
        const text = `
            VertexShader =
            {
                MainCode ShaderA
                    ConstantBuffers = { Common }
                [[
                    void mainA() {}
                ]]

                MainCode ShaderB
                    ConstantBuffers = { Shadow }
                [[
                    void mainB() {}
                ]]
            }
        `;
        const doc = parsePdxShader('file:///test.shader', text);
        expect(doc.allMainCodes).to.have.lengthOf(2);
        expect(doc.allMainCodes[0]!.name).to.equal('ShaderA');
        expect(doc.allMainCodes[0]!.properties.ConstantBuffers).to.equal('Common');
        expect(doc.allMainCodes[1]!.name).to.equal('ShaderB');
        expect(doc.allMainCodes[1]!.properties.ConstantBuffers).to.equal('Shadow');

        // Each should have HLSL content
        expect(doc.allMainCodes[0]!.children[0]!.hlslContent).to.contain('mainA');
        expect(doc.allMainCodes[1]!.children[0]!.hlslContent).to.contain('mainB');
    });
});
