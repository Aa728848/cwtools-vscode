const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
let tsNodeBin = '';

function usage() {
    console.log(`Usage:
  node tools/rules-sync/stellaris-rules-sync.js [scan|check|update|report|contracts] [options]

Modes:
  scan    Generate rules.generated.json and generated CWT candidates.
  check   Generate, compare with the config, and write a check report. Default mode.
  update  Generate append-only CWT candidates under the output directory for review.
  report  Compare fresh game docs + vanilla common against the config baseline and
          write a self-contained visual HTML report (opens in browser).
  contracts  Extract Scope/ROOT/FROM contracts from vanilla comments and emit
             reviewable CWT candidates. Read-only unless --apply is passed.

Options:
  --docs <path>              Stellaris script_documentation directory.
  --config <path>            cwtools-stellaris-config config directory.
  --out <path>               Output directory. Defaults to .rules-sync/stellaris.
  --version <value>          Version label written into rules.generated.json.
  --previous <path>          Previous rules.generated.json for definition diffs.
  --include-vanilla-common   Inventory vanilla Stellaris common/ definitions. Enabled by default.
  --vanilla-common <path>    Vanilla Stellaris common directory.
  --no-vanilla-common        Do not inventory vanilla Stellaris common/ definitions.
  --no-config-common         Do not inventory config/common CWT definitions.
  --no-cwt                   Do not emit generated CWT candidate files during scan.
  --no-open                  Do not open the HTML report in the browser (report mode).
  --apply                    Apply missing high-confidence scope contracts to CWT.
  --apply-conflicts          Replace conflicting CWT contracts with reviewed vanilla evidence.
  --ci                       Preserve check exit code 2 when drift is found.
`);
}

function parseArgs(argv) {
    const args = [...argv];
    let mode = 'check';
    if (args[0] && !args[0].startsWith('-')) mode = args.shift();
    if (mode === 'help' || mode === '--help' || mode === '-h') return { help: true };
    if (!['scan', 'check', 'update', 'report', 'contracts'].includes(mode)) {
        throw new Error(`Unknown mode "${mode}". Expected scan, check, update, report, or contracts.`);
    }

    const opts = {
        mode,
        docs: defaultDocsDir(),
        config: path.join(repoRoot, 'submodules', 'cwtools-stellaris-config', 'config'),
        out: path.join(repoRoot, '.rules-sync', 'stellaris'),
        version: 'local',
        previous: '',
        includeVanillaCommon: true,
        vanillaCommon: '',
        includeConfigCommon: true,
        emitCwt: true,
        openReport: true,
        apply: false,
        applyConflicts: false,
        ci: false,
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--docs':
                opts.docs = path.resolve(args[++i] || '');
                break;
            case '--config':
                opts.config = path.resolve(args[++i] || '');
                break;
            case '--out':
                opts.out = path.resolve(args[++i] || '');
                break;
            case '--version':
                opts.version = args[++i] || opts.version;
                break;
            case '--previous':
                opts.previous = path.resolve(args[++i] || '');
                break;
            case '--include-vanilla-common':
                opts.includeVanillaCommon = true;
                break;
            case '--vanilla-common':
                opts.includeVanillaCommon = true;
                opts.vanillaCommon = path.resolve(args[++i] || '');
                break;
            case '--no-vanilla-common':
                opts.includeVanillaCommon = false;
                break;
            case '--no-config-common':
                opts.includeConfigCommon = false;
                break;
            case '--no-cwt':
                opts.emitCwt = false;
                break;
            case '--no-open':
                opts.openReport = false;
                break;
            case '--apply':
                opts.apply = true;
                break;
            case '--apply-conflicts':
                opts.applyConflicts = true;
                break;
            case '--ci':
                opts.ci = true;
                break;
            case '--help':
            case '-h':
                opts.help = true;
                break;
            default:
                throw new Error(`Unknown option "${arg}".`);
        }
    }

    return opts;
}

