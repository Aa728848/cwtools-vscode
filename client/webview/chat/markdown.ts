import { escapeHtml } from './formatters';

export interface MarkdownLabels {
    waitingForChoice?: string;
}

const DEFAULT_LABELS: Required<MarkdownLabels> = {
    waitingForChoice: 'Waiting for your choice...',
};

interface MarkdownBlock {
    lang: string;
    code: string;
    isCard?: boolean;
}

export function createMarkdownRenderer(labels: MarkdownLabels = {}): (rawText: string) => string {
    const merged = { ...DEFAULT_LABELS, ...labels };
    return (rawText: string) => renderMarkdown(rawText, merged);
}

export function renderMarkdown(rawText: string, labels: MarkdownLabels = {}): string {
    const merged = { ...DEFAULT_LABELS, ...labels };
    if (!rawText) return '';

    const blocks: MarkdownBlock[] = [];
    const text = rawText.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const i = blocks.length;
        blocks.push({ lang: String(lang).trim(), code: String(code) });
        return '\n\x00BLOCK' + i + '\x00\n';
    });

    const lines = text.split('\n');
    const out: string[] = [];
    let i = 0;
    let paraLines: string[] = [];

    function flushPara(): void {
        if (!paraLines.length) return;
        const lineHtml = paraLines.map(line => {
            const t = line.trim();
            // eslint-disable-next-line no-control-regex
            if (/^\x00BLOCK\d+\x00$/.test(t)) {
                const block = blocks[+t.match(/\d+/)![0]!]!;
                return renderBlock(block);
            }
            return renderInlineMarkdown(line);
        });
        out.push('<p>' + lineHtml.join('<br>') + '</p>');
        paraLines = [];
    }

    function renderBlock(block: MarkdownBlock): string {
        if (block.isCard) return block.code;
        const language = block.lang.trim().toLowerCase();
        if (language === 'mermaid' || language === 'mmd') {
            return '<div class="md-mermaid" data-mermaid-state="pending">' +
                '<div class="md-mermaid-loading" role="status">Mermaid</div>' +
                '<div class="md-mermaid-output"></div>' +
                '<pre class="md-mermaid-source"><code>' + escapeHtml(block.code) + '</code></pre>' +
                '</div>';
        }
        return '<div class="md-codeblock"><div class="md-codeblock-lang">' +
            escapeHtml(block.lang) +
            '</div><code>' +
            escapeHtml(block.code) +
            '</code></div>';
    }

    while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();

        if (!trimmed) {
            flushPara();
            i++;
            continue;
        }

        // eslint-disable-next-line no-control-regex
        if (/^\x00BLOCK\d+\x00$/.test(trimmed)) {
            flushPara();
            const block = blocks[+trimmed.match(/\d+/)![0]!]!;
            out.push(renderBlock(block));
            i++;
            continue;
        }

        const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (heading) {
            flushPara();
            const level = heading[1]!.length;
            out.push('<h' + level + '>' + renderInlineMarkdown(heading[2]!) + '</h' + level + '>');
            i++;
            continue;
        }

        if (/^[-*_]{3,}$/.test(trimmed)) {
            flushPara();
            out.push('<hr>');
            i++;
            continue;
        }

        if (/^>/.test(trimmed)) {
            flushPara();
            const quoteLines: string[] = [];
            while (i < lines.length && /^>/.test(lines[i]!.trim())) {
                quoteLines.push(lines[i]!.replace(/^>\s?/, ''));
                i++;
            }
            out.push('<blockquote>' + renderMarkdown(quoteLines.join('\n'), merged) + '</blockquote>');
            continue;
        }

        if (/^\|/.test(trimmed) && i + 1 < lines.length && /^[/|\s:-]+$/.test(lines[i + 1]!.trim())) {
            flushPara();
            const tableLines: string[] = [];
            while (i < lines.length && /^\|/.test(lines[i]!.trim())) {
                tableLines.push(lines[i]!);
                i++;
            }
            if (tableLines.length >= 2) {
                const headers = tableLines[0]!.split('|').map(c => c.trim()).filter(Boolean);
                const rows = tableLines.slice(2).map(r => r.split('|').map(c => c.trim()).filter(Boolean));
                let table = '<table><thead><tr>' + headers.map(h => '<th>' + renderInlineMarkdown(h) + '</th>').join('') + '</tr></thead><tbody>';
                rows.forEach(row => {
                    table += '<tr>' + row.map(cell => '<td>' + renderInlineMarkdown(cell) + '</td>').join('') + '</tr>';
                });
                out.push('<div class="md-table-wrap">' + table + '</tbody></table></div>');
            }
            continue;
        }

        if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
            flushPara();
            const ordered = /^\d+\.\s/.test(trimmed);
            const rendered = renderList(lines, i, ordered ? 'ol' : 'ul');
            out.push(rendered.html);
            i = rendered.nextIndex;
            continue;
        }

        paraLines.push(line);
        i++;
    }

    flushPara();
    return out.join('');
}

