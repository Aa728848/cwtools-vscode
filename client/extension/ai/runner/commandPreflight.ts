export interface CommandSegment {
    raw: string;
    command: string;
    argsPreview: string;
    classification: 'readonly' | 'write' | 'network' | 'interpreter' | 'destructive' | 'unknown';
    reason: string;
}

export interface CommandPreflightResult {
    safe: boolean;
    riskLevel: 0 | 1 | 2 | 3;
    segments: CommandSegment[];
    requiresPermission: boolean;
    requiresEscalation: boolean;
    blockedReason?: string;
}

// Low-risk read-only commands
const READONLY_COMMANDS = new Set([
    'git status', 'git diff', 'git log', 'git show', 'git branch', 'git tag', 'git rev-parse',
    'grep', 'rg', 'find', 'locate', 'which', 'where', 'whereis',
    'cat', 'head', 'tail', 'less', 'more', 'wc', 'du', 'df',
    // Unambiguous read-only POSIX utilities (no write/exec capability).
    // Deliberately excludes env (runs commands), sort (-o writes), uniq (output-file arg).
    'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'printenv',
    'cut', 'tr', 'comm', 'column', 'nl', 'tree',
    'ls', 'dir', 'pwd', 'echo', 'type', 'print',
    'get-childitem', 'gci', 'select-string', 'sls', 'get-content', 'gc', 'cat',
    'get-location', 'gl', 'pwd', 'resolve-path', 'rvpa', 'test-path',
    'git remote', 'git config'
]);

// Write and modification commands
const WRITE_COMMANDS = new Set([
    'git add', 'git commit', 'git checkout', 'git switch', 'git merge', 'git rebase',
    'git stash', 'git cherry-pick', 'git reset', 'git clean',
    'mkdir', 'rmdir', 'md', 'rd', 'touch', 'cp', 'copy', 'mv', 'move', 'tar', 'zip', 'unzip',
    'ln', 'chmod', 'chown', 'truncate', 'tee', 'install', 'mkfifo',
    'new-item', 'ni', 'remove-item', 'ri', 'rm', 'copy-item', 'cpi', 'cp', 'move-item', 'mi', 'mv',
    'rename-item', 'rni', 'set-content', 'sc', 'add-content', 'ac', 'out-file'
]);

// Network related commands
const NETWORK_COMMANDS = new Set([
    'git clone', 'git fetch', 'git pull', 'git push',
    'curl', 'wget', 'ping', 'nslookup', 'host', 'dig', 'ssh', 'scp', 'sftp',
    'npm install', 'npm ci', 'npm update', 'yarn install', 'yarn ci',
    'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'
]);

// Interactive code interpreters
const INTERPRETER_COMMANDS = new Set([
    'node', 'python', 'python3', 'py', 'perl', 'ruby', 'php', 'powershell', 'pwsh', 'bash', 'sh', 'cmd'
]);

// High risk destructive commands
const DESTRUCTIVE_COMMANDS = new Set([
    'rm -rf', 'rm -r', 'rmdir /s', 'del /f /s /q', 'format', 'mkfs', 'dd', 'shutdown', 'reboot',
    'format-volume', 'clear-disk', 'remove-partition', 'shred'
]);