function defaultDocsDir() {
    return path.join(os.homedir(), 'Documents', 'Paradox Interactive', 'Stellaris', 'logs', 'script_documentation');
}

function defaultVanillaCommonDir() {
    const candidates = [
        process.env.STELLARIS_COMMON,
        'D:\\Steam\\steamapps\\common\\Stellaris\\common',
        'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stellaris\\common',
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0] || '';
}

function assertDir(name, dir) {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`${name} directory does not exist: ${dir}`);
    }
}

function copyPreviousSnapshot(outDir, explicitPrevious) {
    if (explicitPrevious) return explicitPrevious;
    const generatedJson = path.join(outDir, 'rules.generated.json');
    if (!fs.existsSync(generatedJson)) return '';
    const previousJson = path.join(outDir, 'rules.previous.generated.json');
    fs.copyFileSync(generatedJson, previousJson);
    return previousJson;
}

function run(command, args, allowCheckDrift, ci) {
    const useCmdShim = process.platform === 'win32' && /\.cmd$/i.test(command);
    const spawnCommand = useCmdShim ? (process.env.ComSpec || 'cmd.exe') : command;
    const spawnArgs = useCmdShim
        ? ['/d', '/s', '/c', [command, ...args.map(quoteCmdArg)].join(' ')]
        : args;
    const result = spawnSync(spawnCommand, spawnArgs, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: false,
    });
    if (result.error) throw result.error;
    const status = result.status ?? 1;
    if (allowCheckDrift && status === 2 && !ci) return status;
    if (status !== 0) process.exit(status);
    return status;
}

