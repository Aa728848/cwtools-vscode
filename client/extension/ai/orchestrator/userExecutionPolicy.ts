export interface UserExecutionPolicy {
    /** Who owns localisation file creation and maintenance for this run. */
    localisationOwnership: 'agent' | 'user';
    /** Whether non-error diagnostics may block or trigger automatic repair. */
    warningHandling: 'enforce' | 'ignore';
}

const DEFAULT_USER_EXECUTION_POLICY: UserExecutionPolicy = {
    localisationOwnership: 'agent',
    warningHandling: 'enforce',
};

function hasUserOwnedLocalisationIntent(text: string): boolean {
    const mentionsLocalisation = /本地化|汉化|翻译|locali[sz]ation/i.test(text);
    if (!mentionsLocalisation) return false;

    return [
        /(?:我|用户).{0,24}(?:自己|自行|亲自|来|负责).{0,12}(?:写|处理|补充|维护|提供)/,
        /(?:我|用户).{0,24}(?:写|处理|补充|维护|提供).{0,24}(?:本地化|汉化|翻译)/,
        /(?:本地化|汉化|翻译).{0,24}(?:由|交给|留给)(?:我|用户).{0,12}(?:写|处理|补充|维护|提供)?/,
        /(?:不要|不用|无需|别|请勿).{0,16}(?:生成|创建|写|补充|修改|处理|维护)?.{0,12}(?:本地化|汉化|翻译)/,
        /(?:i(?:'ll| will)?|the user|user).{0,24}(?:handle|write|provide|maintain|manage).{0,24}locali[sz]ation/i,
        /locali[sz]ation.{0,24}(?:is|will be)?.{0,12}(?:handled|written|provided|maintained|managed).{0,16}(?:by me|by the user)/i,
        /(?:leave|keep).{0,12}locali[sz]ation.{0,16}(?:to me|to the user|user-owned)/i,
        /(?:do not|don't|no need to).{0,16}(?:write|create|generate|modify|handle)?.{0,12}locali[sz]ation/i,
    ].some(pattern => pattern.test(text));
}

function hasIgnoreWarningIntent(text: string): boolean {
    if (/(?:不要|不能|请勿).{0,6}(?:忽略|无视).{0,12}(?:错误|问题|警告)|(?:do not|don't|must not).{0,8}ignore.{0,12}(?:errors?|warnings?|diagnostics?)/i.test(text)) {
        return false;
    }
    return [
        /(?:忽略|无视|不用管|不要处理|别管|放行).{0,20}(?:错误|问题|警告|黄色|诊断)/,
        /(?:错误|问题|警告|黄色|诊断).{0,20}(?:忽略|无视|不用管|不要处理|别管|放行)/,
        /(?:ignore|disregard|leave|skip).{0,20}(?:errors?|warnings?|yellow diagnostics?|diagnostics?)/i,
        /(?:errors?|warnings?|yellow diagnostics?|diagnostics?).{0,20}(?:can be ignored|should be ignored|may be ignored|leave them)/i,
    ].some(pattern => pattern.test(text));
}

/** Derive a host-enforced policy from the actual user turn plus the coordinator's structured interpretation. */
export function deriveUserExecutionPolicy(
    originalUserMessage: unknown,
    declaredPolicy: unknown,
): UserExecutionPolicy {
    const text = typeof originalUserMessage === 'string' ? originalUserMessage : '';
    const declared = declaredPolicy && typeof declaredPolicy === 'object'
        ? declaredPolicy as Record<string, unknown>
        : {};

    return {
        localisationOwnership:
            hasUserOwnedLocalisationIntent(text) || declared.localisationOwnership === 'user'
                ? 'user'
                : DEFAULT_USER_EXECUTION_POLICY.localisationOwnership,
        warningHandling:
            hasIgnoreWarningIntent(text) || declared.warningHandling === 'ignore'
                ? 'ignore'
                : DEFAULT_USER_EXECUTION_POLICY.warningHandling,
    };
}