export function renderInlineMarkdown(raw: string): string {
    const mediaBlocks: string[] = [];
    let s = raw.replace(/<(video|audio)\s+([^>]+)>(?:<\/\1>)?/gi, (_match: string, tag: string, attrs: string) => {
        const safeAttrs = attrs.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        const finalAttrs = /controls/i.test(safeAttrs) ? safeAttrs : safeAttrs + ' controls';
        const style = tag.toLowerCase() === 'video'
            ? 'max-width:100%; border-radius:6px; margin:8px 0; display:block;'
            : 'width:100%; margin:8px 0; display:block;';
        mediaBlocks.push(`<${tag.toLowerCase()} ${finalAttrs} style="${style}"></${tag.toLowerCase()}>`);
        return '\x01MEDIA' + (mediaBlocks.length - 1) + '\x01';
    });

    s = escapeHtml(s);
    const codeBlocks: string[] = [];
    s = s.replace(/`([^`]+)`/g, (_match: string, code: string) => {
        codeBlocks.push('<code>' + code + '</code>');
        return '\x01CODE' + (codeBlocks.length - 1) + '\x01';
    });

    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|\W)__([^_\n]+)__(\W|$)/g, '$1<strong>$2</strong>$3');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<em>$2</em>$3');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/!?\[([^\]]*)\]\(([^)]+\.(?:mp3|wav|ogg|aac|m4a|flac)(?:\?[^)]*)?)\)/gi,
        (_match: string, _label: string, url: string) => '<audio src="' + escapeHtml(url) + '" controls style="width:100%; margin: 8px 0; display: block;"></audio>');
    s = s.replace(/!?\[([^\]]*)\]\(([^)]+\.(?:mp4|webm|ogv|mov)(?:\?[^)]*)?)\)/gi,
        (_match: string, _label: string, url: string) => '<video src="' + escapeHtml(url) + '" controls style="max-width:100%; border-radius:6px; margin: 8px 0; display: block;"></video>');
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
        (_match: string, alt: string, url: string) => '<img src="' + escapeHtml(url) + '" alt="' + escapeHtml(alt) + '" style="max-width:100%; border-radius:6px; margin: 8px 0; display: block;" />');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
        (_match: string, label: string, url: string) => '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + escapeHtml(label) + '</a>');

    // eslint-disable-next-line no-control-regex
    s = s.replace(/\x01CODE(\d+)\x01/g, (_match: string, index: string) => codeBlocks[parseInt(index)]!);
    // eslint-disable-next-line no-control-regex
    s = s.replace(/\x01MEDIA(\d+)\x01/g, (_match: string, index: string) => mediaBlocks[parseInt(index)]!);
    return s;
}

function renderList(lines: string[], startIndex: number, initialTag: 'ul' | 'ol'): { html: string; nextIndex: number } {
    const stack: Array<{ tag: 'ul' | 'ol'; indent: number }> = [];
    const htmlParts: string[] = [];
    const getIndent = (line: string): number => line.match(/^(\s*)/)?.[1]?.length ?? 0;
    const startList = (tag: 'ul' | 'ol', indent: number): void => {
        stack.push({ tag, indent });
        htmlParts.push('<' + tag + '>');
    };
    const closeList = (): void => {
        const item = stack.pop();
        if (item) htmlParts.push('</' + item.tag + '>');
    };

    let i = startIndex;
    startList(initialTag, getIndent(lines[i]!));
    while (i < lines.length) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (!trimmed) {
            i++;
            break;
        }
        const indent = getIndent(line);
        const unorderedMatch = trimmed.match(/^[-*+]\s+(.*)/);
        const orderedMatch = trimmed.match(/^\d+\.\s+(.*)/);
        if (unorderedMatch || orderedMatch) {
            const content = unorderedMatch ? unorderedMatch[1]! : orderedMatch![1]!;
            const tag = unorderedMatch ? 'ul' : 'ol';
            while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
                htmlParts.push('</li>');
                closeList();
            }
            if (stack.length > 0 && indent > stack[stack.length - 1]!.indent) {
                startList(tag, indent);
            } else if (stack.length > 0 && htmlParts[htmlParts.length - 1] !== '<' + stack[stack.length - 1]!.tag + '>') {
                htmlParts.push('</li>');
            }
            htmlParts.push('<li>' + renderInlineMarkdown(content));
            i++;
        } else if (/^\s{2,}/.test(line) && stack.length > 0) {
            htmlParts.push(' ' + renderInlineMarkdown(trimmed));
            i++;
        } else {
            break;
        }
    }
    while (stack.length > 0) {
        htmlParts.push('</li>');
        closeList();
    }
    return { html: htmlParts.join(''), nextIndex: i };
}
