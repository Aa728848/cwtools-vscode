export interface LspPerformanceLogEntry {
	category: 'Completion' | 'Lint';
	message: string;
	timestamp: string;
}

export type LspPerformanceLogSink = (entry: LspPerformanceLogEntry) => void;

export interface CompletionPerformanceRequest {
	file: string;
	line: number;
	character: number;
	triggerKind: number;
	triggerCharacter?: string;
}

export type CompletionPerformanceOutcome =
	| { status: 'success'; itemCount: number }
	| { status: 'cancelled'; itemCount?: number }
	| { status: 'error'; error: unknown };

interface PendingCompletionPerformanceRequest extends CompletionPerformanceRequest {
	id: number;
	startedAtMs: number;
}

export interface CompletionPerformanceSnapshot {
	totalRequests: number;
	completedRequests: number;
	succeededRequests: number;
	cancelledRequests: number;
	failedRequests: number;
	averageElapsedMs: number;
	maxElapsedMs: number;
}

export interface ValidationPerformanceTrigger {
	uri: string;
	file: string;
	version: number;
	trigger: 'open' | 'change' | 'save';
}

export interface ValidationDiagnosticCounts {
	diagnostics: number;
	publishedDiagnostics: number;
	errors: number;
	warnings: number;
	information: number;
	hints: number;
}

interface PendingValidationPerformanceRequest extends ValidationPerformanceTrigger {
	id: number;
	startedAtMs: number;
}

export interface ValidationPerformanceSnapshot {
	totalTriggers: number;
	completedRequests: number;
	supersededRequests: number;
	droppedRequests: number;
	averageElapsedMs: number;
	maxElapsedMs: number;
}

const DEFAULT_MAX_PENDING_VALIDATIONS = 512;

export class LspPerformanceStats {
	private nextCompletionId = 0;
	private completionTotal = 0;
	private completionSucceeded = 0;
	private completionCancelled = 0;
	private completionFailed = 0;
	private completionTotalElapsedMs = 0;
	private completionMaxElapsedMs = 0;

	private nextValidationId = 0;
	private validationTotal = 0;
	private validationCompleted = 0;
	private validationSuperseded = 0;
	private validationDropped = 0;
	private validationTotalElapsedMs = 0;
	private validationMaxElapsedMs = 0;
	private readonly pendingValidations = new Map<string, PendingValidationPerformanceRequest>();

	constructor(
		private readonly log: LspPerformanceLogSink,
		private readonly now: () => number = Date.now,
		private readonly maxPendingValidations = DEFAULT_MAX_PENDING_VALIDATIONS,
	) {}

	beginCompletion(request: CompletionPerformanceRequest): PendingCompletionPerformanceRequest {
		this.completionTotal += 1;
		return {
			...request,
			id: ++this.nextCompletionId,
			startedAtMs: this.now(),
		};
	}

	finishCompletion(request: PendingCompletionPerformanceRequest, outcome: CompletionPerformanceOutcome): void {
		const finishedAtMs = this.now();
		const elapsedMs = Math.max(0, finishedAtMs - request.startedAtMs);
		this.completionTotalElapsedMs += elapsedMs;
		this.completionMaxElapsedMs = Math.max(this.completionMaxElapsedMs, elapsedMs);

		switch (outcome.status) {
			case 'success':
				this.completionSucceeded += 1;
				break;
			case 'cancelled':
				this.completionCancelled += 1;
				break;
			case 'error':
				this.completionFailed += 1;
				break;
		}

		const snapshot = this.completionSnapshot();
		const itemCount = outcome.status === 'error' ? undefined : outcome.itemCount;
		const error = outcome.status === 'error' ? this.singleLine(this.errorMessage(outcome.error), 240) : undefined;
		const fields = [
			'ClientCompletion',
			`request=${request.id}`,
			`status=${outcome.status}`,
			`elapsedMs=${elapsedMs}`,
			itemCount === undefined ? undefined : `items=${itemCount}`,
			`trigger=${this.completionTrigger(request.triggerKind)}`,
			request.triggerCharacter ? `triggerChar=${JSON.stringify(this.singleLine(request.triggerCharacter, 20))}` : undefined,
			`file=${this.singleLine(request.file, 240)}`,
			`line=${request.line + 1}`,
			`char=${request.character + 1}`,
			`total=${snapshot.totalRequests}`,
			`completed=${snapshot.completedRequests}`,
			`succeeded=${snapshot.succeededRequests}`,
			`cancelled=${snapshot.cancelledRequests}`,
			`failed=${snapshot.failedRequests}`,
			`averageMs=${snapshot.averageElapsedMs.toFixed(1)}`,
			`maxMs=${snapshot.maxElapsedMs}`,
			error ? `error=${error}` : undefined,
		].filter((value): value is string => value !== undefined);
		this.log({ category: 'Completion', message: fields.join(' '), timestamp: this.timestamp(finishedAtMs) });
	}

