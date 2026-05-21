Includes = {
    "constants.fxh"
    "standardfuncsgfx.fxh"
}

VertexStruct VS_INPUT
{
    float4 vPosition  : POSITION;
    float2 vTexCoord  : TEXCOORD0;
};

ConstantBuffer( Common, 0, 0 )
{
    float4x4 ViewProjectionMatrix;
    float4   vTimeRandom;
}

VertexShader =
{
    MainCode VertexShaderSimple
        ConstantBuffers = { Common }
    [[
        VS_OUTPUT main(const VS_INPUT v)
        {
            VS_OUTPUT Out;
            Out.vPosition = mul(ViewProjectionMatrix, v.vPosition);
            Out.vTexCoord = v.vTexCoord;
            return Out;
        }
    ]]
}

PixelShader =
{
    Samplers =
    {
        DiffuseTexture =
        {
            Index = 0
            MagFilter = "Linear"
            MinFilter = "Linear"
            MipFilter = "Linear"
            AddressU = "Wrap"
            AddressV = "Wrap"
        }
    }

    MainCode PixelShaderSimple
        ConstantBuffers = { Common }
    [[
        float4 main(VS_OUTPUT In) : PDX_COLOR
        {
            float4 vColor = tex2D(DiffuseTexture, In.vTexCoord);
            return vColor;
        }
    ]]
}

BlendState BlendStateAlphaBlend
{
    BlendEnable = yes
    SourceBlend = "SRC_ALPHA"
    DestBlend = "INV_SRC_ALPHA"
}

DepthStencilState DepthStencilNoZWrite
{
    DepthEnable = yes
    DepthWriteMask = "DEPTH_WRITE_ZERO"
}

RasterizerState RasterizerStateNoCulling
{
    CullMode = "none"
}

Effect Simple
{
    VertexShader = "VertexShaderSimple"
    PixelShader = "PixelShaderSimple"
}

Effect AlphaBlended
{
    VertexShader = "VertexShaderSimple"
    PixelShader = "PixelShaderSimple"
    BlendState = "BlendStateAlphaBlend"
    DepthStencilState = "DepthStencilNoZWrite"
    Defines = { "IS_TRANSPARENT" }
}
