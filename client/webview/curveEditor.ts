export interface CurvePoint {
    x: number;
    y: number;
}

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function evalCurve(points: CurvePoint[], t: number): number {
    if (points.length === 0) return 1;
    const sorted = [...points]
        .map(point => ({ x: clamp01(point.x), y: point.y }))
        .sort((a, b) => a.x - b.x);
    if (t <= sorted[0]!.x) return sorted[0]!.y;
    if (t >= sorted[sorted.length - 1]!.x) return sorted[sorted.length - 1]!.y;
    if (sorted.length === 1) return sorted[0]!.y;

    const n = sorted.length;
    const dx: number[] = [];
    const slope: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        const span = Math.max(1e-6, sorted[i + 1]!.x - sorted[i]!.x);
        dx.push(span);
        slope.push((sorted[i + 1]!.y - sorted[i]!.y) / span);
    }

    const tangent = new Array<number>(n).fill(0);
    tangent[0] = slope[0]!;
    tangent[n - 1] = slope[n - 2]!;
    for (let i = 1; i < n - 1; i++) {
        const prev = slope[i - 1]!;
        const next = slope[i]!;
        if (prev * next <= 0) {
            tangent[i] = 0;
        } else {
            const w1 = 2 * dx[i]! + dx[i - 1]!;
            const w2 = dx[i]! + 2 * dx[i - 1]!;
            tangent[i] = (w1 + w2) / (w1 / prev + w2 / next);
        }
    }

    for (let i = 0; i < n - 1; i++) {
        const m = slope[i]!;
        if (Math.abs(m) < 1e-6) {
            tangent[i] = 0;
            tangent[i + 1] = 0;
            continue;
        }
        const a = tangent[i]! / m;
        const b = tangent[i + 1]! / m;
        const sum = a * a + b * b;
        if (sum > 9) {
            const tau = 3 / Math.sqrt(sum);
            tangent[i] = tau * a * m;
            tangent[i + 1] = tau * b * m;
        }
    }

    let index = 0;
    for (let i = 0; i < n - 1; i++) {
        if (t >= sorted[i]!.x && t <= sorted[i + 1]!.x) {
            index = i;
            break;
        }
    }
    const h = dx[index]!;
    const localT = (t - sorted[index]!.x) / h;
    const h00 = (2 * localT * localT * localT) - (3 * localT * localT) + 1;
    const h10 = (localT * localT * localT) - (2 * localT * localT) + localT;
    const h01 = (-2 * localT * localT * localT) + (3 * localT * localT);
    const h11 = (localT * localT * localT) - (localT * localT);
    return h00 * sorted[index]!.y +
        h10 * h * tangent[index]! +
        h01 * sorted[index + 1]!.y +
        h11 * h * tangent[index + 1]!;
}

export class CurveEditor {
    private readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private readonly onChange: (points: CurvePoint[]) => void;
    private points: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    private draggingIndex: number | null = null;
    private selectedIndex: number | null = null;
    private readonly disposables: Array<() => void> = [];

    constructor(canvas: HTMLCanvasElement, onChange: (points: CurvePoint[]) => void) {
        this.canvas = canvas;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context is unavailable');
        this.ctx = ctx;
        this.onChange = onChange;
        this.register();
        this.draw();
    }

