export interface AgentHandoff {
    version: 1;
    summary: string;
    changedFiles: string[];
    verification: string[];
    unresolved: string[];
    rawOutput?: string;
}

function section(text: string, name: string): string | undefined {
    const expression = new RegExp(`(?:^|\\n)#{0,3}\\s*${name}\\s*:?\\s*\\n([\\s\\S]*?)(?=\\n#{0,3}\\s*(?:summary|changed files|verification|unresolved)\\s*:?\\s*\\n|$)`, 'i');
    return expression.exec(text)?.[1]?.trim();
}

function lines(value: string | undefined): string[] {
    return (value ?? '').split(/\r?\n/)
        .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
        .filter(Boolean);
}

export function parseAgentHandoff(output: string, writtenFiles: readonly string[] = []): AgentHandoff {
    const summary = section(output, 'summary') ?? output.trim();
    const parsedFiles = lines(section(output, 'changed files'));
    return {
        version: 1,
        summary: summary.slice(0, 12_000),
        changedFiles: [...new Set([...parsedFiles, ...writtenFiles])].sort(),
        verification: lines(section(output, 'verification')),
        unresolved: lines(section(output, 'unresolved')),
        rawOutput: output,
    };
}

export function validateAgentHandoff(
    handoff: AgentHandoff,
    policy: { minCharacters: number; requiredSections: string[] },
): string[] {
    const missing: string[] = [];
    if (handoff.summary.trim().length < policy.minCharacters) missing.push('summary');
    if (policy.requiredSections.includes('changedFiles') && handoff.changedFiles.length === 0) missing.push('changedFiles');
    if (policy.requiredSections.includes('verification') && handoff.verification.length === 0) missing.push('verification');
    if (policy.requiredSections.includes('unresolved') && handoff.unresolved.length === 0) missing.push('unresolved');
    return missing;
}

export function buildHandoffRepairPrompt(output: string, missing: readonly string[]): string {
    return [
        'Rewrite the following completed subtask result as a concise structured handoff.',
        'Do not use tools and do not claim work that is not present in the result.',
        `Missing or insufficient sections: ${missing.join(', ')}.`,
        'Use exactly these headings: Summary, Changed Files, Verification, Unresolved.',
        '',
        output,
    ].join('\n');
}

/** Tool-free deterministic repair used when a child omitted the handoff envelope. */
export function repairAgentHandoff(
    output: string,
    writtenFiles: readonly string[],
    missing: readonly string[],
): AgentHandoff {
    const parsed = parseAgentHandoff(output, writtenFiles);
    return {
        ...parsed,
        summary: parsed.summary.trim() || 'The sub-agent completed without a textual summary.',
        verification: parsed.verification.length > 0
            ? parsed.verification
            : ['Not reported by the sub-agent.'],
        unresolved: parsed.unresolved.length > 0
            ? parsed.unresolved
            : [missing.length > 0
                ? `The original result omitted or underspecified: ${missing.join(', ')}.`
                : 'None reported.'],
    };
}
