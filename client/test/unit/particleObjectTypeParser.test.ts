import { expect } from 'chai';
import { parsePdxParticleAliases, resolvePdxParticleEffect } from '../../extension/particleObjectTypeParser';
import type { ParticleEffect } from '../../webview/particleTypes';

describe('particle object type parser', () => {
    it('parses pdxparticle aliases nested inside objectTypes', () => {
        const aliases = parsePdxParticleAliases(`
objectTypes = {
    pdxparticle = {
        name = "scaled_exhaust_particle"
        type = "ship_exhaust_file"
        scale = 2.5
    }
    pdxparticle = { name = direct_particle type = direct_particle scale = 3 }
}
`);
        expect(aliases).to.deep.equal([
            { name: 'scaled_exhaust_particle', type: 'ship_exhaust_file', scale: 2.5 },
            { name: 'direct_particle', type: 'direct_particle', scale: 3 },
        ]);
    });

    it('resolves alias chains and applies object-type scale to the particle effect', () => {
        const base: ParticleEffect = {
            name: 'ship_exhaust_file',
            scale: 2,
            subsystems: [],
            animations: [],
            forces: [],
        };
        const aliases = new Map([
            ['large_exhaust', { name: 'large_exhaust', type: 'medium_exhaust', scale: 3 }],
            ['medium_exhaust', { name: 'medium_exhaust', type: 'ship_exhaust_file', scale: 2 }],
        ]);
        const resolved = resolvePdxParticleEffect('large_exhaust', aliases, new Map([[base.name, base]]));
        expect(resolved?.name).to.equal('large_exhaust');
        expect(resolved?.scale).to.equal(12);
    });
});
