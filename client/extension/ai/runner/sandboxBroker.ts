import * as fs from 'fs';
import { spawn } from 'child_process';

interface BrokerConfig {
    backend: 'bubblewrap' | 'seatbelt' | 'windows-helper';
    backendExecutable: string;
    command: string;
    args: string[];
    cwd: string;
    writableRoots: string[];
    networkAccess: boolean;
}

function parseConfig(): BrokerConfig {
    const encoded = process.argv[2];
    if (!encoded) throw new Error('Missing sandbox broker configuration');
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as BrokerConfig;
    if (!value.command || !value.backendExecutable || !Array.isArray(value.args)) throw new Error('Invalid sandbox broker configuration');
    return value;
}

function bubblewrapArgs(config: BrokerConfig): string[] {
    const args = ['--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
    for (const root of config.writableRoots.filter(Boolean)) {
        if (fs.existsSync(root)) args.push('--bind', root, root);
    }
    if (!config.networkAccess) args.push('--unshare-net');
    args.push('--chdir', config.cwd, '--', config.command, ...config.args);
    return args;
}

function seatbeltProfile(config: BrokerConfig): string {
    const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const readableSystem = ['/usr', '/bin', '/sbin', '/System', '/Library', '/private/etc', '/dev'];
    const rules = [
        '(version 1)',
        '(deny default)',
        '(allow process*)',
        '(allow sysctl-read)',
        ...readableSystem.map(root => `(allow file-read* (subpath "${escape(root)}"))`),
        ...config.writableRoots.filter(Boolean).map(root => `(allow file-read* file-write* (subpath "${escape(root)}"))`),
        '(allow file-read* file-write* (subpath "/private/tmp"))',
    ];
    if (config.networkAccess) rules.push('(allow network*)');
    return rules.join('\n');
}

function launch(config: BrokerConfig): void {
    const executable = config.backendExecutable;
    let args: string[];
    if (config.backend === 'bubblewrap') {
        args = bubblewrapArgs(config);
    } else if (config.backend === 'seatbelt') {
        args = ['-p', seatbeltProfile(config), config.command, ...config.args];
    } else {
        args = ['--cwd', config.cwd, '--network', config.networkAccess ? 'allow' : 'deny', '--', config.command, ...config.args];
    }

    const child = spawn(executable, args, {
        cwd: config.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.once('error', error => {
        process.stderr.write(`Sandbox backend failed: ${error.message}\n`);
        process.exitCode = 126;
    });
    child.once('close', code => {
        process.exitCode = code ?? 1;
    });
}

try {
    launch(parseConfig());
} catch (error) {
    process.stderr.write(`Sandbox broker rejected command: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 126;
}
