struct ShaderContractInput
{
    float2 Uv;
};

float4 ShaderContractHelper(float2 uv, float strength)
{
    float weight = strength;
    return float4(uv, weight, 1.0);
}

float4 ShaderContractMain(ShaderContractInput input)
{
    return ShaderContractHelper(input.Uv, 0.5);
}
