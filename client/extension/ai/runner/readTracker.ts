import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface ReadFileInfo {
    mtime: number;
    byteHash: string;
}

export class ReadTracker {
    private readonly readMap = new Map<string, ReadFileInfo>();

    private normalizeKey(filePath: string): string {
        let resolved: string;
        try {
            resolved = path.resolve(filePath);
        } catch {
            resolved = filePath;
        }
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    markRead(filePath: string): void {
        try {
            if (!fs.existsSync(filePath)) {
                return;
            }
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath);
            const byteHash = crypto.createHash('sha256').update(content).digest('hex');

            this.readMap.set(this.normalizeKey(filePath), {
                mtime: stat.mtimeMs,
                byteHash
            });
        } catch {
            // 忽略文件读取错误
        }
    }

    canWrite(filePath: string): { ok: boolean; reason?: string } {
        if (!fs.existsSync(filePath)) {
            return { ok: true };
        }

        const info = this.readMap.get(this.normalizeKey(filePath));
        if (!info) {
            return {
                ok: false,
                reason: `File "${filePath}" was not read in this conversation. Call read_file first, then retry the edit.`
            };
        }

        try {
            const currentStat = fs.statSync(filePath);
            // 验证物理修改时间是否依然一致，防止外部更改引起的冲突
            if (currentStat.mtimeMs !== info.mtime) {
                return {
                    ok: false,
                    reason: `File "${filePath}" was modified externally since last read. Call read_file to fetch the latest version, then retry the edit.`
                };
            }
        } catch {
            return {
                ok: false,
                reason: `Failed to verify integrity for file "${filePath}". Please perform a fresh read_file call.`
            };
        }

        return { ok: true };
    }

    /**
     * 写操作成功后调用，自动更新 tracker 中的 mtime 以免误拦截后续连续修改
     */
    markWritten(filePath: string): void {
        try {
            if (fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                const content = fs.readFileSync(filePath);
                const byteHash = crypto.createHash('sha256').update(content).digest('hex');

                this.readMap.set(this.normalizeKey(filePath), {
                    mtime: stat.mtimeMs,
                    byteHash
                });
            } else {
                this.readMap.delete(this.normalizeKey(filePath));
            }
        } catch {
            this.readMap.delete(this.normalizeKey(filePath));
        }
    }

    /**
     * 清理某个特定文件的读记录（例如在多 Agent 场景下子 Agent 改写了文件，需要强制父 Agent 重新读取）
     */
    invalidate(filePath: string): void {
        this.readMap.delete(this.normalizeKey(filePath));
    }

    /**
     * 重置所有记录
     */
    reset(): void {
        this.readMap.clear();
    }
}
