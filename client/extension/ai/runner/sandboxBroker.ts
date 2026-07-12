import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';

interface BrokerConfig {
    backend: 'bubblewrap' | 'seatbelt' | 'windows-helper' | 'wsl-bubblewrap';
    backendExecutable: string;
    command: string;
    args: string[];
    cwd: string;
    writableRoots: string[];
    protectedPaths: string[];
    networkAccess: boolean;
    distro?: string;
    environment?: Record<string, string>;
}

function pathLikeWindows(value: string): boolean {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

function parseConfig(): BrokerConfig {
    const encoded = process.argv[2];
    if (!encoded) throw new Error('Missing sandbox broker configuration');
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as BrokerConfig;
    if (!value.command || !value.backendExecutable || !Array.isArray(value.args)) throw new Error('Invalid sandbox broker configuration');
    value.writableRoots = Array.isArray(value.writableRoots) ? value.writableRoots : [];
    value.protectedPaths = Array.isArray(value.protectedPaths) ? value.protectedPaths : [];
    return value;
}

function bubblewrapArgs(config: BrokerConfig, validatePaths = true): string[] {
    const args = ['--die-with-parent', '--new-session', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
    for (const root of config.writableRoots.filter(Boolean)) {
        if (!validatePaths || fs.existsSync(root)) args.push('--bind', root, root);
    }
    // Re-apply protected descendants after writable roots. This prevents a
    // workspace bind from making Git metadata and agent policy stores writable.
    for (const protectedPath of config.protectedPaths.filter(Boolean)) {
        if (!validatePaths || fs.existsSync(protectedPath)) args.push('--ro-bind', protectedPath, protectedPath);
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
        ...config.protectedPaths.filter(Boolean).map(protectedPath => fs.existsSync(protectedPath) && fs.statSync(protectedPath).isDirectory()
            ? `(deny file-write* (subpath "${escape(protectedPath)}"))`
            : `(deny file-write* (literal "${escape(protectedPath)}"))`),
        '(allow file-read* file-write* (subpath "/private/tmp"))',
    ];
    if (config.networkAccess) rules.push('(allow network*)');
    return rules.join('\n');
}

function launch(config: BrokerConfig): void {
    let executable = config.backendExecutable;
    let args: string[];
    if (config.backend === 'bubblewrap') {
        args = bubblewrapArgs(config);
    } else if (config.backend === 'wsl-bubblewrap') {
        const prefix = config.distro ? ['--distribution', config.distro] : [];
        const translate = (value: string): string => {
            const result = spawnSync(config.backendExecutable, [...prefix, '--exec', 'wslpath', '-a', value], {
                encoding: 'utf8', timeout: 4000, windowsHide: true,
            });
            if (result.status !== 0) throw new Error(`WSL path translation failed for ${value}: ${result.stderr || result.stdout}`);
            return String(result.stdout).trim();
        };
        const translated: BrokerConfig = {
            ...config,
            backend: 'bubblewrap',
            backendExecutable: '/usr/bin/bwrap',
            cwd: translate(config.cwd),
            writableRoots: config.writableRoots.filter(root => fs.existsSync(root)).map(translate),
            protectedPaths: config.protectedPaths.filter(protectedPath => fs.existsSync(protectedPath)).map(translate),
        };
        const environment = Object.entries(config.environment ?? {}).map(([key, value]) => {
            const translatedValue = /_(?:DIR|ROOT|SCRIPT)$/.test(key) && pathLikeWindows(value) ? translate(value) : value;
            return `${key}=${translatedValue}`;
        });
        translated.command = '/usr/bin/env';
        translated.args = [...environment, config.command, ...config.args];
        executable = config.backendExecutable;
        args = [...prefix, '--exec', '/usr/bin/bwrap', ...bubblewrapArgs(translated, false)];
    } else if (config.backend === 'seatbelt') {
        args = ['-p', seatbeltProfile(config), config.command, ...config.args];
    } else {
        args = ['--cwd', config.cwd, '--network', config.networkAccess ? 'allow' : 'deny'];
        for (const root of config.writableRoots.filter(Boolean)) args.push('--write-root', root);
        for (const protectedPath of config.protectedPaths.filter(Boolean)) args.push('--protect', protectedPath);
        args.push('--', config.command, ...config.args);
    }

    const child = spawn(executable, args, {
        cwd: config.cwd,
        env: process.env,
        stdio: ['inherit', 'pipe', 'pipe'],
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
