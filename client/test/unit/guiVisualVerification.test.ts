import { expect } from 'chai';
import {
    compareRgbaImages,
    isGuiVisualCapture,
    isGuiVisualCaptureRequest,
    isGuiVisualEvidence,
    GUI_VISUAL_MAX_REVIEW_ROUNDS,
    type GuiVisualCapture,
} from '../../shared/guiVisualVerification';
import { AgentInputQueue } from '../../extension/ai/runner/inputQueue';
import { queuedInputContent } from '../../extension/ai/runner/queuedInputContent';

const png = 'data:image/png;base64,AA==';
const capture: GuiVisualCapture = { dataUrl: png, width: 960, height: 720, frame: { x: 0, y: 0, width: 100, height: 100 } };

describe('GUI visual verification primitives', () => {
    it('returns zero changes for identical RGBA buffers', () => {
        const pixels = new Uint8ClampedArray(2 * 2 * 4).fill(128);
        const result = compareRgbaImages(pixels, new Uint8ClampedArray(pixels), 2, 2);
        expect(result.metrics.changedPixels).to.equal(0);
        expect(result.metrics.changeRatio).to.equal(0);
        expect(result.metrics.bounds).to.equal(undefined);
    });

    it('reports changed pixels and their bounds', () => {
        const before = new Uint8ClampedArray(3 * 2 * 4).fill(20);
        const after = new Uint8ClampedArray(before);
        after.set([255, 255, 255, 255], 4);
        after.set([255, 255, 255, 255], 20);
        const result = compareRgbaImages(before, after, 3, 2);
        expect(result.metrics.changedPixels).to.equal(2);
        expect(result.metrics.changeRatio).to.equal(2 / 6);
        expect(result.metrics.bounds).to.deep.equal({ x: 1, y: 0, width: 2, height: 2 });
    });

    it('rejects invalid comparison dimensions and buffers', () => {
        const pixels = new Uint8ClampedArray(16);
        expect(() => compareRgbaImages(pixels, pixels, 0, 2)).to.throw('Invalid visual comparison dimensions');
        expect(() => compareRgbaImages(pixels, new Uint8ClampedArray(4), 2, 2)).to.throw('identical RGBA dimensions');
    });

    it('validates captures, baselines and after-only evidence', () => {
        expect(isGuiVisualCapture(capture)).to.equal(true);
        expect(isGuiVisualCapture({ ...capture, dataUrl: 'https://example.invalid/a.png' })).to.equal(false);
        expect(isGuiVisualCaptureRequest({ requestId: 'r', runId: 'run', file: 'a.gui', round: 0, before: capture })).to.equal(true);
        expect(isGuiVisualEvidence({
            requestId: 'r', runId: 'run', file: 'a.gui', round: 1, status: 'after_only',
            after: png, frame: capture.frame, createdAt: Date.now(),
        }, true)).to.equal(true);
        expect(isGuiVisualEvidence({
            requestId: 'r', runId: 'run', file: 'a.gui', round: 3, status: 'after_only',
            after: png, frame: capture.frame, createdAt: Date.now(),
        }, true)).to.equal(false);
        expect(GUI_VISUAL_MAX_REVIEW_ROUNDS).to.equal(2);
    });

    it('injects images only for vision-capable providers and falls back to text otherwise', () => {
        const input = {
            id: 'visual-1', message: 'review', clientUserMessageId: 'visual-1',
            images: [png], createdAt: Date.now(), kind: 'visual_verification' as const, sequence: 0,
        };
        const native = queuedInputContent(input, '[Visual]', true);
        expect(Array.isArray(native)).to.equal(true);
        if (!Array.isArray(native)) throw new Error('Expected multimodal content parts.');
        expect(native).to.have.length(2);
        expect(native[1]?.type).to.equal('image_url');
        const fallback = queuedInputContent(input, '[Visual]', false);
        expect(fallback).to.be.a('string');
        expect(String(fallback)).to.include('Images were omitted');
        expect(String(fallback)).to.include('Use the supplied pixel metrics only');
    });

    it('queues visual evidence with images and its own input kind', () => {
        const queue = new AgentInputQueue('run');
        queue.enqueue('review', 'visual-1', [png, png], 'visual_verification');
        const drained = queue.drain();
        expect(drained).to.have.length(1);
        expect(drained[0]?.kind).to.equal('visual_verification');
        expect(drained[0]?.images).to.have.length(2);
    });
});
