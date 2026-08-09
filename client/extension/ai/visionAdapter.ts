/**
 * Vision fallback adapter.
 *
 * When the active provider cannot process images natively, the MiniMax CLI
 * (`mmx`) can describe them as text. The child-process handling lives here so
 * agentRunner does not inline shell commands: every invocation uses `execFile`
 * with an explicit timeout and the turn's abort signal, so a cancelled turn
 * also cancels the VLM subprocess.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AgentStep } from './types';

const MMX_VERSION_TIMEOUT_MS = 10_000;
const MMX_DESCRIBE_TIMEOUT_MS = 60_000;
/** Refuse absurd base64 payloads (8 MiB decoded) instead of writing them to disk. */
const MAX_IMAGE_DECODED_BYTES = 8 * 1024 * 1024;

const execFileAsync = promisify(execFile);

/**
 * Windows ships CLI shims as `.cmd` files, which `execFile` cannot spawn
 * directly; route through the shell only there. Arguments stay an array, so
 * Node quotes them — no shell string concatenation.
 */
function execOptions(signal?: AbortSignal, timeoutMs = MMX_DESCRIBE_TIMEOUT_MS) {
    return {
        timeout: timeoutMs,
        signal,
        shell: process.platform === 'win32',
    } as const;
}

/** True when `mmx --version` succeeds within its own short timeout. */
export async function isMinimaxCliAvailable(signal?: AbortSignal): Promise<boolean> {
    try {
        await execFileAsync('mmx', ['--version'], execOptions(signal, MMX_VERSION_TIMEOUT_MS));
        return true;
    } catch {
        return false;
    }
}

async function describeWithMmx(imagePath: string, signal?: AbortSignal): Promise<string> {
    const { stdout } = await execFileAsync(
        'mmx',
        ['vision', 'describe', '--image', imagePath, '--non-interactive', '--no-color'],
        execOptions(signal),
    );
    return stdout.trim();
}

export interface VisionDescribeOptions {
    /** Base64 data-URL images to describe (e.g. `data:image/png;base64,...`). */
    images: string[];
    /** Turn abort signal; aborts any in-flight `mmx` subprocess. */
    signal?: AbortSignal;
    /** Progress callback (one step per image attempt). */
    onStep?: (step: AgentStep) => void;
}

export interface VisionDescribeResult {
    /** Text block to append to the user message. */
    visionText: string;
    /** Number of images successfully described. */
    describedCount: number;
}

/**
 * Describes images via the MiniMax CLI. Returns `null` when the CLI is not
 * available (or has no images to process), so callers fall back to the
 * "vision unsupported" notice. Individual image failures are recorded in the
 * returned text and never reject the caller.
 */
export async function describeImagesWithMinimaxCli(options: VisionDescribeOptions): Promise<VisionDescribeResult | null> {
    const { images, signal, onStep } = options;
    if (!images || images.length === 0) return null;
    if (!(await isMinimaxCliAvailable(signal))) return null;

    onStep?.({
        type: 'thinking',
        content: 'Using MiniMax CLI to process images...',
        timestamp: Date.now(),
    });

    let visionText = '\n\n[System Notice: The user attached image(s) to this message. Since you do not have native vision capabilities, the images were automatically analyzed by an external Vision AI. Below is the textual description of what the image contains. You MUST use this description to answer the user\'s prompt. Do NOT use file-system tools (like list_directory) to answer questions about the image unless specifically asked to correlate them.]\n';
    let describedCount = 0;

    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img) continue;

        const base64Index = img.indexOf('base64,');
        if (base64Index === -1) {
            visionText += `\nImage ${i + 1}: Invalid image data format.\n`;
            onStep?.({ type: 'thinking', content: `[VLM Image ${i + 1}]: Invalid format`, timestamp: Date.now() });
            continue;
        }

        const header = img.substring(0, base64Index);
        const extMatch = header.match(/^data:image\/([^;]+)/);
        const rawExt = extMatch && extMatch[1] ? extMatch[1] : 'jpg';
        const ext = rawExt === 'jpeg' ? 'jpg' : rawExt.replace(/[^a-zA-Z0-9]/g, '');
        const base64Data = img.substring(base64Index + 7);

        // 4 base64 chars ≈ 3 decoded bytes; allow a little slack for padding.
        if (base64Data.length > (MAX_IMAGE_DECODED_BYTES * 4) / 3 + 4) {
            visionText += `\nImage ${i + 1}: Skipped (image exceeds ${MAX_IMAGE_DECODED_BYTES / (1024 * 1024)} MiB limit).\n`;
            onStep?.({ type: 'thinking', content: `[VLM Image ${i + 1}]: Skipped (too large)`, timestamp: Date.now() });
            continue;
        }

        const tempFilePath = path.join(os.tmpdir(), `mmx_img_${Date.now()}_${i}.${ext}`);
        try {
            await fs.promises.writeFile(tempFilePath, Buffer.from(base64Data, 'base64'));
            const vlmResult = await describeWithMmx(tempFilePath, signal);
            visionText += `\nImage ${i + 1}:\n${vlmResult}\n`;
            describedCount++;
            onStep?.({
                type: 'thinking',
                content: `[VLM Image ${i + 1}]: ${vlmResult}`,
                timestamp: Date.now(),
            });
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            visionText += `\nImage ${i + 1}: Failed to analyze (${errMsg})\n`;
            onStep?.({
                type: 'thinking',
                content: `[VLM Image ${i + 1} Failed]: ${errMsg}`,
                timestamp: Date.now(),
            });
        } finally {
            await fs.promises.unlink(tempFilePath).catch(() => {});
        }
    }

    visionText += '\n[End of Image Descriptions]\n';
    return { visionText, describedCount };
}
