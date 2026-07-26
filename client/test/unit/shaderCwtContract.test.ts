import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

describe('Stellaris Shader CWT and ABI evidence contracts', () => {
    const configRoot = path.resolve(__dirname, '../../../submodules/cwtools-stellaris-config/config');

    it('models every Shader Effect field with the dedicated CWT field kind', () => {
        const cwtFiles = walk(configRoot).filter(file => file.toLowerCase().endsWith('.cwt'));
        const shaderAssignments: Array<{ file: string; line: number; rhs: string }> = [];
        const shaderFileAssignments: Array<{ file: string; line: number; rhs: string }> = [];

        for (const file of cwtFiles) {
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            lines.forEach((rawLine, index) => {
                const line = stripComment(rawLine);
                const shader = line.match(/^\s*shader\s*=\s*(.*?)\s*$/i);
                if (shader?.[1]) shaderAssignments.push({ file, line: index + 1, rhs: shader[1] });
                const effectFile = line.match(/^\s*effectFile\s*=\s*(.*?)\s*$/i);
                if (effectFile?.[1]) shaderFileAssignments.push({ file, line: index + 1, rhs: effectFile[1] });
            });
        }

        expect(shaderAssignments, 'the audited Shader Effect field count changed').to.have.length(5);
        expect(shaderAssignments.every(assignment => assignment.rhs === '$shader_effect'), JSON.stringify(shaderAssignments, null, 2)).to.equal(true);
        expect(shaderFileAssignments, 'the audited Shader file field count changed').to.have.length(2);
        expect(shaderFileAssignments.every(assignment => /^filepath\[gfx\/FX\/,\.shader\]$/i.test(assignment.rhs)), JSON.stringify(shaderFileAssignments, null, 2)).to.equal(true);
        expect(cwtFiles.some(file => /#\s*TODO:\s*Shader keys/i.test(fs.readFileSync(file, 'utf8')))).to.equal(false);
    });

    it('keeps the completed audit fail-closed and synchronized with the curated catalog', () => {
        const audit = readJson(path.join(configRoot, 'shader', 'abi-audit.json'));
        const catalog = readJson(path.join(configRoot, 'shader', 'abi-catalog.json'));
        const rendererContracts = readJson(path.join(configRoot, 'shader', 'renderer-contracts.json'));

        expect(audit._schema).to.equal('cwtools/shader-abi-audit/v1');
        expect(audit.game_version).to.equal(catalog.game_version);
        expect(audit.review_status).to.equal('complete');
        expect(audit.automatic_promotion).to.equal(false);
        expect(audit.confirmed_engine_entries).to.deep.equal(catalogIdentities(catalog.entries));
        expect(audit.candidate_universe).to.deep.include({
            shader_files: 49,
            effect_declarations: 473,
            unique_effect_names: 438,
        });
        const executableScan = isRecord(audit.executable_string_scan) ? audit.executable_string_scan : {};
        expect(executableScan.ascii_hits).to.equal(80);
        expect(Array.isArray(executableScan.ascii_effect_names) ? executableScan.ascii_effect_names : []).to.have.length(80);
        expect(executableScan.utf16le_hits).to.equal(3);
        expect(executableScan.utf16le_effect_names).to.deep.equal(['Down', 'Text', 'Texture']);
        const evidenceReviews = Array.isArray(audit.evidence_reviews)
            ? audit.evidence_reviews.filter(isRecord)
            : [];
        expect(evidenceReviews.map(review => review.stage)).to.have.members([
            'vanilla_shader_inventory',
            'textual_call_sites',
            'renderer_contracts',
            'executable_or_runtime',
        ]);
        const contracts = Array.isArray(rendererContracts.contracts)
            ? rendererContracts.contracts.filter(isRecord)
            : [];
        const rendererFiles = new Set(contracts.map(contract => String(contract.shader_file).toLowerCase()));
        expect(rendererFiles.size).to.equal(9);
    });
});

function walk(root: string): string[] {
    return fs.readdirSync(root, { withFileTypes: true })
        .flatMap(entry => {
            const fullPath = path.join(root, entry.name);
            return entry.isDirectory() ? walk(fullPath) : entry.isFile() ? [fullPath] : [];
        })
        .sort((left, right) => left.localeCompare(right));
}

function stripComment(line: string): string {
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index]!;
        if (escaped) escaped = false;
        else if (char === '\\' && quoted) escaped = true;
        else if (char === '"') quoted = !quoted;
        else if (char === '#' && !quoted) return line.slice(0, index);
    }
    return line;
}

function readJson(file: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) throw new Error(`Expected a JSON object: ${file}`);
    return parsed;
}

function catalogIdentities(entries: unknown): string[] {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter(isRecord)
        .map(entry => `${String(entry.name).toLowerCase()}|${String(entry.shader_file ?? '').replace(/\\/g, '/').toLowerCase()}`)
        .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
