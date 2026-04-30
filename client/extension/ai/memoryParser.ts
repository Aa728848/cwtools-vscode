import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';

/** A single memory entry to be persisted */
export interface MemoryEntry {
    key: string;
    content: string;
    priority: 'high' | 'normal' | 'low';
}

/**
 * Parses the .cwtools-ai-memory.md file to extract workspace-specific rules.
 * Also supports appending new memory entries and pruning old ones.
 */
export class MemoryParser {
    private cache: string | null = null;
    private lastMtime: number = 0;

    /** Max ~4000 characters (approx 1000 tokens) */
    static readonly MAX_MEMORY_CHARS = 4000;

    constructor(private workspaceRoot: string) {}

    /** Get the full path to the memory file */
    public get memoryFilePath(): string {
        return path.join(this.workspaceRoot, '.cwtools-ai-memory.md');
    }

    /**
     * Reads and parses the memory file if it exists.
     * Uses caching to avoid excessive file reads.
     */
    public getMemoryPrompt(): string {
        try {
            if (!this.workspaceRoot) return '';
            
            const memoryPath = this.memoryFilePath;
            if (!fs.existsSync(memoryPath)) {
                this.cache = null;
                return '';
            }

            const stats = fs.statSync(memoryPath);
            if (this.cache && stats.mtimeMs === this.lastMtime) {
                return this.cache;
            }

            const rawContent = fs.readFileSync(memoryPath, 'utf8').trim();
            if (!rawContent) {
                this.cache = null;
                return '';
            }

            // Enforce usage suggestion: Keep it core, don't use it as an encyclopedia.
            let content = rawContent;
            let warning = '';
            
            if (content.length > MemoryParser.MAX_MEMORY_CHARS) {
                content = content.substring(0, MemoryParser.MAX_MEMORY_CHARS) + '\n...[TRUNCATED_DUE_TO_LENGTH_LIMIT]';
                warning = `\n> [!WARNING] The .cwtools-ai-memory.md file exceeds the recommended length and has been truncated. Please edit the file to keep only the absolute core rules to save context tokens.\n`;
            }

            this.lastMtime = stats.mtimeMs;
            this.cache = `<workspace-memory>\n# LONG-TERM WORKSPACE MEMORY${warning}\nThe following rules have been learned from past interactions. You MUST obey them:\n\n${content}\n</workspace-memory>\n`;
            
            return this.cache;
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error reading .cwtools-ai-memory.md', e);
            return '';
        }
    }

    /**
     * Append a new memory entry to the .cwtools-ai-memory.md file.
     * Auto-creates the file if it doesn't exist.
     * Auto-prunes if the file exceeds the character limit.
     */
    public async appendMemory(entry: MemoryEntry): Promise<{ success: boolean; message: string }> {
        try {
            if (!this.workspaceRoot) {
                return { success: false, message: 'No workspace root' };
            }

            const memoryPath = this.memoryFilePath;
            const now = new Date();
            const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
            const priorityTag = entry.priority !== 'normal' ? ` [${entry.priority}]` : '';

            const newBlock = `\n## [${dateStr}] ${entry.key}${priorityTag}\n${entry.content}\n`;

            // Append to file (create if not exists)
            let existing = '';
            if (fs.existsSync(memoryPath)) {
                existing = fs.readFileSync(memoryPath, 'utf8');
            } else {
                existing = '# CWTools AI Memory\n\n> Auto-generated workspace memory. AI will reference these rules in every conversation.\n';
            }

            const updated = existing + newBlock;
            fs.writeFileSync(memoryPath, updated, 'utf8');

            // Invalidate cache
            this.cache = null;
            this.lastMtime = 0;

            // Auto-prune if over limit
            if (updated.length > MemoryParser.MAX_MEMORY_CHARS) {
                this.pruneMemory();
            }

            return { success: true, message: `Memory saved: "${entry.key}"` };
        } catch (e: any) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error appending memory', e);
            return { success: false, message: `Failed to save memory: ${e?.message ?? e}` };
        }
    }

    /**
     * Prune the memory file by removing the oldest low-priority entries
     * until the file is under the character limit.
     */
    public pruneMemory(): void {
        try {
            const memoryPath = this.memoryFilePath;
            if (!fs.existsSync(memoryPath)) return;

            let content = fs.readFileSync(memoryPath, 'utf8');
            if (content.length <= MemoryParser.MAX_MEMORY_CHARS) return;

            // Parse sections by ## headings
            const sections = content.split(/(?=^## )/m);
            const header = sections[0] || ''; // Everything before first ## 
            const entries = sections.slice(1);

            // Sort: low priority first, then oldest first (for removal candidates)
            const priorityOrder: Record<string, number> = { low: 0, normal: 1, high: 2 };
            const scored = entries.map((entry, idx) => {
                const isLow = entry.includes('[low]');
                const isHigh = entry.includes('[high]');
                const priority = isHigh ? 'high' : isLow ? 'low' : 'normal';
                return { entry, idx, priority, score: priorityOrder[priority] ?? 1 };
            });

            // Remove lowest priority entries first (oldest among same priority)
            scored.sort((a, b) => a.score - b.score || a.idx - b.idx);

            let totalLen = header.length;
            const keepEntries: typeof scored = [];

            // Keep from highest priority first
            for (const s of [...scored].reverse()) {
                if (totalLen + s.entry.length <= MemoryParser.MAX_MEMORY_CHARS) {
                    keepEntries.push(s);
                    totalLen += s.entry.length;
                }
            }

            // Restore original order
            keepEntries.sort((a, b) => a.idx - b.idx);
            const pruned = header + keepEntries.map(s => s.entry).join('');

            fs.writeFileSync(memoryPath, pruned, 'utf8');
            this.cache = null;
            this.lastMtime = 0;

            ErrorReporter.debug(SOURCE.MEMORY_PARSER, `Pruned memory: removed ${entries.length - keepEntries.length} entries`);
        } catch (e) {
            ErrorReporter.debug(SOURCE.MEMORY_PARSER, 'Error pruning memory', e);
        }
    }
}

