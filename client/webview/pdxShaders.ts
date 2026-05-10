/**
 * PDX（Paradox）游戏引擎的 GLSL 着色器片段。
 * 用于在 Three.js MeshStandardMaterial 的 onBeforeCompile 中注入自定义着色逻辑，
 * 使 Stellaris 的 DDS 贴图（法线 RRxG 编码、specular alpha、自发光遮罩）正确渲染。
 */

// ── 顶部辅助函数（注入到 fragmentShader 最前面） ─────────────────────────────
export const pdxHelperFunctions = `
// PDX RRxG 法线解包辅助函数
// 参照 standardfuncsgfx.fxh 中的 UnpackRRxGNormal
vec3 unpackPdxRRxGNormal(sampler2D nmap, vec2 uv) {
    vec4 pdx = texture2D(nmap, uv);
    float nx = pdx.g * 2.0 - 1.0;
    float ny = -(pdx.a * 2.0 - 1.0);
    float nz = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
    return vec3(nx, ny, nz);
}
// 从法线贴图 B 通道提取自发光遮罩
float getPdxEmissive(sampler2D nmap, vec2 uv) {
    return texture2D(nmap, uv).b;
}
`;

// ── 法线贴图替换片段（替换 #include <normal_fragment_maps>） ──────────────────
export const pdxNormalFragmentMaps = `
// PDX 法线贴图解包（替换 Three.js 默认法线贴图处理）
#ifdef USE_NORMALMAP_OBJECTSPACE
    normal = unpackPdxRRxGNormal(normalMap, vNormalMapUv);
    #ifdef FLIP_SIDED
        normal = -normal;
    #endif
    #ifdef DOUBLE_SIDED
        normal = normal * faceDirection;
    #endif
    normal = normalize(normalMatrix * normal);
#elif defined(USE_NORMALMAP_TANGENTSPACE)
    vec3 mapN = unpackPdxRRxGNormal(normalMap, vNormalMapUv);
    mapN.xy *= normalScale;
    normal = normalize(tbn * mapN);
#elif defined(USE_BUMPMAP)
    normal = perturbNormalArb(-vViewPosition, normal, dHdxy_fwd(), faceDirection);
#endif
`;

// ── 粗糙度替换片段（替换 #include <roughnessmap_fragment>） ───────────────────
export const pdxRoughnessFragment = `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
    vec4 pdxSpecProps = texture2D(roughnessMap, vRoughnessMapUv);
    roughnessFactor *= (1.0 - pdxSpecProps.a);
#endif
`;

// ── 金属度替换片段（替换 #include <metalnessmap_fragment>） ───────────────────
export const pdxMetalnessFragment = `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
    vec4 pdxMetalProps = texture2D(metalnessMap, vMetalnessMapUv);
    float rawMetal = pdxMetalProps.b;
    float remappedMetal = 1.0 - (1.0 - rawMetal) * (1.0 - rawMetal);
    metalnessFactor *= remappedMetal;
#endif
`;

// ── 自发光替换片段（替换 #include <emissivemap_fragment>） ────────────────────
export const pdxEmissiveFragment = `
// PDX 自发光：法线贴图 B 通道作为遮罩
float pdxEmissiveMask = getPdxEmissive(normalMap, vNormalMapUv);
#ifdef USE_MAP
    vec4 pdxDiffuseForEmissive = texture2D(map, vMapUv);
    totalEmissiveRadiance = pdxDiffuseForEmissive.rgb * pdxEmissiveMask;
#else
    totalEmissiveRadiance = vec3(pdxEmissiveMask);
#endif
`;
