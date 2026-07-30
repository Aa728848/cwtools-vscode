import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Stellaris particle CWT discovery contract', () => {
    const configPath = path.resolve(
        __dirname,
        '../../../submodules/cwtools-stellaris-config/config/gfx/particles.cwt',
    );
    const config = fs.readFileSync(configPath, 'utf8');

    it('discovers filtered particle definitions throughout gfx', () => {
        expect(typeDefinition('particle')).to.deep.include({
            keyFilter: 'pdxparticle',
            nameField: 'name',
            path: 'game/gfx',
        });
        expect(typeDefinition('particle_type')).to.deep.include({
            keyFilter: 'particle',
            nameField: 'name',
            path: 'game/gfx',
        });
    });

    function typeDefinition(name: string): {
        keyFilter?: string;
        nameField?: string;
        path?: string;
    } {
        const header = `type[${name}]`;
        const headerIndex = config.indexOf(header);
        expect(headerIndex, `${header} should exist`).to.be.greaterThan(-1);

        const preceding = config.slice(0, headerIndex).match(/##\s*type_key_filter\s*=\s*(\S+)\s*$/);
        const blockStart = config.indexOf('{', headerIndex);
        let depth = 0;
        let blockEnd = -1;
        for (let index = blockStart; index < config.length; index++) {
            if (config[index] === '{') depth++;
            else if (config[index] === '}' && --depth === 0) {
                blockEnd = index;
                break;
            }
        }
        expect(blockEnd, `${header} should have a closed block`).to.be.greaterThan(blockStart);
        const block = config.slice(blockStart + 1, blockEnd);

        return {
            keyFilter: preceding?.[1],
            nameField: block.match(/^\s*name_field\s*=\s*(\S+)\s*$/m)?.[1],
            path: block.match(/^\s*path\s*=\s*"([^"]+)"\s*$/m)?.[1],
        };
    }
});
