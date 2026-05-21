// Complex shader fixture — covers edge cases:
// - Multiple MainCode per ShaderBlock
// - @ifdef preprocessor
// - # structure tags
// - Nested comments
// - Multiple Effects sharing shaders

Includes = {
    "constants.fxh"
    "standardfuncsgfx.fxh"
    "pdxmesh.fxh"
}

VertexStruct VS_INPUT_MESH
{
    float4 vPosition  : POSITION;
    float3 vNormal    : TEXCOORD0;
    float4 vTangent   : TEXCOORD1;
    float2 vUV0       : TEXCOORD2;
    @ifdef PDX_MESH_UV1
    float2 vUV1       : TEXCOORD3;
    @endif
};

VertexStruct VS_OUTPUT_MESH
{
    float4 vPosition  : PDX_POSITION;
    float3 vNormal    : TEXCOORD0;
    float2 vUV0       : TEXCOORD1;
    float3 vWorldPos  : TEXCOORD2;
};

ConstantBuffer( Common, 0, 0 )
{
    float4x4 ViewProjectionMatrix;
    float4x4 ViewMatrix;
    float4   vCamPos;
    float4   vCamRightDir;
    float4   vCamLookAtDir;
    float4   vCamUpDir;
    float4   HdrRange_Time_ClipHeight;
    float4   SystemLightPosRadius;
    float4   SystemLightColorFalloff;
    float4   SystemBackLightDiffuse;
    float4   AmbientDiffuse;
    float4   CubemapCalc;
}

ConstantBuffer( Shadow, 1, 20 )
{
    float4x4 ShadowMapTextureMatrix;
}

ConstantBuffer( Mesh, 2, 28 )
{
    #SEntityCustomDataInstance
    float4x4 WorldMatrix;
    float4   Erosion;
    float4   AtlasHalfColor;
    float4   AtlasCoordinate;
}

VertexShader =
{
    MainCode VertexShaderStandard
        ConstantBuffers = { Common, Mesh }
    [[
        VS_OUTPUT_MESH main(const VS_INPUT_MESH v)
        {
            VS_OUTPUT_MESH Out;
            float4 vWorldPos = mul(WorldMatrix, v.vPosition);
            Out.vPosition = mul(ViewProjectionMatrix, vWorldPos);
            Out.vNormal = normalize(mul((float3x3)WorldMatrix, v.vNormal));
            Out.vUV0 = v.vUV0;
            Out.vWorldPos = vWorldPos.xyz;
            return Out;
        }
    ]]

    MainCode VertexShaderShadow
        ConstantBuffers = { Common, Shadow, Mesh }
    [[
        float4 main(const VS_INPUT_MESH v) : PDX_POSITION
        {
            float4 vWorldPos = mul(WorldMatrix, v.vPosition);
            return mul(ViewProjectionMatrix, vWorldPos);
        }
    ]]
}

PixelShader =
{
    Samplers =
    {
        DiffuseMap =
        {
            Index = 0
            MagFilter = "Linear"
            MinFilter = "Linear"
            MipFilter = "Linear"
            AddressU = "Wrap"
            AddressV = "Wrap"
        }
        NormalMap =
        {
            Index = 1
            MagFilter = "Linear"
            MinFilter = "Linear"
            MipFilter = "Linear"
            AddressU = "Wrap"
            AddressV = "Wrap"
        }
        /* EnvironmentMap is optional — only used with reflection */
        EnvironmentMap =
        {
            Index = 4
            MagFilter = "Linear"
            MinFilter = "Linear"
            MipFilter = "Linear"
            AddressU = "Clamp"
            AddressV = "Clamp"
            Type = "Cube"
        }
    }

    MainCode PixelShaderStandard
        ConstantBuffers = { Common, Mesh }
    [[
        float4 main(VS_OUTPUT_MESH In) : PDX_COLOR
        {
            float4 vDiffuse = tex2D(DiffuseMap, In.vUV0);
            float3 vNormal = normalize(In.vNormal);

            // Simple Lambert lighting
            float NdotL = saturate(dot(vNormal, normalize(SystemLightPosRadius.xyz)));
            float3 vColor = vDiffuse.rgb * (AmbientDiffuse.rgb + SystemLightColorFalloff.rgb * NdotL);

            return float4(vColor, vDiffuse.a);
        }
    ]]

    MainCode PixelShaderShadow
    [[
        float4 main(float4 vPos : PDX_POSITION) : PDX_COLOR
        {
            return float4(1.0f, 1.0f, 1.0f, 1.0f);
        }
    ]]
}

BlendState BlendStateAdditiveBlend
{
    BlendEnable = yes
    SourceBlend = "SRC_ALPHA"
    DestBlend = "ONE"
    WriteMask = "0x0F"
}

BlendState BlendStateAlphaBlend
{
    BlendEnable = yes
    SourceBlend = "SRC_ALPHA"
    DestBlend = "INV_SRC_ALPHA"
    SourceAlpha = "ONE"
    DestAlpha = "ONE"
}

DepthStencilState DepthStencilNoZWrite
{
    DepthEnable = yes
    DepthWriteMask = "DEPTH_WRITE_ZERO"
}

RasterizerState RasterizerStateNoCulling
{
    CullMode = "none"
    FillMode = "solid"
    FrontCCW = no
}

Effect PdxMeshStandard
{
    VertexShader = "VertexShaderStandard"
    PixelShader = "PixelShaderStandard"
}

Effect PdxMeshShadow
{
    VertexShader = "VertexShaderShadow"
    PixelShader = "PixelShaderShadow"
    Defines = { "IS_SHADOW" }
}

Effect PdxMeshAlphaBlend
{
    VertexShader = "VertexShaderStandard"
    PixelShader = "PixelShaderStandard"
    BlendState = "BlendStateAlphaBlend"
    DepthStencilState = "DepthStencilNoZWrite"
    RasterizerState = "RasterizerStateNoCulling"
}
