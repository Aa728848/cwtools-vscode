/**
 * Eddy CWTool Code — Configured vanilla read roots for the main agent.
 *
 * `subAgentSandbox.ts` already hands a dispatched child the resolved game roots
 * through `DelegationScopeFacts.readScope`, but the coordinating agent got no
 * such statement. It could therefore only reach vanilla files by guessing a
 * drive letter, or by shelling out to hunt for the install folder, and a
 * guessed path simply ENOENTs in `read_file`.
 *
 * The roots come from `getConfiguredGameRoots()` — the same single authority
 * the sandbox and vanilla search already use — so there is no hardcoded drive
 * letter, no `run_command` probing, and no extra LSP command.
 *
 * Kept deterministic (sorted, deduplicated, bounded, no timestamps) because it
 * is part of a system prompt: an unstable statement would defeat prefix caching.
 */

import { getConfiguredGameRoots, type ConfiguredGameRoot } from '../../../configuredGameRoots';
import { ErrorReporter } from '../../errorReporter';
import { SOURCE, aiText } from '../../messages';

const MAX_LISTED_ROOTS = 8;
const MAX_ROOT_CHARS = 160;

/**
 * Build the configured-vanilla read-root statement for the main agent prompt.
 * @param facts Roots resolved by getConfiguredGameRoots(); omit or pass an
 *              empty list when the user configured no game root.
 * @returns The statement, or an empty string when no root is configured.
 */
export function buildGameRootReadScopeStatement(facts?: readonly ConfiguredGameRoot[]): string {
    const roots = [...new Set(
        (facts ?? [])
            .map(entry => entry.root.trim())
            .filter(root => root.length > 0)
            .map(root => (root.length > MAX_ROOT_CHARS ? `${root.slice(0, MAX_ROOT_CHARS)}…` : root)),
    )].sort((left, right) => left.localeCompare(right));
    if (roots.length === 0) return '';

    const listed = roots.slice(0, MAX_LISTED_ROOTS);
    const omitted = roots.length - listed.length;
    const readable = omitted > 0 ? `${listed.join(', ')} (+${omitted} more)` : listed.join(', ');

    return [
        aiText('## Configured vanilla read roots', '## 已配置的原版只读根'),
        aiText(
            `Configured game roots are read-only evidence sources. You may read inside: ${readable}.`,
            `以下游戏根已为本工作区配置，仅作只读证据源；你可以读取：${readable}。`,
        ),
        aiText(
            '- Vanilla grep and semantic query results are absolute paths under these roots. Pass one to `read_file`, `document_symbols`, or `get_pdx_block` unchanged.',
            '- 原版 grep 与语义查询返回的是这些根下的绝对路径，请原样传给 `read_file`、`document_symbols` 或 `get_pdx_block`。',
        ),
        aiText(
            '- Never guess a drive letter and never hunt for the install folder with `run_command`; the roots above are the ones cwtools itself resolved from settings.',
            '- 不要猜测盘符，也不要用 `run_command` 去寻找安装目录；上面的根就是 cwtools 从设置里自己解析出来的。',
        ),
    ].join('\n');
}

/**
 * Read-scope statement for the roots configured right now.
 * @returns The statement, or an empty string when no game root is configured
 *          or the configuration cannot be read.
 */
export function buildConfiguredGameRootReadScopeStatement(): string {
    try {
        return buildGameRootReadScopeStatement(getConfiguredGameRoots());
    } catch (e) {
        ErrorReporter.debug(SOURCE.PROMPT_BUILDER, 'Error reading configured game roots for the prompt', e);
        return '';
    }
}