// POSIX command forms whose risk hides behind flags rather than the base command name.
// `find -delete/-exec` deletes files or executes arbitrary commands per match → destructive.
const DESTRUCTIVE_POSIX_PATTERNS: RegExp[] = [
    /\bfind\b[^|]*\s-(?:delete|exec|execdir|ok)\b/i,
];
// `sed -i` edits in place; `awk` can redirect or shell out → write (never auto-approved as read-only).
const WRITE_POSIX_PATTERNS: RegExp[] = [
    /\bsed\b[^|]*\s-i\b/i,
    /\bawk\b[^|]*(?:>|\bsystem\s*\()/i,
];

/** Force+recursive rm in any flag order (rm -rf, rm -fr, rm -r -f, rm --recursive --force). */
function isForceRecursiveRm(cmd: string): boolean {
    if (!/\brm\b/i.test(cmd)) return false;
    const hasRecursive = /(?:^|\s)-[a-z]*r/i.test(cmd) || /--recursive\b/i.test(cmd);
    const hasForce = /(?:^|\s)-[a-z]*f/i.test(cmd) || /--force\b/i.test(cmd);
    return hasRecursive && hasForce;
}

/**
 * Preflight a shell command line to determine risks and requirements.
 */
export function preflightCommand(commandLine: string): CommandPreflightResult {
    const segments: CommandSegment[] = [];
    let riskLevel: 0 | 1 | 2 | 3 = 0;
    let requiresPermission = false;
    let requiresEscalation = false;
    let blockedReason: string | undefined;

    // Split command by control operators (|, &&, ||, ;, \n)
    const rawSegments = commandLine.split(/\|\||&&|;|\||\n/);

    for (const raw of rawSegments) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        let classification: CommandSegment['classification'] = 'unknown';
        let reason = '未识别的命令';
        
        // Normalize whitespaces for analysis
        const words = trimmed.replace(/\s+/g, ' ').split(' ');
        const baseCmd = words[0] ? words[0].toLowerCase() : '';
        const secondCmd = words[1] ? `${baseCmd} ${words[1].toLowerCase()}` : '';

        // Extract args preview
        const argsPreview = words.slice(1).join(' ').substring(0, 100);

        // Check for redirects (>, >>, <) which imply writing/reading files
        const hasRedirect = trimmed.includes('>') || trimmed.includes('>>') || trimmed.includes('<');

        // Match classifications
        if (DESTRUCTIVE_COMMANDS.has(baseCmd) || DESTRUCTIVE_COMMANDS.has(trimmed.toLowerCase()) || isForceRecursiveRm(trimmed) || trimmed.toLowerCase().includes('del /s') || DESTRUCTIVE_POSIX_PATTERNS.some(p => p.test(trimmed))) {
            classification = 'destructive';
            reason = '高危破坏性指令，可能导致数据丢失或系统损坏';
            riskLevel = Math.max(riskLevel, 3) as any;
            requiresEscalation = true;
            requiresPermission = true;
        } else if (INTERPRETER_COMMANDS.has(baseCmd)) {
            classification = 'interpreter';
            reason = '动态代码/脚本解释器，具有任意代码执行风险';
            riskLevel = Math.max(riskLevel, 2) as any;
            requiresPermission = true;
        } else if (NETWORK_COMMANDS.has(baseCmd) || NETWORK_COMMANDS.has(secondCmd)) {
            classification = 'network';
            reason = '网络请求或远程同步指令，包含外部数据流出入';
            riskLevel = Math.max(riskLevel, 2) as any;
            requiresPermission = true;
        } else if (hasRedirect || WRITE_COMMANDS.has(baseCmd) || WRITE_COMMANDS.has(secondCmd) || WRITE_POSIX_PATTERNS.some(p => p.test(trimmed))) {
            classification = 'write';
            reason = '写文件、修改配置或突变本地系统的指令';
            riskLevel = Math.max(riskLevel, 2) as any;
            requiresPermission = true;
        } else if (READONLY_COMMANDS.has(baseCmd) || READONLY_COMMANDS.has(secondCmd)) {
            classification = 'readonly';
            reason = '只读信息收集或诊断指令，安全风险低';
        } else {
            // Default fallback
            classification = 'unknown';
            reason = '未知或无法归类的第三方指令，按审慎原则提示确认';
            riskLevel = Math.max(riskLevel, 1) as any;
            requiresPermission = true;
        }

        segments.push({
            raw: trimmed,
            command: secondCmd && (READONLY_COMMANDS.has(secondCmd) || WRITE_COMMANDS.has(secondCmd) || NETWORK_COMMANDS.has(secondCmd)) ? secondCmd : baseCmd,
            argsPreview,
            classification,
            reason
        });
    }

    // Set blocked status for high-risk escalations unless explicitly reviewed
    const safe = !requiresEscalation;
    if (requiresEscalation) {
        blockedReason = '由于安全沙盒策略，已拦截并强制阻断高危破坏性指令的自动执行。如确有需要，请拆分命令或请求管理员提权。';
    }

    return {
        safe,
        riskLevel,
        segments,
        requiresPermission,
        requiresEscalation,
        blockedReason
    };
}
