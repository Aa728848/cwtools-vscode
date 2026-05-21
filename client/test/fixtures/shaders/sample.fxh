# ---------------------------------------------------------------
# Shared constants and utility functions
# ---------------------------------------------------------------

Code
[[

static const float3 SUN_DIFFUSE = float3(0.226f, 0.182f, 0.36f);
static const float3 LUMINANCE_VECTOR = float3(0.2125f, 0.7154f, 0.0721f);

float3 ToLinear(float3 sRGB)
{
    return pow(abs(sRGB), 2.2f);
}

float3 ToGamma(float3 vLinear)
{
    return pow(abs(vLinear), 1.0f / 2.2f);
}

float CalcGlow(float vGlowIntensity, float3 vColor)
{
    return dot(vColor, LUMINANCE_VECTOR) * vGlowIntensity;
}

]]

ConstantBuffer( Util, 5, 50 )
{
    float4 UtilityVector;
}

Code
[[

float GetOverlay(float vBase, float vOverlay, float vMask)
{
    float vResult;
    if (vBase > 0.5f)
        vResult = 1.0f - 2.0f * (1.0f - vBase) * (1.0f - vOverlay);
    else
        vResult = 2.0f * vBase * vOverlay;
    return lerp(vBase, vResult, vMask);
}

]]
