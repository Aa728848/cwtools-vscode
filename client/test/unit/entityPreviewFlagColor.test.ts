import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { pdxFlagColorLightingFragment } from '../../webview/pdxShaders';

describe('entity preview flag color', () => {
    const root = path.resolve(__dirname, '../../..');
    const host = fs.readFileSync(path.join(root, 'client/extension/entityPanel.ts'), 'utf8');
    const webview = fs.readFileSync(path.join(root, 'client/webview/entityPreview.ts'), 'utf8');

    it('offers common flag colors in the model preview toolbar', () => {
        expect(host).to.include('id="sel-flag-color"');
        for (const color of ['red', 'green', 'blue', 'yellow', 'orange', 'purple', 'cyan', 'white']) {
            expect(host).to.include(`<option value="${color}"`);
        }
    });

    it('uses SpecularMap.R as a neutral-at-black multiplier for diffuse and reflections', () => {
        expect(pdxFlagColorLightingFragment).to.include('texture2D(roughnessMap, vRoughnessMapUv).r');
        expect(pdxFlagColorLightingFragment).to.include('mix(vec3(1.0), pdxFlagColor, pdxFlagMask)');
        expect(pdxFlagColorLightingFragment).to.include('reflectedLight.directDiffuse *= pdxFlagMultiplier');
        expect(pdxFlagColorLightingFragment).to.include('reflectedLight.indirectDiffuse *= pdxFlagMultiplier');
        expect(pdxFlagColorLightingFragment).to.include('reflectedLight.directSpecular *= pdxFlagMultiplier');
        expect(pdxFlagColorLightingFragment).to.include('reflectedLight.indirectSpecular *= pdxFlagMultiplier');
    });

    it('updates a shared shader uniform without rebuilding model materials', () => {
        expect(webview).to.include('shader.uniforms.pdxFlagColor = flagColorUniform');
        expect(webview).to.include("'#include <lights_fragment_end>', pdxFlagColorLightingFragment");
        expect(webview).to.include('flagColorUniform.value.setHex(FLAG_COLOR_PRESETS[preset])');
    });
});
