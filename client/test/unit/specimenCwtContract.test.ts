import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Stellaris specimen CWT contract.
 *
 * Vanilla `common/specimens/specimens.txt` never declares `category` inside a
 * specimen's `resources` block (every specimen is `resources = { produces = {...} }`),
 * so `category` must stay optional. With the default `1..1` cardinality the rule
 * reported "Missing category, expecting at least 1" (CW242) for all 64 vanilla
 * specimens that ship a `resources` block.
 */
describe('Stellaris specimen CWT contract', () => {
    const configPath = path.resolve(
        __dirname,
        '../../../submodules/cwtools-stellaris-config/config/common/specimens.cwt',
    );
    const config = fs.readFileSync(configPath, 'utf8');

    it('keeps the specimen resources block optional', () => {
        expect(cardinalityOf('resources')).to.equal('0..inf');
    });

    it('keeps category optional inside resources so vanilla specimens validate', () => {
        const resourcesBlock = blockBody('resources');
        expect(cardinalityBefore(resourcesBlock, 'category'), 'category must declare an explicit optional cardinality').to.equal('0..1');
        expect(resourcesBlock).to.include('category = <economic_category>');
    });

    it('accepts the vanilla produces-only resources shape through the economic template alias', () => {
        // Vanilla writes resources = { produces = { <resource> = <float> } };
        // produces comes from the economic_template alias, so the specimen rule
        // must keep delegating to it rather than re-declaring the block.
        expect(blockBody('resources')).to.include(
            'alias_name[economic_template] = alias_match_left[economic_template]',
        );
        const templateConfig = fs.readFileSync(
            path.resolve(__dirname, '../../../submodules/cwtools-stellaris-config/config/common/common_economic_templates.cwt'),
            'utf8',
        );
        expect(templateConfig).to.include('alias[economic_template:produces] = {');
    });

    /** Cardinality declared on the line(s) directly above `key = ...` inside specimen. */
    function cardinalityOf(key: string): string | undefined {
        return cardinalityBefore(blockBody('specimen'), key);
    }

    function cardinalityBefore(body: string, key: string): string | undefined {
        const lines = body.split(/\r?\n/);
        const index = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
        expect(index, `${key} should be declared`).to.be.greaterThan(-1);
        for (let i = index - 1; i >= 0; i--) {
            const match = /^\s*##\s*cardinality\s*=\s*(\S+)\s*$/.exec(lines[i]!);
            if (match) return match[1];
            if (lines[i]!.trim() !== '' && !lines[i]!.trim().startsWith('#')) break;
        }
        return undefined;
    }

    /** Body of the first `key = { ... }` block in the file, braces balanced. */
    function blockBody(key: string): string {
        const header = new RegExp(`^\\s*${key}\\s*=\\s*\\{\\s*$`, 'm');
        const headerMatch = header.exec(config);
        expect(headerMatch, `${key} block should exist`).to.not.equal(null);
        const open = config.indexOf('{', headerMatch!.index);
        let depth = 0;
        for (let index = open; index < config.length; index++) {
            if (config[index] === '{') depth++;
            else if (config[index] === '}' && --depth === 0) return config.slice(open + 1, index);
        }
        throw new Error(`${key} block is not closed`);
    }
});
