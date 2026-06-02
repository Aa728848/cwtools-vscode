import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('PDX Shader Grammar & Language Configuration', () => {
    const grammarPath = path.join(__dirname, '../../../release/syntaxes/pdxshader.tmLanguage.json');
    const configPath = path.join(__dirname, '../../../release/language-configuration-pdxshader.json');

    describe('TextMate Grammar Structural Validation', () => {
        let grammar: any;

        before(() => {
            expect(fs.existsSync(grammarPath), 'grammar file should exist').to.be.true;
            const content = fs.readFileSync(grammarPath, 'utf8');
            grammar = JSON.parse(content);
        });

        it('has valid metadata', () => {
            expect(grammar.name).to.equal('PDX Shader');
            expect(grammar.scopeName).to.equal('source.pdx-shader');
            expect(grammar.patterns).to.be.an('array');
            expect(grammar.repository).to.be.an('object');
        });

        it('contains all expected patterns in repository', () => {
            const expectedKeys = [
                'comments', 'embedded-hlsl', 'preprocessors',
                'named-declarations', 'keywords', 'types',
                'semantics', 'strings', 'numbers'
            ];
            for (const key of expectedKeys) {
                expect(grammar.repository, `missing repository key: ${key}`).to.have.property(key);
            }
        });

        it('has structurally correct embedded-hlsl pattern', () => {
            const hlslPattern = grammar.repository['embedded-hlsl'].patterns[0];
            expect(hlslPattern.begin).to.equal('\\[\\[');
            expect(hlslPattern.end).to.equal('\\]\\]');
            expect(hlslPattern.contentName).to.equal('source.hlsl');
            expect(hlslPattern.patterns).to.be.an('array');
            expect(hlslPattern.patterns).to.deep.include({ include: 'source.hlsl' });
            expect(hlslPattern.patterns.map((p: any) => p.name)).to.include('support.variable.readwrite.hlsl.pdx');
        });

        it('includes named-declarations before keywords for correct precedence', () => {
            const patternIncludes = grammar.patterns.map((p: any) => p.include);
            const namedIdx = patternIncludes.indexOf('#named-declarations');
            const kwIdx = patternIncludes.indexOf('#keywords');
            expect(namedIdx, 'named-declarations should exist in patterns').to.be.greaterThan(-1);
            expect(kwIdx, 'keywords should exist in patterns').to.be.greaterThan(-1);
            expect(namedIdx, 'named-declarations should come before keywords').to.be.lessThan(kwIdx);
        });
    });

    describe('Regex Matcher Behavior Verification', () => {
        let grammar: any;

        before(() => {
            const content = fs.readFileSync(grammarPath, 'utf8');
            grammar = JSON.parse(content);
        });

        function getRegex(key: string, index = 0): RegExp {
            const pattern = grammar.repository[key].patterns[index];
            const matchStr = pattern.match || pattern.begin;
            return new RegExp(matchStr);
        }

        // --- Comments ---
        it('matches DSL comments correctly', () => {
            const commentPatterns = grammar.repository['comments'].patterns;
            const doubleSlashPattern = commentPatterns.find((p: any) => p.name === 'comment.line.double-slash.pdx-shader');
            const numberSignPattern = commentPatterns.find((p: any) => p.name === 'comment.line.number-sign.pdx-shader');
            expect(doubleSlashPattern, 'double-slash comment pattern').to.exist;
            expect(numberSignPattern, 'number-sign comment pattern').to.exist;
            const doubleSlashRegex = new RegExp(doubleSlashPattern.match);
            const numberSignRegex = new RegExp(numberSignPattern.match);

            expect(doubleSlashRegex.test('// This is a line comment')).to.be.true;
            expect(doubleSlashRegex.test('  // Indented line comment')).to.be.true;
            expect(doubleSlashRegex.test('float4 color; // with code before')).to.be.true;

            // DSL-layer # comments (structure tags)
            expect(numberSignRegex.test('#SEntityCustomDataInstance')).to.be.true;
            expect(numberSignRegex.test('#SPlanetMeshUserData')).to.be.true;
            expect(numberSignRegex.test('#SGameShipConstants')).to.be.true;
            expect(numberSignRegex.test('  # indented comment')).to.be.true;

            // Should NOT match standard C preprocessors
            expect(numberSignRegex.test('#define float4 vec4')).to.be.false;
            expect(numberSignRegex.test('#ifdef PIXEL_SHADER')).to.be.false;
            expect(numberSignRegex.test('#ifndef MY_MACRO')).to.be.false;
            expect(numberSignRegex.test('#endif')).to.be.false;
            expect(numberSignRegex.test('#include "utils.fxh"')).to.be.false;
            expect(numberSignRegex.test('#pragma once')).to.be.false;
        });

        // --- Preprocessors ---
        it('matches @ preprocessor directives (DSL-level)', () => {
            const atRegex = getRegex('preprocessors', 0);

            expect(atRegex.test('@ifdef PDX_MESH_UV1')).to.be.true;
            expect(atRegex.test('@else')).to.be.true;
            expect(atRegex.test('@endif')).to.be.true;
            expect(atRegex.test('@define MY_MACRO')).to.be.true;
            expect(atRegex.test('@undef MY_MACRO')).to.be.true;

            expect(atRegex.test('ifdef')).to.be.false;
            expect(atRegex.test('else')).to.be.false;
        });

        it('matches # preprocessor directives (C-standard)', () => {
            const hashRegex = getRegex('preprocessors', 1);

            expect(hashRegex.test('#define float4 vec4')).to.be.true;
            expect(hashRegex.test('#ifdef PIXEL_SHADER')).to.be.true;
            expect(hashRegex.test('#ifndef MY_MACRO')).to.be.true;
            expect(hashRegex.test('#else')).to.be.true;
            expect(hashRegex.test('#elif defined(FOO)')).to.be.true;
            expect(hashRegex.test('#endif')).to.be.true;
            expect(hashRegex.test('#include "utils.fxh"')).to.be.true;
            expect(hashRegex.test('#pragma once')).to.be.true;
            expect(hashRegex.test('#undef MY_MACRO')).to.be.true;
        });

        // --- Named Declarations (entity.name) ---
        it('captures Effect names', () => {
            const regex = getRegex('named-declarations', 0);
            const m = 'Effect PdxMeshStandard'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('Effect');
            expect(m![2]).to.equal('PdxMeshStandard');
        });

        it('captures MainCode names', () => {
            const regex = getRegex('named-declarations', 1);
            const m = 'MainCode VertexShaderSimple'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('MainCode');
            expect(m![2]).to.equal('VertexShaderSimple');
        });

        it('captures VertexStruct names', () => {
            const regex = getRegex('named-declarations', 2);
            const m = 'VertexStruct VS_INPUT'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('VertexStruct');
            expect(m![2]).to.equal('VS_INPUT');
        });

        it('captures ConstantBuffer names', () => {
            const regex = getRegex('named-declarations', 3);
            const m = 'ConstantBuffer( Common, 0, 0 )'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('ConstantBuffer');
            expect(m![2]).to.equal('Common');
        });

        it('captures BlendState names', () => {
            const regex = getRegex('named-declarations', 4);
            const m = 'BlendState BlendStateAdditiveBlend'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('BlendState');
            expect(m![2]).to.equal('BlendStateAdditiveBlend');
        });

        it('captures DepthStencilState names', () => {
            const regex = getRegex('named-declarations', 5);
            const m = 'DepthStencilState DepthStencilNoZWrite'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('DepthStencilState');
            expect(m![2]).to.equal('DepthStencilNoZWrite');
        });

        it('captures RasterizerState names', () => {
            const regex = getRegex('named-declarations', 6);
            const m = 'RasterizerState RasterizerStateNoCulling'.match(regex);
            expect(m).to.not.be.null;
            expect(m![1]).to.equal('RasterizerState');
            expect(m![2]).to.equal('RasterizerStateNoCulling');
        });

        // --- DSL Keywords ---
        it('matches DSL keywords correctly', () => {
            const keywordsRegex = getRegex('keywords', 0);
            const parametersRegex = getRegex('keywords', 1);
            const booleanRegex = getRegex('keywords', 2);

            // DSL keywords (including newly added Defines)
            expect(keywordsRegex.test('Includes = {')).to.be.true;
            expect(keywordsRegex.test('VertexStruct VS_INPUT')).to.be.true;
            expect(keywordsRegex.test('ConstantBuffer( Common, 0, 0 )')).to.be.true;
            expect(keywordsRegex.test('VertexShader =')).to.be.true;
            expect(keywordsRegex.test('PixelShader =')).to.be.true;
            expect(keywordsRegex.test('MainCode VertexShaderSimple')).to.be.true;
            expect(keywordsRegex.test('Effect Simple')).to.be.true;
            expect(keywordsRegex.test('BlendState BlendState')).to.be.true;
            expect(keywordsRegex.test('Defines = { "IS_SHADOW" }')).to.be.true;

            // Sampler and filter parameters
            expect(parametersRegex.test('Index = 0')).to.be.true;
            expect(parametersRegex.test('MagFilter = "Linear"')).to.be.true;
            expect(parametersRegex.test('AddressU = "Wrap"')).to.be.true;
            expect(parametersRegex.test('MipMapLodBias = -0.6')).to.be.true;
            expect(parametersRegex.test('MaxAnisotropy = 4')).to.be.true;
            expect(parametersRegex.test('Type = "Cube"')).to.be.true;

            // Blend state parameters
            expect(parametersRegex.test('BlendEnable = yes')).to.be.true;
            expect(parametersRegex.test('SourceBlend = "SRC_ALPHA"')).to.be.true;
            expect(parametersRegex.test('DestBlend = "INV_SRC_ALPHA"')).to.be.true;
            expect(parametersRegex.test('SourceAlpha = "ONE"')).to.be.true;
            expect(parametersRegex.test('DestAlpha = "ONE"')).to.be.true;
            expect(parametersRegex.test('BlendOp = blend_op_add')).to.be.true;
            expect(parametersRegex.test('BlendOpAlpha = blend_op_max')).to.be.true;
            expect(parametersRegex.test('AlphaTest = no')).to.be.true;

            // Depth/stencil parameters
            expect(parametersRegex.test('DepthEnable = yes')).to.be.true;
            expect(parametersRegex.test('DepthFunction = "comparison_less"')).to.be.true;
            expect(parametersRegex.test('DepthWriteMask = "DEPTH_WRITE_ZERO"')).to.be.true;
            expect(parametersRegex.test('StencilEnable = no')).to.be.true;
            expect(parametersRegex.test('FrontStencilFunc = "comparison_equal"')).to.be.true;
            expect(parametersRegex.test('FrontStencilPassOp = "stencil_op_incr"')).to.be.true;
            expect(parametersRegex.test('FrontStencilFailOp = "stencil_op_keep"')).to.be.true;
            expect(parametersRegex.test('FrontStencilDepthFailOp = "stencil_op_keep"')).to.be.true;

            // Rasterizer parameters
            expect(parametersRegex.test('CullMode = "none"')).to.be.true;
            expect(parametersRegex.test('FillMode = "solid"')).to.be.true;
            expect(parametersRegex.test('FrontCCW = no')).to.be.true;

            // Boolean keywords
            expect(booleanRegex.test('yes')).to.be.true;
            expect(booleanRegex.test('no')).to.be.true;
            expect(booleanRegex.test('true')).to.be.true;
            expect(booleanRegex.test('false')).to.be.true;
        });

        // --- Types ---
        it('matches types correctly', () => {
            const regex = getRegex('types', 0);

            expect(regex.test('float')).to.be.true;
            expect(regex.test('float4')).to.be.true;
            expect(regex.test('float4x4')).to.be.true;
            expect(regex.test('int')).to.be.true;
            expect(regex.test('uint4')).to.be.true;
            expect(regex.test('half4')).to.be.true;
            expect(regex.test('bool')).to.be.true;
            expect(regex.test('void')).to.be.true;
            expect(regex.test('sampler2D')).to.be.true;
            expect(regex.test('samplerCube')).to.be.true;
            expect(regex.test('Texture2D')).to.be.true;
            expect(regex.test('Texture2DArray')).to.be.true;
            expect(regex.test('TextureCube')).to.be.true;
            expect(regex.test('SamplerState')).to.be.true;
            expect(regex.test('SamplerComparisonState')).to.be.true;
        });

        // --- Semantics ---
        it('matches semantics correctly', () => {
            const regex = getRegex('semantics', 0);

            const match1 = ': POSITION'.match(regex);
            expect(match1).to.not.be.null;
            expect(match1![0].trim()).to.equal('POSITION');

            const match2 = ': TEXCOORD0'.match(regex);
            expect(match2).to.not.be.null;
            expect(match2![0].trim()).to.equal('TEXCOORD0');

            const match3 = ': PDX_POSITION'.match(regex);
            expect(match3).to.not.be.null;
            expect(match3![0].trim()).to.equal('PDX_POSITION');

            const match4 = ': PDX_COLOR'.match(regex);
            expect(match4).to.not.be.null;

            const match5 = ': SV_TARGET'.match(regex);
            expect(match5).to.not.be.null;
        });

        // --- Numbers ---
        it('matches hex numbers', () => {
            const hexRegex = getRegex('numbers', 0);
            expect(hexRegex.test('0xFF')).to.be.true;
            expect(hexRegex.test('0x0F')).to.be.true;
            expect(hexRegex.test('0xDEAD')).to.be.true;
        });

        it('matches float numbers', () => {
            const floatRegex = getRegex('numbers', 1);
            expect(floatRegex.test('3.14')).to.be.true;
            expect(floatRegex.test('0.5f')).to.be.true;
            expect(floatRegex.test('1.0')).to.be.true;
        });

        it('matches integer numbers', () => {
            const intRegex = getRegex('numbers', 2);
            expect(intRegex.test('42')).to.be.true;
            expect(intRegex.test('0')).to.be.true;
        });

        // --- Strings ---
        it('has escape character support inside strings', () => {
            const stringPatterns = grammar.repository['strings'].patterns[0].patterns;
            expect(stringPatterns).to.be.an('array');
            expect(stringPatterns.some((p: any) => p.name === 'constant.character.escape.pdx-shader')).to.be.true;
        });
    });

    describe('Language Configuration Validation', () => {
        let config: any;

        before(() => {
            expect(fs.existsSync(configPath), 'config file should exist').to.be.true;
            const content = fs.readFileSync(configPath, 'utf8');
            config = JSON.parse(content);
        });

        it('has valid comments configuration', () => {
            expect(config.comments).to.be.an('object');
            expect(config.comments.lineComment).to.equal('//');
            expect(config.comments.blockComment).to.deep.equal(['/*', '*/']);
        });

        it('defines proper brackets and closing pairs', () => {
            expect(config.brackets).to.be.an('array');
            expect(config.autoClosingPairs).to.be.an('array');
            expect(config.surroundingPairs).to.be.an('array');

            // Verify embedded [[ ]] pair is defined
            const bracketsFlat = config.brackets.map((b: string[]) => b.join(' '));
            expect(bracketsFlat).to.include('[[ ]]');

            const autoClosingOpen = config.autoClosingPairs.map((p: any) => p.open || p[0]);
            expect(autoClosingOpen).to.include('[[');
        });

        it('has a wordPattern defined', () => {
            expect(config.wordPattern).to.be.a('string');
            expect(config.wordPattern.length).to.be.greaterThan(0);
        });

        it('has folding markers for [[ ]] and { }', () => {
            expect(config.folding).to.be.an('object');
            expect(config.folding.markers).to.be.an('object');
            expect(config.folding.markers.start).to.be.a('string');
            expect(config.folding.markers.end).to.be.a('string');
        });

        it('has indentation rules', () => {
            expect(config.indentationRules).to.be.an('object');
            expect(config.indentationRules.increaseIndentPattern).to.be.a('string');
            expect(config.indentationRules.decreaseIndentPattern).to.be.a('string');
        });
    });
});
