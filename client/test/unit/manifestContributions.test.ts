import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

interface MenuItem { command?: string; alt?: string; submenu?: string }

describe('release manifest contributions', () => {
    it('only references declared commands and submenus from menus', () => {
        const manifestPath = path.resolve(__dirname, '../../../release/package.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            contributes?: {
                commands?: Array<{ command?: string }>;
                submenus?: Array<{ id?: string }>;
                menus?: Record<string, MenuItem[]>;
            };
        };
        const commands = new Set((manifest.contributes?.commands ?? []).map(item => item.command));
        const submenus = new Set((manifest.contributes?.submenus ?? []).map(item => item.id));
        const dangling: string[] = [];
        for (const [menu, items] of Object.entries(manifest.contributes?.menus ?? {})) {
            for (const item of items) {
                for (const ref of [item.command, item.alt]) {
                    if (ref !== undefined && !commands.has(ref)) dangling.push(`${menu}: ${ref}`);
                }
                if (item.submenu !== undefined && !submenus.has(item.submenu)) dangling.push(`${menu}: submenu ${item.submenu}`);
            }
        }
        expect(dangling).to.deep.equal([]);
    });
});
