import * as fs from 'fs';
import * as path from 'path';
import {
    addMissingCwtScopeContracts,
    loadScopeAliases,
    scanScopeContracts,
    type ScopeContractFolder,
} from './scope-contracts';

function parseArgs(argv: string[]) {
    const value = (name: string) => {
        const index = argv.indexOf(name);
        return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1]!) : '';
    };
    return {
        vanillaCommon: value('--vanilla-common'),
        config: value('--config'),
        outDir: value('--output') || path.resolve('scope-contracts'),
        apply: argv.includes('--apply'),
        applyConflicts: argv.includes('--apply-conflicts'),
    };
}

function writeIfChanged(file: string, content: string) {
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8') === content) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf-8');
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.vanillaCommon || !args.config) {
        console.error('Usage: npx ts-node tools/rules-sync/scope-contracts-cli.ts --vanilla-common <commonDir> --config <configDir> [--output <outDir>] [--apply] [--apply-conflicts]');
        process.exit(1);
    }

    const report = scanScopeContracts(args.vanillaCommon, args.config);
    const aliases = loadScopeAliases(path.join(args.config, 'scopes.cwt'));
    fs.mkdirSync(args.outDir, { recursive: true });
    writeIfChanged(path.join(args.outDir, 'scope-contracts.generated.json'), JSON.stringify(report, null, 2) + '\n');

    for (const folder of ['on_actions', 'game_rules'] as ScopeContractFolder[]) {
        const cwtFile = path.join(args.config, 'common', `${folder}.cwt`);
        if (!fs.existsSync(cwtFile)) continue;
        const current = fs.readFileSync(cwtFile, 'utf-8');
        const result = addMissingCwtScopeContracts(current, folder, report.contracts, {
            aliases,
            replaceConflicts: args.applyConflicts,
        });
        const candidate = path.join(args.outDir, `${folder}.scope-contracts.candidate.cwt`);
        writeIfChanged(candidate, result.content);
        if ((args.apply || args.applyConflicts) && result.added.length) writeIfChanged(cwtFile, result.content);
        console.log(`[scope-contracts] ${folder}: candidates=${result.added.length}${args.apply || args.applyConflicts ? ' applied' : ''}`);
    }

    const summary = report.summary;
    if (report.gameVersion) console.log(`[scope-contracts] gameVersion=${report.gameVersion}`);
    console.log(`[scope-contracts] extracted=${summary.extracted} high=${summary.highConfidence} missing=${summary.missing} mismatch=${summary.mismatch} unresolved=${summary.unresolved}`);
    console.log(`[scope-contracts] output=${args.outDir}`);
}

main();
