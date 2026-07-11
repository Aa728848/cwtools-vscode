/** Keeps delayed QuickPick selection events from being treated as user input. */
export class QuickPickSelectionGuard {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private suppressed = false;
    private expectedIds = new Set<string>();

    get active(): boolean {
        return this.suppressed;
    }

    beginProgrammaticUpdate(expectedIds: Iterable<string>): void {
        this.suppressed = true;
        this.expectedIds = new Set(expectedIds);
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.release();
        }, 100);
    }

    shouldIgnore(selectionIds: Iterable<string>): boolean {
        if (!this.suppressed) return false;
        const actual = new Set(selectionIds);
        const reachedExpectedSelection = actual.size === this.expectedIds.size
            && Array.from(actual).every(id => this.expectedIds.has(id));
        if (reachedExpectedSelection) this.release();
        return true;
    }

    dispose(): void {
        this.release();
    }

    private release(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.suppressed = false;
        this.expectedIds.clear();
    }
}
