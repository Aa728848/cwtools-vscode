import { aiText } from '../messages';
import { commandMatchesPrefix, normalizeExecutableName } from './policyEngine';

export type CommandPolicyDecision = 'allow' | 'prompt' | 'forbidden';

export interface ConfiguredCommandPolicyRule {
    prefix: string[];
    decision: CommandPolicyDecision;
    justification?: string;
}

export interface CommandSegment {
    raw: string;
    command: string;
    argsPreview: string;
    classification: 'readonly' | 'write' | 'network' | 'interpreter' | 'destructive' | 'unknown';
    decision: CommandPolicyDecision;
    reason: string;
    opaqueExecution: boolean;
    matchedRule?: string[];
}

export interface CommandPreflightResult {
    decision: CommandPolicyDecision;
    safe: boolean;
    riskLevel: 0 | 1 | 2 | 3;
    segments: CommandSegment[];
    structured: boolean;
    opaqueExecution: boolean;
    requiresPermission: boolean;
    requiresEscalation: boolean;
    blockedReason?: string;
}

interface ParsedCommandSegment {
    raw: string;
    words: string[];
    complexSyntax: boolean;
}

interface SegmentClassification {
    classification: CommandSegment['classification'];
    decision: CommandPolicyDecision;
    reason: string;
    riskLevel: 0 | 1 | 2 | 3;
    opaqueExecution: boolean;
}

const READONLY_COMMANDS = new Set([
    'grep', 'rg', 'find', 'locate', 'which', 'where', 'whereis',
    'cat', 'head', 'tail', 'less', 'more', 'wc', 'du', 'df',
    'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'printenv',
    'cut', 'tr', 'comm', 'column', 'nl', 'tree', 'paste', 'rev', 'seq', 'uname', 'whoami',
    'ls', 'dir', 'pwd', 'echo', 'type', 'print',
    'get-childitem', 'gci', 'select-string', 'sls', 'get-content', 'gc',
    'get-location', 'gl', 'resolve-path', 'rvpa', 'test-path',
    'where-object', '?', 'select-object', 'sort-object', 'measure-object',
    'format-table', 'format-list', 'format-wide', 'out-string',
]);

const WRITE_COMMANDS = new Set([
    'mkdir', 'rmdir', 'md', 'rd', 'touch', 'cp', 'copy', 'mv', 'move', 'tar', 'zip', 'unzip',
    'ln', 'chmod', 'chown', 'truncate', 'tee', 'install', 'mkfifo', 'rm', 'del', 'erase',
    'new-item', 'ni', 'remove-item', 'ri', 'copy-item', 'cpi', 'move-item', 'mi',
    'rename-item', 'rni', 'set-content', 'sc', 'add-content', 'ac', 'out-file',
]);

const NETWORK_COMMANDS = new Set([
    'curl', 'wget', 'ping', 'nslookup', 'host', 'dig', 'ssh', 'scp', 'sftp',
    'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
]);

const INTERPRETER_COMMANDS = new Set([
    'node', 'python', 'python3', 'py', 'perl', 'ruby', 'php', 'lua',
    'powershell', 'pwsh', 'bash', 'zsh', 'sh', 'cmd',
]);

const SYSTEM_DESTRUCTIVE_COMMANDS = new Set([
    'format', 'mkfs', 'dd', 'shutdown', 'reboot', 'format-volume', 'clear-disk',
    'remove-partition', 'shred',
]);

const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']);
const GIT_DESTRUCTIVE_SUBCOMMANDS = new Set(['clean', 'reset', 'rebase', 'filter-branch', 'filter-repo']);
const GIT_UNSAFE_READ_OPTIONS = [
    /^--output(?:=|$)/i, /^--ext-diff$/i, /^--textconv$/i, /^--exec(?:=|$)/i,
];
const GIT_UNSAFE_GLOBAL_OPTIONS = [
    /^-C(?:.|$)/, /^-c(?:.|$)/, /^-p$/, /^--paginate$/i, /^--config-env(?:=|$)/i,
    /^--exec-path(?:=|$)/i, /^--git-dir(?:=|$)/i, /^--namespace(?:=|$)/i,
    /^--super-prefix(?:=|$)/i, /^--work-tree(?:=|$)/i,
];
const GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE = new Set([
    '-C', '-c', '--config-env', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree',
]);

