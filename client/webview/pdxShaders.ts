/** 
* GLSL shader fragment for the PDX (Paradox) game engine. 
* Used to inject custom coloring logic in onBeforeCompile of Three.js MeshStandardMaterial, 
* Made Stellaris' DDS maps (normal RRxG encoding, specular alpha, emissive mask) render correctly. 
*/

// ── Top auxiliary function (injected into the front of fragmentShader) ──────────────────────────────
export const pdxHelperFunctions = `
// PDX RRxG normal unpacking auxiliary function
// Refer to UnpackRRxGNormal in standardfuncsgfx.fxh
vec3 unpackPdxRRxGNormal(sampler2D nmap, vec2 uv) {
    vec4 pdx = texture2D(nmap, uv);
    float nx = pdx.g * 2.0 - 1.0;
    float ny = -(pdx.a * 2.0 - 1.0);
    float nz = sqrt(max(0.0, 1.0 - nx * nx - ny * ny));
    return vec3(nx, ny, nz);
}
// Extract the self-illumination mask from the normal map B channel
float getPdxEmissive(sampler2D nmap, vec2 uv) {
    return texture2D(nmap, uv).b;
}
`;

// ── Normal map replacement fragments (replaces #include <normal_fragment_maps>) ──────────────────
export const pdxNormalFragmentMaps = `
// PDX normal map unpacking (replacing Three.js default normal map processing)
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

// ── Roughness replacement fragment (replaces #include <roughnessmap_fragment>) ───────────────────
export const pdxRoughnessFragment = `
float roughnessFactor = roughness;
#ifdef USE_ROUGHNESSMAP
    vec4 pdxSpecProps = texture2D(roughnessMap, vRoughnessMapUv);
    roughnessFactor *= (1.0 - pdxSpecProps.a);
#endif
`;

// ── Metalness replacement fragment (replaces #include <metalnessmap_fragment>) ───────────────────
export const pdxMetalnessFragment = `
float metalnessFactor = metalness;
#ifdef USE_METALNESSMAP
    vec4 pdxMetalProps = texture2D(metalnessMap, vMetalnessMapUv);
    float rawMetal = pdxMetalProps.b;
    float remappedMetal = 1.0 - (1.0 - rawMetal) * (1.0 - rawMetal);
    metalnessFactor *= remappedMetal;
#endif
`;

// ── Emissive replacement fragment (replaces #include <emissivemap_fragment>) ────────────────────
export const pdxEmissiveFragment = `
// PDX self-illumination: normal map B channel as mask
float pdxEmissiveMask = getPdxEmissive(normalMap, vNormalMapUv);
#ifdef USE_MAP
    vec4 pdxDiffuseForEmissive = texture2D(map, vMapUv);
    totalEmissiveRadiance = pdxDiffuseForEmissive.rgb * pdxEmissiveMask;
#else
    totalEmissiveRadiance = vec3(pdxEmissiveMask);
#endif
`;