function quoteCmdArg(value) {
    if (value === '') return '""';
    if (!/[\s"&<>|^]/.test(value)) return value;
    return `"${value.replace(/"/g, '\\"')}"`;
}

function runTsNode(scriptPath, args, allowCheckDrift, ci) {
    const localTsNode = resolveTsNodeBin();
    if (localTsNode) {
        return run(process.execPath, [localTsNode, scriptPath, ...args], allowCheckDrift, ci);
    }
    return run(npxCmd, ['ts-node', scriptPath, ...args], allowCheckDrift, ci);
}

function resolveTsNodeBin() {
    if (tsNodeBin) return tsNodeBin;
    try {
        tsNodeBin = require.resolve('ts-node/dist/bin.js', { paths: [repoRoot] });
    } catch {
        tsNodeBin = '';
    }
    return tsNodeBin;
}

function openInBrowser(filePath) {
    if (process.platform === 'win32') {
        // Node re-quotes composite args for cmd.exe, which mangles
        // `start "" "path"`; pass the command line verbatim instead.
        const result = spawnSync(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `start "" "${filePath}"`],
            { stdio: 'ignore', shell: false, windowsVerbatimArguments: true }
        );
        if (result.error || (result.status ?? 0) !== 0) {
            console.log(`[rules-sync] Open manually: ${filePath}`);
        }
        return;
    }
    const opener = process.platform === 'darwin'
        ? { command: 'open', args: [filePath] }
        : { command: 'xdg-open', args: [filePath] };
    const result = spawnSync(opener.command, opener.args, { stdio: 'ignore', shell: false });
    if (result.error || (result.status ?? 0) !== 0) {
        console.log(`[rules-sync] Open manually: ${filePath}`);
    }
}

function buildCommonArgs(opts) {
    const commonArgs = [];
    const configCommon = path.join(opts.config, 'common');
    if (opts.includeConfigCommon && fs.existsSync(configCommon)) {
        commonArgs.push('--common', configCommon);
    }
    if (opts.includeVanillaCommon) {
        const vanillaCommon = opts.vanillaCommon || defaultVanillaCommonDir();
        assertDir('Vanilla common', vanillaCommon);
        commonArgs.push('--common', vanillaCommon);
    }
    return commonArgs;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        usage();
        return;
    }

    assertDir('Config', opts.config);
    fs.mkdirSync(opts.out, { recursive: true });

    if (opts.mode === 'contracts') {
        const vanillaCommon = opts.vanillaCommon || defaultVanillaCommonDir();
        assertDir('Vanilla common', vanillaCommon);
        const contractsScript = path.join(repoRoot, 'tools', 'rules-sync', 'scope-contracts-cli.ts');
        const contractsOut = path.join(opts.out, 'scope-contracts');
        const contractsArgs = ['--vanilla-common', vanillaCommon, '--config', opts.config, '--output', contractsOut];
        if (opts.apply) contractsArgs.push('--apply');
        if (opts.applyConflicts) contractsArgs.push('--apply-conflicts');
        console.log(`[rules-sync] mode=contracts${opts.apply ? ' apply' : ''}${opts.applyConflicts ? ' apply-conflicts' : ''}`);
        console.log(`[rules-sync] vanillaCommon=${vanillaCommon}`);
        console.log(`[rules-sync] config=${opts.config}`);
        console.log(`[rules-sync] out=${contractsOut}`);
        runTsNode(contractsScript, contractsArgs, false, opts.ci);
        return;
    }

    assertDir('Script documentation', opts.docs);

    if (opts.mode === 'report') {
        const reportScript = path.join(repoRoot, 'tools', 'rules-sync', 'report.ts');
        const reportOut = path.join(opts.out, 'report');
        const reportArgs = ['--docs', opts.docs, '--config', opts.config, '--output', reportOut];
        if (opts.includeVanillaCommon) {
            const vanillaCommon = opts.vanillaCommon || defaultVanillaCommonDir();
            assertDir('Vanilla common', vanillaCommon);
            reportArgs.push('--vanilla-common', vanillaCommon);
        }
        console.log(`[rules-sync] mode=report`);
        console.log(`[rules-sync] docs=${opts.docs}`);
        console.log(`[rules-sync] config=${opts.config}`);
        console.log(`[rules-sync] out=${reportOut}`);
        runTsNode(reportScript, reportArgs, false, opts.ci);
        const htmlPath = path.join(reportOut, 'rules-sync-report.html');
        if (opts.openReport && fs.existsSync(htmlPath)) openInBrowser(htmlPath);
        return;
    }

    const previous = copyPreviousSnapshot(opts.out, opts.previous);
    const parseLog = path.join(repoRoot, 'tools', 'rules-sync', 'parse-log.ts');
    const updateRules = path.join(repoRoot, 'tools', 'rules-sync', 'update-rules.ts');
    const generatedJson = path.join(opts.out, 'rules.generated.json');
    const commonArgs = buildCommonArgs(opts);

    console.log(`[rules-sync] mode=${opts.mode}`);
    console.log(`[rules-sync] docs=${opts.docs}`);
    console.log(`[rules-sync] config=${opts.config}`);
    console.log(`[rules-sync] out=${opts.out}`);
    if (previous) console.log(`[rules-sync] previous=${previous}`);

    const parseLogArgs = [
        opts.docs,
        ...commonArgs,
        '--output', opts.out,
        '--game', 'stellaris',
        '--version', opts.version,
    ];
    if (opts.emitCwt) parseLogArgs.push('--emit-cwt');
    runTsNode(parseLog, parseLogArgs, false, opts.ci);

    if (opts.mode === 'scan') {
        console.log(`[rules-sync] generated=${generatedJson}`);
        return;
    }

    const updateOut = path.join(opts.out, opts.mode === 'check' ? 'check' : 'update');
    const updateArgs = [generatedJson, opts.config, '--output', updateOut];
    if (previous) updateArgs.push('--previous', previous);
    if (opts.mode === 'check') updateArgs.push('--check');

    const status = runTsNode(updateRules, updateArgs, opts.mode === 'check', opts.ci);
    if (opts.mode === 'check' && status === 2 && !opts.ci) {
        console.log('[rules-sync] Drift found. See the check report above. Re-run with --ci to keep exit code 2.');
    }
    console.log(`[rules-sync] reportDir=${updateOut}`);
}

try {
    main();
} catch (error) {
    console.error(`[rules-sync] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
}