// Do not let a persisted/custom allow rule silently approve an entire interpreter
// or VCS surface. Specific subcommands remain configurable.
const BANNED_BROAD_ALLOW_PREFIXES = [
    ['git'], ['python'], ['python3'], ['py'], ['node'], ['perl'], ['ruby'], ['php'], ['lua'],
    ['bash'], ['zsh'], ['sh'], ['cmd'], ['powershell'], ['pwsh'], ['sudo'], ['env'],
];

const DECISION_SEVERITY: Record<CommandPolicyDecision, number> = {
    allow: 0,
    prompt: 1,
    forbidden: 2,
};

function executableName(raw: string): string {
    return normalizeExecutableName(raw);
}

function isPrefixMatch(words: string[], prefix: string[]): boolean {
    return prefix.length > 0 && commandMatchesPrefix(words, prefix);
}

function samePrefix(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((part, index) => {
        const left = index === 0 ? executableName(part) : part.toLowerCase();
        const right = index === 0 ? executableName(b[index]!) : b[index]!.toLowerCase();
        return left === right;
    });
}

function isAllowedConfiguredRule(rule: ConfiguredCommandPolicyRule): boolean {
    if (!Array.isArray(rule.prefix) || rule.prefix.length === 0 || !rule.prefix.every(part => typeof part === 'string' && part.trim())) {
        return false;
    }
    if (!['allow', 'prompt', 'forbidden'].includes(rule.decision)) return false;
    return rule.decision !== 'allow' || !BANNED_BROAD_ALLOW_PREFIXES.some(prefix => samePrefix(prefix, rule.prefix));
}

/**
 * Parse a shell command conservatively without losing quoted operators. Plain
 * command sequences joined by &&, ||, ;, or | remain structured. Shell
 * expansion, redirection, blocks, backgrounding, or malformed quotes make the
 * affected command complex and therefore ineligible for automatic execution.
 */
