export function braceDeltaOf(text: string): number {
	let depth = 0;
	let inString = false;
	let inComment = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === '\n' || ch === '\r') {
			inComment = false;
			inString = false; // PDX 字符串不跨行
			continue;
		}
		if (inComment) continue;
		if (inString) {
			if (ch === '\\') { i++; continue; } // 跳过转义字符
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '#') { inComment = true; continue; }
		if (ch === '"') { inString = true; continue; }
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
	}
	return depth;
}

export function lineIndentDelta(text: string): number {
	const delta = braceDeltaOf(text);
	return delta > 0 ? 1 : delta < 0 ? -1 : 0;
}

/**
 * 按括号层级重排每行缩进。
 *
 * @param lines      待重排的行（不含换行符）
 * @param baseDepth  第一行所处的起始括号深度
 * @param indentUnit 单层缩进字符串（Tab 或若干空格）
 * @returns 重排后的行；空行（仅空白）输出为空串
 */
export function reindentLines(lines: string[], baseDepth: number, indentUnit: string): string[] {
	let depth = baseDepth;
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.replace(/^[ \t]+/, '');
		if (trimmed.length === 0) {
			out.push('');
			continue;
		}
		// 行首是 `}` 时，本行应少缩进一层。
		const effectiveDepth = trimmed[0] === '}' ? depth - 1 : depth;
		const indent = indentUnit.repeat(Math.max(0, effectiveDepth));
		out.push(indent + trimmed);
		depth += lineIndentDelta(line);
	}
	return out;
}
