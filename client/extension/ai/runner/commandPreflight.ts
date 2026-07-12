import { aiText } from '../messages';

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
    'git status', 'git diff', 'git log', 'git show', 'git rev-parse',
    'grep', 'rg', 'find', 'locate', 'which', 'where', 'whereis',
    'cat', 'head', 'tail', 'less', 'more', 'wc', 'du', 'df',
    // Unambiguous read-only POSIX utilities (no write/exec capability).
    // Deliberately excludes env (runs commands), sort (-o writes), uniq (output-file arg).
    'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'printenv',
    'cut', 'tr', 'comm', 'column', 'nl', 'tree',
    'ls', 'dir', 'pwd', 'echo', 'type', 'print',
    'get-childitem', 'gci', 'select-string', 'sls', 'get-content', 'gc', 'cat',
    'get-location', 'gl', 'pwd', 'resolve-path', 'rvpa', 'test-path',
    'where-object', '?', 'select-object', 'sort-object', 'measure-object',
    'format-table', 'format-list', 'format-wide', 'out-string',
    // Git branch/tag/remote/config are classified by classifyGitCommand below;
    // their base subcommand is not inherently read-only (for example branch -D).
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

type GitClassification = Pick<CommandSegment, 'classification' | 'reason'> & {
    riskLevel: 0 | 1 | 2 | 3;
    requiresPermission: boolean;
    requiresEscalation: boolean;
};

const GIT_READONLY_SUBCOMMANDS = new Set(['status', 'log', 'show', 'rev-parse']);
const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']);
const GIT_DESTRUCTIVE_SUBCOMMANDS = new Set(['clean', 'reset', 'rebase', 'filter-branch', 'filter-repo']);

function onlyFlags(args: string[], allowed: Set<string>): boolean {
    return args.every(arg => allowed.has(arg.toLowerCase()));
}

/**
 * Git subcommands are action-sensitive. Treating `git branch`, `git tag`, or
 * `git remote` as read-only by prefix silently permits delete/config mutations.
 */
