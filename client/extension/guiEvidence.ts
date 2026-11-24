import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { GUI_VISUAL_HEIGHT, GUI_VISUAL_WIDTH, type GuiVisualCapture } from '../shared/guiVisualVerification';
import type { GuiPanel } from './guiPanel';

interface StoredCapture {
    file: string;
    capture: GuiVisualCapture;
}

/** Bounded host-owned evidence store; external Agents read the returned PNG paths. */
export class GuiEvidenceHost {
    private readonly captures = new Map<string, StoredCapture>();

    constructor(private readonly artifactRoot: string) {}

    async capture(panel: GuiPanel, file: string, baselineArtifactId?: string): Promise<Record<string, unknown>> {
        const baseline = baselineArtifactId ? this.captures.get(baselineArtifactId) : undefined;
        if (baselineArtifactId && (!baseline || baseline.file !== file)) {
            throw new Error('baselineArtifactId is unknown, expired, or belongs to another GUI file.');
        }
        const evidence = await panel.captureVisual(baseline?.capture);
        const artifactId = 'gui_' + randomBytes(12).toString('base64url');
        const directory = path.join(this.artifactRoot, artifactId);
        fs.mkdirSync(directory, { recursive: true });
        const artifacts: Record<string, string> = {};
        this.writeImage(directory, 'after.png', evidence.after);
        artifacts.after = path.join(directory, 'after.png');
        if (evidence.before) {
            this.writeImage(directory, 'before.png', evidence.before);
            artifacts.before = path.join(directory, 'before.png');
        }
        if (evidence.diff) {
            this.writeImage(directory, 'diff.png', evidence.diff);
            artifacts.diff = path.join(directory, 'diff.png');
        }
        const document = (panel as unknown as { _document?: { version?: number; isDirty?: boolean } })._document;
        const metadata = {
            artifactId,
            file,
            documentVersion: document?.version,
            dirty: document?.isDirty === true,
            selection: (evidence as typeof evidence & { selection?: unknown }).selection,
            status: evidence.status,
            metrics: evidence.metrics,
            frame: evidence.frame,
            createdAt: evidence.createdAt,
            artifacts,
        };
        fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
        this.captures.set(artifactId, {
            file,
            capture: {
                dataUrl: evidence.after,
                width: GUI_VISUAL_WIDTH,
                height: GUI_VISUAL_HEIGHT,
                frame: evidence.frame,
            },
        });
        this.prune();
        return metadata;
    }

    private writeImage(directory: string, name: string, dataUrl: string): void {
        const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
        if (!match || dataUrl.length > 2_000_000) throw new Error('Invalid or oversized GUI PNG evidence.');
        fs.writeFileSync(path.join(directory, name), Buffer.from(match[1]!, 'base64'));
    }

    private prune(): void {
        while (this.captures.size > 16) {
            const oldest = this.captures.keys().next().value as string | undefined;
            if (!oldest) return;
            this.captures.delete(oldest);
            const directory = path.join(this.artifactRoot, oldest);
            for (const name of ['before.png', 'after.png', 'diff.png', 'metadata.json']) {
                try { fs.rmSync(path.join(directory, name), { force: true }); } catch { /* ignored */ }
            }
            try { fs.rmdirSync(directory); } catch { /* ignored */ }
        }
    }
}
