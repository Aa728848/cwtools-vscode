/**
 * 出站文本清洗。
 *
 * 两类字符在 JSON 里无法表示，却很容易出现在真实内容里：
 *
 * - **NUL**（U+0000）：可以出现在剪贴板或文件内容里，而 `JSON.stringify` 会把它原样写出，
 *   接收端直接判为非法 JSON；
 * - **落单代理项**（lone surrogate）：一个表情被按字节切开就得到它。JSON 允许成对的代理项，
 *   不允许落单的，因此请求会在序列化时被拒。
 *
 * 第二种尤其难查：它**留在历史里**，于是同一段对话之后每一个请求都以同样方式失败。
 */

const NUL = String.fromCharCode(0);
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/**
 * A NUL, or a surrogate that is not part of a valid pair.
 *
 * The ranges are assembled from char codes rather than written as a literal: a literal
 * NUL inside a regex trips the control-character lint, and the intent here is the
 * *character class*, not one particular byte.
 */
const UNREPRESENTABLE = new RegExp(
    `[${NUL}\\u${HIGH_SURROGATE_FIRST.toString(16)}-\\u${HIGH_SURROGATE_LAST.toString(16)}](?![\\u${LOW_SURROGATE_FIRST.toString(16)}-\\u${LOW_SURROGATE_LAST.toString(16)}])`
    + `|(?<![\\u${HIGH_SURROGATE_FIRST.toString(16)}-\\u${HIGH_SURROGATE_LAST.toString(16)}])[\\u${LOW_SURROGATE_FIRST.toString(16)}-\\u${LOW_SURROGATE_LAST.toString(16)}]`,
    'g',
);

/** The cheap guard: most outbound text contains none of these. */
const MAYBE_UNREPRESENTABLE = new RegExp(
    `[${NUL}\\u${HIGH_SURROGATE_FIRST.toString(16)}-\\u${LOW_SURROGATE_LAST.toString(16)}]`,
);

/**
 * 清掉一个字符串里无法表示的字符。
 *
 * 成对的代理项（也就是一个完整的表情）原样保留——被删掉的表情比一个坏请求更难解释。
 */
export function sanitizeOutboundText(value: string): string {
    if (value === '' || !MAYBE_UNREPRESENTABLE.test(value)) return value;
    return value.replace(UNREPRESENTABLE, '');
}