export function parseShellCommandLine(commandLine: string): { segments: ParsedCommandSegment[]; structured: boolean } {
    const segments: ParsedCommandSegment[] = [];
    let quote: 'single' | 'double' | undefined;
    let token = '';
    let tokenStarted = false;
    let words: string[] = [];
    let segmentStart = 0;
    let complexSyntax = false;
    let structured = true;

    const finishToken = () => {
        if (!tokenStarted) return;
        words.push(token);
        token = '';
        tokenStarted = false;
    };
    const finishSegment = (end: number) => {
        finishToken();
        const raw = commandLine.slice(segmentStart, end).trim();
        if (raw || words.length > 0) {
            if (words.length === 0) structured = false;
            segments.push({ raw, words, complexSyntax });
        } else {
            structured = false;
        }
        words = [];
        complexSyntax = false;
    };

    for (let index = 0; index < commandLine.length; index++) {
        const char = commandLine[index]!;
        const next = commandLine[index + 1];

        if (quote === 'single') {
            if (char === "'") quote = undefined;
            else token += char;
            tokenStarted = true;
            continue;
        }
        if (quote === 'double') {
            if (char === '"') {
                quote = undefined;
            } else if (char === '\\' && next && /["\\$`]/.test(next)) {
                token += next;
                index++;
            } else {
                if (char === '$' || char === '`') complexSyntax = true;
                token += char;
            }
            tokenStarted = true;
            continue;
        }

        if (char === "'") {
            quote = 'single';
            tokenStarted = true;
            continue;
        }
        if (char === '"') {
            quote = 'double';
            tokenStarted = true;
            continue;
        }
        if (char === '\\' && next && /[\s'"\\|&;<>$`(){}]/.test(next)) {
            token += next;
            tokenStarted = true;
            index++;
            continue;
        }
        if (/\s/.test(char) && char !== '\n' && char !== '\r') {
            finishToken();
            continue;
        }

        const doubleOperator = (char === '&' && next === '&') || (char === '|' && next === '|');
        const sequenceOperator = doubleOperator || char === '|' || char === ';' || char === '\n' || char === '\r' || char === '&';
        if (sequenceOperator) {
            if (char === '&' && next !== '&') {
                complexSyntax = true;
                structured = false;
            }
            finishSegment(index);
            if (doubleOperator || (char === '\r' && next === '\n')) index++;
            segmentStart = index + 1;
            continue;
        }

        if (char === '>' || char === '<' || char === '$' || char === '`'
            || char === '(' || char === ')' || char === '{' || char === '}') {
            complexSyntax = true;
            structured = false;
        }
        token += char;
        tokenStarted = true;
    }

    if (quote) {
        complexSyntax = true;
        structured = false;
    }
    finishSegment(commandLine.length);
    if (segments.some(segment => segment.words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment.words[0]))) {
        structured = false;
        for (const segment of segments) segment.complexSyntax = true;
    }
    return { segments, structured: structured && segments.length > 0 };
}

function result(
    classification: SegmentClassification['classification'],
    decision: CommandPolicyDecision,
    riskLevel: SegmentClassification['riskLevel'],
    reason: string,
    opaqueExecution = false,
): SegmentClassification {
    return { classification, decision, riskLevel, reason, opaqueExecution };
}

function readOnly(reason = aiText('Known read-only command', '已知只读命令')): SegmentClassification {
    return result('readonly', 'allow', 0, reason);
}

function sandboxed(
    classification: 'write' | 'network' | 'interpreter' | 'unknown',
    riskLevel: 1 | 2,
    reason: string,
): SegmentClassification {
    return result(classification, 'allow', riskLevel, reason);
}

function prompt(
    classification: 'write' | 'network' | 'interpreter' | 'unknown',
    riskLevel: 1 | 2,
    reason: string,
    opaqueExecution = false,
): SegmentClassification {
    return result(classification, 'prompt', riskLevel, reason, opaqueExecution);
}

function forbidden(reason: string): SegmentClassification {
    return result('destructive', 'forbidden', 3, reason);
}

function onlyFlags(args: string[], allowed: Set<string>, allowedPrefixes: string[] = []): boolean {
    return args.every(arg => allowed.has(arg.toLowerCase()) || allowedPrefixes.some(prefix => arg.toLowerCase().startsWith(prefix)));
}

function findGitSubcommand(words: string[]): { subcommand: string; args: string[]; unsafeGlobalOption: boolean } | undefined {
    if (executableName(words[0] ?? '') !== 'git') return undefined;
    let unsafeGlobalOption = false;
    for (let index = 1; index < words.length; index++) {
        const arg = words[index]!;
        if (GIT_UNSAFE_GLOBAL_OPTIONS.some(pattern => pattern.test(arg))) unsafeGlobalOption = true;
        if (GIT_GLOBAL_OPTIONS_WITH_SEPARATE_VALUE.has(arg)) {
            index++;
            continue;
        }
        if (arg === '--' || arg.startsWith('-')) continue;
        return { subcommand: arg.toLowerCase(), args: words.slice(index + 1), unsafeGlobalOption };
    }
    return { subcommand: '', args: [], unsafeGlobalOption };
}

/** Action-sensitive Git classification shared by policy and execution. */
export function classifyGitCommand(words: string[]): SegmentClassification | undefined {
    const parsed = findGitSubcommand(words);
    if (!parsed) return undefined;
    const { subcommand, args, unsafeGlobalOption } = parsed;
    const unsafeReadOption = unsafeGlobalOption || args.some(arg => GIT_UNSAFE_READ_OPTIONS.some(pattern => pattern.test(arg)));
    const gitPrompt = (classification: 'write' | 'network', reason: string) => prompt(classification, 2, reason);

    if (['status', 'log', 'show', 'rev-parse', 'diff'].includes(subcommand)) {
        return unsafeReadOption
            ? gitPrompt('write', aiText('Git output/config/helper options may write files or execute external code', 'Git 输出、配置或辅助选项可能写文件或执行外部代码'))
            : readOnly(aiText('Read-only Git query', '只读 Git 查询'));
    }
    if (subcommand === 'stash' && (args[0] ?? '').toLowerCase() === 'list') {
        return readOnly(aiText('Read-only Git stash listing', '只读 Git stash 列表'));
    }
    if (subcommand === 'stash' && ['drop', 'clear'].includes((args[0] ?? '').toLowerCase())) {
        return forbidden(aiText('Git stash removal permanently discards saved changes', 'Git stash 删除会永久丢弃已保存的更改'));
    }
    if (subcommand === 'checkout' || subcommand === 'restore') {
        const discardsFiles = subcommand === 'restore'
            || args.includes('--')
            || args.some(arg => /^(?:-f|--force|--ours|--theirs|--source(?:=|$))/i.test(arg));
        return discardsFiles
            ? forbidden(aiText('Git checkout/restore may discard uncommitted file changes', 'Git checkout/restore 可能丢弃未提交的文件更改'))
            : gitPrompt('write', aiText('Git checkout changes the current branch or worktree', 'Git checkout 会更改当前分支或工作树'));
    }
    if (subcommand === 'branch') {
        const safe = args.length === 0 || onlyFlags(
            args,
            new Set(['--show-current', '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose']),
            ['--format='],
        );
        if (safe && !unsafeGlobalOption) return readOnly(aiText('Read-only Git branch listing', '只读 Git 分支列表'));
        if (args.some(arg => /^-[dD](?:.|$)|^--delete$/i.test(arg))) {
            return forbidden(aiText('Git branch deletion may discard repository references', 'Git 分支删除可能丢弃仓库引用'));
        }
        return gitPrompt('write', aiText('Git branch operation mutates repository metadata', 'Git 分支操作会修改仓库元数据'));
    }
    if (subcommand === 'tag') {
        const safe = (args.length === 0 || onlyFlags(args, new Set(['--list', '-l']))) && !unsafeGlobalOption;
        if (safe) return readOnly(aiText('Read-only Git tag listing', '只读 Git 标签列表'));
        if (args.some(arg => /^-[dDf](?:.|$)|^--delete$|^--force$/i.test(arg))) {
            return forbidden(aiText('Git tag deletion/force may rewrite repository references', 'Git 标签删除或强制操作可能重写仓库引用'));
        }
        return gitPrompt('write', aiText('Git tag operation mutates repository metadata', 'Git 标签操作会修改仓库元数据'));
    }
    if (subcommand === 'remote') {
        const safe = (args.length === 0 || (args.length === 1 && args[0] === '-v')) && !unsafeGlobalOption;
        return safe
            ? readOnly(aiText('Read-only Git remote listing', '只读 Git 远程列表'))
            : gitPrompt('network', aiText('Git remote operation changes configuration or may contact a remote', 'Git remote 操作会修改配置或可能访问远程'));
    }
    if (subcommand === 'config') {
        const readFlags = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope', '--name-only']);
        const safe = args.length > 0 && args.some(arg => readFlags.has(arg.toLowerCase()))
            && !args.some(arg => /^(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e|--global|--system|--local|--worktree)$/i.test(arg))
            && !unsafeGlobalOption;
        return safe
            ? readOnly(aiText('Read-only Git configuration query', '只读 Git 配置查询'))
            : gitPrompt('write', aiText('Git config operation may modify repository or user configuration', 'Git config 操作可能修改仓库或用户配置'));
    }
    if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
        if (subcommand === 'push' && args.some(arg => /^(?:-[^-]*f|--force|--force-with-lease(?:=|$)|--delete|-d)$/i.test(arg))) {
            return forbidden(aiText('Force/delete push can rewrite or remove remote history', '强制或删除 push 可能重写或移除远端历史'));
        }
        return gitPrompt('network', aiText('Git command contacts a remote repository', 'Git 命令会访问远程仓库'));
    }
    if (GIT_DESTRUCTIVE_SUBCOMMANDS.has(subcommand)) {
        return forbidden(aiText('Git history/worktree operation may discard or rewrite data', 'Git 历史或工作树操作可能丢弃或重写数据'));
    }
    return gitPrompt('write', aiText('Git command may mutate repository state', 'Git 命令可能修改仓库状态'));
}