	recordValidationTrigger(trigger: ValidationPerformanceTrigger): void {
		this.validationTotal += 1;
		if (this.pendingValidations.has(trigger.uri)) {
			this.validationSuperseded += 1;
		} else if (this.pendingValidations.size >= Math.max(1, this.maxPendingValidations)) {
			const oldestUri = this.pendingValidations.keys().next().value;
			if (typeof oldestUri === 'string') {
				this.pendingValidations.delete(oldestUri);
				this.validationDropped += 1;
			}
		}
		this.pendingValidations.delete(trigger.uri);
		this.pendingValidations.set(trigger.uri, {
			...trigger,
			id: ++this.nextValidationId,
			startedAtMs: this.now(),
		});
	}

	finishValidation(uri: string, counts: ValidationDiagnosticCounts): boolean {
		const request = this.pendingValidations.get(uri);
		if (!request) return false;
		this.pendingValidations.delete(uri);

		const finishedAtMs = this.now();
		const elapsedMs = Math.max(0, finishedAtMs - request.startedAtMs);
		this.validationCompleted += 1;
		this.validationTotalElapsedMs += elapsedMs;
		this.validationMaxElapsedMs = Math.max(this.validationMaxElapsedMs, elapsedMs);
		const snapshot = this.validationSnapshot();
		this.log({
			category: 'Lint',
			timestamp: this.timestamp(finishedAtMs),
			message: [
				'ClientValidationFeedback',
				`request=${request.id}`,
				`trigger=${request.trigger}`,
				`version=${request.version}`,
				`elapsedMs=${elapsedMs}`,
				`diagnostics=${counts.diagnostics}`,
				`publishedDiagnostics=${counts.publishedDiagnostics}`,
				`errors=${counts.errors}`,
				`warnings=${counts.warnings}`,
				`information=${counts.information}`,
				`hints=${counts.hints}`,
				`file=${this.singleLine(request.file, 240)}`,
				`total=${snapshot.totalTriggers}`,
				`completed=${snapshot.completedRequests}`,
				`superseded=${snapshot.supersededRequests}`,
				`dropped=${snapshot.droppedRequests}`,
				`averageMs=${snapshot.averageElapsedMs.toFixed(1)}`,
				`maxMs=${snapshot.maxElapsedMs}`,
			].join(' '),
		});
		return true;
	}

	forgetValidation(uri: string): void {
		this.pendingValidations.delete(uri);
	}

	completionSnapshot(): CompletionPerformanceSnapshot {
		const completedRequests = this.completionSucceeded + this.completionCancelled + this.completionFailed;
		return {
			totalRequests: this.completionTotal,
			completedRequests,
			succeededRequests: this.completionSucceeded,
			cancelledRequests: this.completionCancelled,
			failedRequests: this.completionFailed,
			averageElapsedMs: completedRequests === 0 ? 0 : this.completionTotalElapsedMs / completedRequests,
			maxElapsedMs: this.completionMaxElapsedMs,
		};
	}

	validationSnapshot(): ValidationPerformanceSnapshot {
		return {
			totalTriggers: this.validationTotal,
			completedRequests: this.validationCompleted,
			supersededRequests: this.validationSuperseded,
			droppedRequests: this.validationDropped,
			averageElapsedMs: this.validationCompleted === 0 ? 0 : this.validationTotalElapsedMs / this.validationCompleted,
			maxElapsedMs: this.validationMaxElapsedMs,
		};
	}

	private completionTrigger(kind: number): string {
		// vscode.CompletionTriggerKind is zero-based; the wire-level LSP enum is one-based.
		return kind === 0 ? 'invoked' : kind === 1 ? 'character' : kind === 2 ? 'incomplete' : `unknown(${kind})`;
	}

	private timestamp(timeMs: number): string {
		const date = new Date(timeMs);
		const pad = (value: number, width = 2) => String(value).padStart(width, '0');
		return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
	}

	private errorMessage(error: unknown): string {
		if (error instanceof Error) return error.message;
		if (typeof error === 'string') return error;
		return 'Unknown completion error';
	}

	private singleLine(value: string, maxLength: number): string {
		const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
		return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
	}
}