    setPoints(points: CurvePoint[]): void {
        this.points = this.normalize(points.length ? points : [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
        this.selectedIndex = null;
        this.draw();
    }

    dispose(): void {
        while (this.disposables.length) this.disposables.pop()?.();
    }

    private register(): void {
        this.canvas.tabIndex = 0;
        const pointerDown = (event: PointerEvent) => {
            this.canvas.focus();
            const hit = this.hitTest(event.offsetX, event.offsetY);
            if (hit >= 0) {
                this.draggingIndex = hit;
                this.selectedIndex = hit;
                this.canvas.setPointerCapture(event.pointerId);
            } else {
                this.selectedIndex = null;
            }
            this.draw();
        };
        const pointerMove = (event: PointerEvent) => {
            if (this.draggingIndex === null) return;
            const point = this.toCurvePoint(event);
            const index = this.draggingIndex;
            const minX = index === 0 ? 0 : this.points[index - 1]!.x + 0.001;
            const maxX = index === this.points.length - 1 ? 1 : this.points[index + 1]!.x - 0.001;
            this.points[index] = {
                x: index === 0 ? 0 : index === this.points.length - 1 ? 1 : Math.max(minX, Math.min(maxX, point.x)),
                y: point.y,
            };
            this.draw();
            this.onChange(this.points.map(p => ({ ...p })));
        };
        const pointerUp = (event: PointerEvent) => {
            if (this.draggingIndex !== null && this.canvas.hasPointerCapture(event.pointerId)) {
                this.canvas.releasePointerCapture(event.pointerId);
            }
            this.draggingIndex = null;
        };
        const doubleClick = (event: MouseEvent) => {
            const point = this.toCurvePoint(event);
            this.points.push(point);
            this.points = this.normalize(this.points);
            this.selectedIndex = this.nearestPointIndex(point);
            this.draw();
            this.onChange(this.points.map(p => ({ ...p })));
        };
        const contextMenu = (event: MouseEvent) => {
            event.preventDefault();
            const hit = this.hitTest(event.offsetX, event.offsetY);
            if (hit > 0 && hit < this.points.length - 1) {
                this.points.splice(hit, 1);
                this.selectedIndex = null;
                this.draw();
                this.onChange(this.points.map(p => ({ ...p })));
            }
        };
        const keyDown = (event: KeyboardEvent) => {
            if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedIndex !== null) {
                const index = this.selectedIndex;
                if (index > 0 && index < this.points.length - 1) {
                    this.points.splice(index, 1);
                    this.selectedIndex = null;
                    this.draw();
                    this.onChange(this.points.map(p => ({ ...p })));
                }
            }
        };
        this.canvas.addEventListener('pointerdown', pointerDown);
        this.canvas.addEventListener('pointermove', pointerMove);
        this.canvas.addEventListener('pointerup', pointerUp);
        this.canvas.addEventListener('dblclick', doubleClick);
        this.canvas.addEventListener('contextmenu', contextMenu);
        this.canvas.addEventListener('keydown', keyDown);
        this.disposables.push(
            () => this.canvas.removeEventListener('pointerdown', pointerDown),
            () => this.canvas.removeEventListener('pointermove', pointerMove),
            () => this.canvas.removeEventListener('pointerup', pointerUp),
            () => this.canvas.removeEventListener('dblclick', doubleClick),
            () => this.canvas.removeEventListener('contextmenu', contextMenu),
            () => this.canvas.removeEventListener('keydown', keyDown),
        );
    }

    private normalize(points: CurvePoint[]): CurvePoint[] {
        const sorted = points.map(p => ({ x: clamp01(p.x), y: clamp01(p.y) })).sort((a, b) => a.x - b.x);
        sorted[0]!.x = 0;
        sorted[sorted.length - 1]!.x = 1;
        return sorted;
    }

    private nearestPointIndex(target: CurvePoint): number {
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        this.points.forEach((point, index) => {
            const distance = Math.hypot(point.x - target.x, point.y - target.y);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        });
        return bestIndex;
    }

    private toCurvePoint(event: MouseEvent | PointerEvent): CurvePoint {
        const rect = this.canvas.getBoundingClientRect();
        const x = clamp01((event.clientX - rect.left) / Math.max(1, rect.width));
        const y = clamp01(1 - ((event.clientY - rect.top) / Math.max(1, rect.height)));
        return { x, y };
    }

    private hitTest(x: number, y: number): number {
        for (let i = 0; i < this.points.length; i++) {
            const screen = this.toScreen(this.points[i]!);
            if (Math.hypot(screen.x - x, screen.y - y) <= 8) return i;
        }
        return -1;
    }

    private toScreen(point: CurvePoint): CurvePoint {
        return {
            x: point.x * this.canvas.width,
            y: (1 - clamp01(point.y)) * this.canvas.height,
        };
    }

    private draw(): void {
        const { width, height } = this.canvas;
        const style = getComputedStyle(document.body);
        const bg = style.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
        const fg = style.getPropertyValue('--vscode-editor-foreground').trim() || '#cccccc';
        const line = style.getPropertyValue('--vscode-focusBorder').trim() || '#007acc';
        const grid = style.getPropertyValue('--vscode-editorWidget-border').trim() || '#454545';
        this.ctx.clearRect(0, 0, width, height);
        this.ctx.fillStyle = bg;
        this.ctx.fillRect(0, 0, width, height);

        this.ctx.strokeStyle = grid;
        this.ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const x = i * width / 4;
            const y = i * height / 4;
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height);
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();
        }

        this.ctx.strokeStyle = line;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        for (let i = 0; i <= 100; i++) {
            const x = i / 100;
            const y = clamp01(evalCurve(this.points, x));
            const screen = this.toScreen({ x, y });
            if (i === 0) this.ctx.moveTo(screen.x, screen.y);
            else this.ctx.lineTo(screen.x, screen.y);
        }
        this.ctx.stroke();

        this.points.forEach((point, index) => {
            const screen = this.toScreen(point);
            this.ctx.beginPath();
            this.ctx.arc(screen.x, screen.y, index === this.selectedIndex ? 6 : 5, 0, Math.PI * 2);
            this.ctx.fillStyle = index === this.selectedIndex ? line : fg;
            this.ctx.fill();
        });
    }
}