function hasRmForce(words: string[]): boolean {
    if (executableName(words[0] ?? '') !== 'rm') return false;
    return words.slice(1).some(arg => arg === '--force' || /^-[A-Za-z]*f[A-Za-z]*$/.test(arg));
}

function classifySegment(parsed: ParsedCommandSegment): SegmentClassification {
    const words = parsed.words;
    const baseCmd = executableName(words[0] ?? '');
    const secondCmd = words[1] ? `${baseCmd} ${words[1]!.toLowerCase()}` : '';
    const lowerArgs = words.slice(1).map(arg => arg.toLowerCase());

    if (baseCmd === 'sudo' && words.length > 1) {
        return classifySegment({ ...parsed, words: words.slice(1) });
    }
    if (baseCmd === 'env' && words.length > 1) {
        const commandIndex = words.findIndex((word, index) => index > 0
            && !word.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
        if (commandIndex > 0) return classifySegment({ ...parsed, words: words.slice(commandIndex) });
    }

    const shellScriptFlagIndex = words.findIndex((word, index) => index > 0 && (
        (['bash', 'zsh', 'sh'].includes(baseCmd) && ['-c', '-lc'].includes(word.toLowerCase()))
        || (['powershell', 'pwsh'].includes(baseCmd) && ['-command', '-c'].includes(word.toLowerCase()))
        || (baseCmd === 'cmd' && ['/c', '/r', '-c'].includes(word.toLowerCase()))
    ));
    if (shellScriptFlagIndex > 0 && words.length > shellScriptFlagIndex + 1) {
        const nested = preflightCommand(words.slice(shellScriptFlagIndex + 1).join(' '));
        const mostSevere = nested.segments.reduce<CommandSegment | undefined>((current, segment) =>
            !current || DECISION_SEVERITY[segment.decision] > DECISION_SEVERITY[current.decision] ? segment : current,
        undefined);
        if (mostSevere) {
            return result(
                mostSevere.classification,
                nested.decision,
                nested.riskLevel,
                mostSevere.reason,
                nested.opaqueExecution,
            );
        }
    }
    if (['powershell', 'pwsh'].includes(baseCmd)
        && lowerArgs.some(arg => ['-encodedcommand', '-enc', '-e'].includes(arg))) {
        return prompt('interpreter', 2, aiText('Encoded PowerShell cannot be inspected safely', '无法安全检查编码后的 PowerShell 命令'), true);
    }
    const opaqueInterpreter = (
        (['node'].includes(baseCmd) && lowerArgs.some(arg => ['-e', '--eval', '-p', '--print'].includes(arg)))
        || (['python', 'python3', 'py'].includes(baseCmd) && lowerArgs.includes('-c'))
        || (['perl', 'ruby', 'lua'].includes(baseCmd) && lowerArgs.includes('-e'))
        || (baseCmd === 'php' && lowerArgs.includes('-r'))
        || ['eval', 'invoke-expression', 'iex', 'xargs'].includes(baseCmd)
    );
    if (opaqueInterpreter) {
        return prompt('interpreter', 2, aiText(
            'Inline or data-driven code execution is opaque to command preflight and requires explicit approval',
            '内联或数据驱动的代码执行无法由命令预检完整审查，需要明确批准',
        ), true);
    }

    const git = classifyGitCommand(words);
    if (git) {
        // Preserve explicit destructive-Git denials, but never let Git's
        // subcommand classification hide shell redirection or substitution.
        if (git.decision === 'forbidden') return git;
        if (parsed.complexSyntax) {
            return prompt('interpreter', 2, aiText(
                'Complex shell syntax around Git cannot be proven safe by the structured parser',
                '结构化解析器无法证明 Git 命令周围的复杂 Shell 语法安全',
            ), true);
        }
        return git;
    }
    if (SYSTEM_DESTRUCTIVE_COMMANDS.has(baseCmd)
        || hasRmForce(words)
        || ((baseCmd === 'del' || baseCmd === 'erase') && lowerArgs.some(arg => /^\/[fsq]+$/i.test(arg)))
        || ((baseCmd === 'rmdir' || baseCmd === 'rd') && lowerArgs.includes('/s'))
        || (baseCmd === 'find' && lowerArgs.some(arg => ['-delete', '-exec', '-execdir', '-ok', '-okdir'].includes(arg)))) {
        return forbidden(aiText('High-risk destructive command that may cause data loss or system damage', '高危破坏性命令，可能导致数据丢失或系统损坏'));
    }
    if (parsed.complexSyntax) {
        return prompt('interpreter', 2, aiText(
            'Complex shell syntax cannot be proven safe by the structured parser',
            '结构化解析器无法证明复杂 Shell 语法安全',
        ), true);
    }
    if (baseCmd === 'rg' && lowerArgs.some(arg => arg === '--pre' || arg.startsWith('--pre=')
        || arg === '--hostname-bin' || arg.startsWith('--hostname-bin=') || arg === '--search-zip' || arg === '-z')) {
        return prompt('interpreter', 2, aiText('Ripgrep option may invoke external helpers', 'Ripgrep 选项可能调用外部辅助程序'));
    }
    if (baseCmd === 'find') {
        const writesOutput = lowerArgs.some(arg => ['-fls', '-fprint', '-fprint0', '-fprintf'].includes(arg));
        return writesOutput
            ? sandboxed('write', 2, aiText('Find command writes output to a file inside the sandbox', 'Find 命令会在沙箱内写入输出文件'))
            : readOnly(aiText('Read-only find query', '只读 find 查询'));
    }
    if (baseCmd === 'sed' && lowerArgs.some(arg => arg === '-i' || arg.startsWith('-i'))) {
        return sandboxed('write', 2, aiText('In-place edit is confined to sandbox writable roots', '原地编辑被限制在沙箱可写根目录内'));
    }
    if (baseCmd === 'awk' && /(?:>|\bsystem\s*\()/i.test(parsed.raw)) {
        return sandboxed('write', 2, aiText('Awk command may write files or invoke a subprocess inside the sandbox', 'Awk 命令可能在沙箱内写文件或调用子进程'));
    }
    if (baseCmd === 'base64' && lowerArgs.some(arg => arg === '-o' || arg === '--output' || arg.startsWith('--output=') || /^-o.+/.test(arg))) {
        return sandboxed('write', 2, aiText('Base64 output is confined to sandbox writable roots', 'Base64 输出被限制在沙箱可写根目录内'));
    }
    if (NETWORK_COMMANDS.has(baseCmd) || ['npm install', 'npm ci', 'npm update', 'yarn install', 'yarn ci'].includes(secondCmd)) {
        return sandboxed('network', 2, aiText('Network command remains subject to sandbox network policy', '联网命令仍受沙箱网络策略约束'));
    }
    if (WRITE_COMMANDS.has(baseCmd)) {
        return sandboxed('write', 2, aiText('Write command is confined to sandbox writable roots', '写入命令被限制在沙箱可写根目录内'));
    }
    if (INTERPRETER_COMMANDS.has(baseCmd)) {
        return sandboxed('interpreter', 2, aiText('Interpreter runs inside the configured OS sandbox', '解释器在已配置的操作系统沙箱内运行'));
    }
    if (READONLY_COMMANDS.has(baseCmd)) {
        return readOnly();
    }
    return sandboxed('unknown', 1, aiText('Unclassified command is allowed only inside the configured sandbox', '未分类命令仅允许在已配置的沙箱内运行'));
}

function applyConfiguredRules(
    segment: CommandSegment,
    words: string[],
    rules: ConfiguredCommandPolicyRule[],
): CommandSegment {
    if (segment.decision === 'forbidden') return segment;
    const matches = rules.filter(isAllowedConfiguredRule).filter(rule => isPrefixMatch(words, rule.prefix));
    if (matches.length === 0) return segment;
    const strictest = matches.reduce((current, candidate) =>
        DECISION_SEVERITY[candidate.decision] > DECISION_SEVERITY[current.decision] ? candidate : current,
    );
    return {
        ...segment,
        decision: strictest.decision,
        matchedRule: [...strictest.prefix],
        reason: strictest.justification?.trim()
            || aiText(`Configured command policy: ${strictest.decision}`, `已配置命令策略：${strictest.decision}`),
    };
}

/** Determine command policy once; all execution and approval gates consume this result. */
export function preflightCommand(
    commandLine: string,
    configuredRules: ConfiguredCommandPolicyRule[] = [],
): CommandPreflightResult {
    const parsed = parseShellCommandLine(commandLine);
    let riskLevel: 0 | 1 | 2 | 3 = 0;

    const segments = parsed.segments.map(parsedSegment => {
        const classification = classifySegment(parsedSegment);
        const base: CommandSegment = {
            raw: parsedSegment.raw,
            command: executableName(parsedSegment.words[0] ?? ''),
            argsPreview: parsedSegment.words.slice(1).join(' ').substring(0, 100),
            classification: classification.classification,
            decision: classification.decision,
            reason: classification.reason,
            opaqueExecution: classification.opaqueExecution,
        };
        const ruled = applyConfiguredRules(base, parsedSegment.words, configuredRules);
        const decisionRisk = ruled.decision === 'forbidden' ? 3 : ruled.decision === 'prompt' ? 1 : 0;
        riskLevel = Math.max(riskLevel, classification.riskLevel, decisionRisk) as 0 | 1 | 2 | 3;
        return ruled;
    });

    if (segments.length === 0) {
        riskLevel = 1;
    }
    const decision = segments.reduce<CommandPolicyDecision>((current, segment) =>
        DECISION_SEVERITY[segment.decision] > DECISION_SEVERITY[current] ? segment.decision : current,
    segments.length === 0 ? 'prompt' : 'allow');
    const requiresEscalation = decision === 'forbidden';
    const requiresPermission = decision !== 'allow';
    const blockedReason = requiresEscalation
        ? aiText(
            'Automatic execution is forbidden for this destructive command. Retry with explicit escalation only when it is truly required.',
            '此破坏性命令禁止自动执行。仅在确有必要时通过显式提权重试。',
        )
        : undefined;
    return {
        decision,
        safe: !requiresEscalation,
        riskLevel,
        segments,
        structured: parsed.structured,
        opaqueExecution: segments.some(segment => segment.opaqueExecution),
        requiresPermission,
        requiresEscalation,
        blockedReason,
    };
}
