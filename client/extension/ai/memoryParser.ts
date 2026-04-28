import * as fs from 'fs';
import * as path from 'path';
import { ErrorReporter } from './errorReporter';
import { SOURCE } from './messages';

/**
 * Parses the .cwtools-ai-memory.md file to extract workspace-specific rules.
 */
export class MemoryParser {
    private cache: string | null = null;
    private lastMtime: number = 0;

    constructor(private workspaceRoot: string) {}

    /**
     * Reads and parses the memory file if it exists.
     * Uses caching to avoid excessive file reads.
     */
    public getMemoryPrompt(): string {
        try {
            if (!this.workspaceRoot) return '';
            
            const memoryPath = path.join(this.workspaceRoot, '.cwtools-ai-memory.md');
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
            // Max ~4000 characters (approx 1000 tokens).
            const MAX_MEMORY_CHARS = 4000;
            let content = rawContent;
            let warning = '';
            
            if (content.length > MAX_MEMORY_CHARS) {
                content = content.substring(0, MAX_MEMORY_CHARS) + '\n...[TRUNCATED_DUE_TO_LENGTH_LIMIT]';
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
}