export function classifyGitCommand(words: string[]): GitClassification | undefined {
    if ((words[0] ?? '').toLowerCase() !== 'git') return undefined;
    const subcommand = (words[1] ?? '').toLowerCase();
    const args = words.slice(2);
    const read = (reason: string): GitClassification => ({
        classification: 'readonly', reason, riskLevel: 0, requiresPermission: false, requiresEscalation: false,
    });
    const write = (reason: string, destructive = false): GitClassification => ({
        classification: destructive ? 'destructive' : 'write',
        reason,
        riskLevel: destructive ? 3 : 2,
        requiresPermission: true,
        requiresEscalation: destructive,
    });

    if (GIT_READONLY_SUBCOMMANDS.has(subcommand)) {
        // Output/config overrides can write or execute helpers even on nominally
        // read-only Git commands. Keep the automatic surface deliberately small.
        if (args.some(arg => /^(?:--output(?:=|$)|--config(?:=|$)|-c$|--exec-path(?:=|$)|--ext-diff$|--textconv$)/i.test(arg))) {
            return write(aiText('Git output/config override may write files or invoke external helpers', 'Git 输出/配置覆盖可能写文件或调用外部程序'));
        }
        return read(aiText('Read-only Git query', '只读 Git 查询'));
    }
    if (subcommand === 'diff') {
        if (args.some(arg => /^(?:--output(?:=|$)|--ext-diff$|--textconv$)/i.test(arg))) {
            return write(aiText('Git diff output/helper option may write files or execute code', 'Git diff 输出/辅助选项可能写文件或执行代码'));
        }
        return read(aiText('Read-only Git diff', '只读 Git 差异查询'));
    }
    if (subcommand === 'stash' && (args[0] ?? '').toLowerCase() === 'list') {
        return read(aiText('Read-only Git stash listing', '只读 Git stash 列表'));
    }
    if (subcommand === 'stash' && ['drop', 'clear'].includes((args[0] ?? '').toLowerCase())) {
        return write(aiText('Git stash removal permanently discards saved changes', 'Git stash 删除会永久丢弃已保存的更改'), true);
    }
    if (subcommand === 'checkout' || subcommand === 'restore') {
        const discardsFiles = subcommand === 'restore'
            || args.includes('--')
            || args.some(arg => /^(?:-f|--force|--ours|--theirs|--source(?:=|$))$/i.test(arg));
        return write(
            discardsFiles
                ? aiText('Git checkout/restore may discard uncommitted file changes', 'Git checkout/restore 可能丢弃未提交的文件更改')
                : aiText('Git checkout changes the current branch or worktree', 'Git checkout 会更改当前分支或工作树'),
            discardsFiles,
        );
    }
    if (subcommand === 'branch') {
        const safe = args.length === 0 || onlyFlags(args, new Set(['--show-current', '--list', '-l', '-a', '-r', '-v', '-vv', '--verbose']));
        return safe
            ? read(aiText('Read-only Git branch listing', '只读 Git 分支列表'))
            : write(aiText('Git branch operation mutates repository metadata', 'Git 分支操作会修改仓库元数据'), args.some(arg => /^-(?:d|D)$/.test(arg)));
    }
    if (subcommand === 'tag') {
        const safe = args.length === 0 || onlyFlags(args, new Set(['--list', '-l']));
        return safe
            ? read(aiText('Read-only Git tag listing', '只读 Git 标签列表'))
            : write(aiText('Git tag operation mutates repository metadata', 'Git 标签操作会修改仓库元数据'), args.some(arg => /^-(?:d|D|f)$|^--delete$|^--force$/.test(arg)));
    }
    if (subcommand === 'remote') {
        const safe = args.length === 0 || (args.length === 1 && args[0] === '-v');
        return safe
            ? read(aiText('Read-only Git remote listing', '只读 Git 远程列表'))
            : write(aiText('Git remote operation changes configuration or contacts a remote', 'Git remote 操作会修改配置或访问远程'));
    }
    if (subcommand === 'config') {
        const readFlags = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope', '--name-only']);
        const safe = args.length > 0 && args.some(arg => readFlags.has(arg.toLowerCase()))
            && !args.some(arg => /^(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e|--global|--system|--local|--worktree)$/i.test(arg));
        return safe
            ? read(aiText('Read-only Git configuration query', '只读 Git 配置查询'))
            : write(aiText('Git config operation may modify repository or user configuration', 'Git config 操作可能修改仓库或用户配置'));
    }
    if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
        if (subcommand === 'push' && args.some(arg => /^(?:-f|--force|--force-with-lease|--delete|-d)$/i.test(arg))) {
            return write(aiText('Force/delete push can rewrite or remove remote history', '强制或删除 push 可能重写或移除远端历史'), true);
        }
        return { classification: 'network', reason: aiText('Git command contacts a remote repository', 'Git 命令会访问远程仓库'), riskLevel: 2, requiresPermission: true, requiresEscalation: false };
    }
    if (GIT_DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) {
        return write(aiText('Git history/worktree operation may discard or rewrite data', 'Git 历史/工作树操作可能丢弃或重写数据'), true);
    }
    return write(aiText('Git command may mutate repository state', 'Git 命令可能修改仓库状态'));
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
        let reason = aiText('Unrecognized command', '未识别的命令');
        
        // Normalize whitespaces for analysis
        const words = trimmed.replace(/\s+/g, ' ').split(' ');
        const baseCmd = words[0] ? words[0].toLowerCase() : '';
        const secondCmd = words[1] ? `${baseCmd} ${words[1].toLowerCase()}` : '';

        // Extract args preview
        const argsPreview = words.slice(1).join(' ').substring(0, 100);

        // Check for redirects (>, >>, <) which imply writing/reading files
        const hasRedirect = trimmed.includes('>') || trimmed.includes('>>') || trimmed.includes('<');
        const hasDynamicShellSyntax = /\$\(|[{}]|`/.test(trimmed) || /(?:^|\s)&\s*\S/.test(trimmed);
        const hasDestructiveSyntax = DESTRUCTIVE_COMMANDS.has(baseCmd)
            || DESTRUCTIVE_COMMANDS.has(trimmed.toLowerCase())
            || isForceRecursiveRm(trimmed)
            || trimmed.toLowerCase().includes('del /s')
            || DESTRUCTIVE_POSIX_PATTERNS.some(pattern => pattern.test(trimmed));

        // Match classifications
        const gitClassification = classifyGitCommand(words);
        if (hasDynamicShellSyntax && !hasDestructiveSyntax) {
            classification = 'interpreter';
            reason = aiText('Shell substitution or script block can execute arbitrary nested commands', 'Shell 替换或脚本块可执行任意嵌套命令');
            riskLevel = Math.max(riskLevel, 2) as 0 | 1 | 2 | 3;
            requiresPermission = true;
        } else if (gitClassification) {
            classification = gitClassification.classification;
            reason = gitClassification.reason;
            riskLevel = Math.max(riskLevel, gitClassification.riskLevel) as 0 | 1 | 2 | 3;
            requiresPermission ||= gitClassification.requiresPermission;
            requiresEscalation ||= gitClassification.requiresEscalation;
        } else if (hasDestructiveSyntax) {
            classification = 'destructive';
            reason = aiText('High-risk destructive command that may cause data loss or system damage', '高危破坏性指令，可能导致数据丢失或系统损坏');
            riskLevel = Math.max(riskLevel, 3) as any;
            requiresEscalation = true;
            requiresPermission = true;
        } else if (INTERPRETER_COMMANDS.has(baseCmd)) {
            classification = 'interpreter';
            reason = aiText('Dynamic code or script interpreter with arbitrary execution risk', '动态代码/脚本解释器，具有任意代码执行风险');
            riskLevel = Math.max(riskLevel, 2) as any;
            requiresPermission = true;
        } else if (NETWORK_COMMANDS.has(baseCmd) || NETWORK_COMMANDS.has(secondCmd)) {
            classification = 'network';
            reason = aiText('Network request or remote sync command with external data flow', '网络请求或远程同步指令，包含外部数据流出入');
            riskLevel = Math.max(riskLevel, 2) as any;
            requiresPermission = true;
        } else if (hasRedirect || WRITE_COMMANDS.has(baseCmd) || WRITE_COMMANDS.has(secondCmd) || WRITE_POSIX_PATTERNS.some(p => p.test(trimmed))) {
            classification = 'write';
            reason = aiText('Command writes files, changes configuration, or mutates the local system', '写文件、修改配置或突变本地系统的指令');
            riskLevel = Math.max(riskLevel, 2) as any;
            requiresPermission = true;
        } else if (READONLY_COMMANDS.has(baseCmd) || READONLY_COMMANDS.has(secondCmd)) {
            classification = 'readonly';
            reason = aiText('Read-only information gathering or diagnostic command with low safety risk', '只读信息收集或诊断指令，安全风险低');
        } else {
            // Default fallback
            classification = 'unknown';
            reason = aiText('Unknown or unclassified third-party command; confirmation is required as a precaution', '未知或无法归类的第三方指令，按审慎原则提示确认');
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
        blockedReason = aiText(
            'The safety sandbox blocked automatic execution of this high-risk destructive command. If it is truly required, split the command or request elevated permission.',
            '由于安全沙盒策略，已拦截并强制阻断高危破坏性指令的自动执行。如确有需要，请拆分命令或请求管理员提权。',
        );
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
