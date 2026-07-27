import { expect } from 'chai';
import { LspPerformanceStats, type LspPerformanceLogEntry } from '../../extension/lspPerformanceStats';

describe('LspPerformanceStats', () => {
	it('writes completion latency and aggregates to the MemDiag-compatible sink', () => {
		let now = 1_000;
		const entries: LspPerformanceLogEntry[] = [];
		const stats = new LspPerformanceStats(entry => entries.push(entry), () => now);
		const first = stats.beginCompletion({ file: 'events/test.txt', line: 2, character: 4, triggerKind: 1, triggerCharacter: ':' });
		now += 25;
		stats.finishCompletion(first, { status: 'success', itemCount: 12 });
		const second = stats.beginCompletion({ file: 'events/test.txt', line: 3, character: 6, triggerKind: 0 });
		now += 15;
		stats.finishCompletion(second, { status: 'success', itemCount: 4 });

		expect(stats.completionSnapshot()).to.deep.equal({
			totalRequests: 2,
			completedRequests: 2,
			succeededRequests: 2,
			cancelledRequests: 0,
			failedRequests: 0,
			averageElapsedMs: 20,
			maxElapsedMs: 25,
		});
		expect(entries[0]).to.include({ category: 'Completion' });
		expect(entries[0]?.message).to.include('ClientCompletion request=1 status=success elapsedMs=25 items=12 trigger=character triggerChar=":"');
		expect(entries[1]?.message).to.include('trigger=invoked');
		expect(entries[1]?.message).to.include('total=2 completed=2 succeeded=2 cancelled=0 failed=0 averageMs=20.0 maxMs=25');
	});

	it('measures latest-edit-to-diagnostics latency and counts superseded validation triggers', () => {
		let now = 2_000;
		const entries: LspPerformanceLogEntry[] = [];
		const stats = new LspPerformanceStats(entry => entries.push(entry), () => now);
		stats.recordValidationTrigger({ uri: 'file:///events/test.txt', file: 'events/test.txt', version: 4, trigger: 'change' });
		now += 20;
		stats.recordValidationTrigger({ uri: 'file:///events/test.txt', file: 'events/test.txt', version: 5, trigger: 'change' });
		now += 80;

		expect(stats.finishValidation('file:///events/test.txt', {
			diagnostics: 5,
			publishedDiagnostics: 3,
			errors: 1,
			warnings: 2,
			information: 1,
			hints: 1,
		})).to.equal(true);
		expect(stats.validationSnapshot()).to.deep.equal({
			totalTriggers: 2,
			completedRequests: 1,
			supersededRequests: 1,
			droppedRequests: 0,
			averageElapsedMs: 80,
			maxElapsedMs: 80,
		});
		expect(entries[0]?.message).to.include('ClientValidationFeedback request=2 trigger=change version=5 elapsedMs=80');
		expect(entries[0]?.message).to.include('diagnostics=5 publishedDiagnostics=3 errors=1 warnings=2 information=1 hints=1');
		expect(stats.finishValidation('file:///events/test.txt', {
			diagnostics: 0, publishedDiagnostics: 0, errors: 0, warnings: 0, information: 0, hints: 0,
		})).to.equal(false);
	});

	it('bounds pending validation state and forgets closed documents', () => {
		const entries: LspPerformanceLogEntry[] = [];
		const stats = new LspPerformanceStats(entry => entries.push(entry), () => 3_000, 2);
		stats.recordValidationTrigger({ uri: 'file:///a.txt', file: 'a.txt', version: 1, trigger: 'open' });
		stats.recordValidationTrigger({ uri: 'file:///b.txt', file: 'b.txt', version: 1, trigger: 'open' });
		stats.recordValidationTrigger({ uri: 'file:///c.txt', file: 'c.txt', version: 1, trigger: 'open' });
		stats.forgetValidation('file:///b.txt');

		expect(stats.validationSnapshot()).to.include({ totalTriggers: 3, droppedRequests: 1 });
		expect(stats.finishValidation('file:///a.txt', {
			diagnostics: 0, publishedDiagnostics: 0, errors: 0, warnings: 0, information: 0, hints: 0,
		})).to.equal(false);
		expect(stats.finishValidation('file:///b.txt', {
			diagnostics: 0, publishedDiagnostics: 0, errors: 0, warnings: 0, information: 0, hints: 0,
		})).to.equal(false);
	});

	it('sanitizes completion errors before adding them to MemDiag', () => {
		let now = 4_000;
		const entries: LspPerformanceLogEntry[] = [];
		const stats = new LspPerformanceStats(entry => entries.push(entry), () => now);
		const request = stats.beginCompletion({ file: 'common/a.txt', line: 0, character: 0, triggerKind: 99 });
		now += 7;
		stats.finishCompletion(request, { status: 'error', error: new Error('bad\nresponse') });

		expect(entries[0]?.message).to.include('error=bad response');
		expect(entries[0]?.message).not.to.include('bad\nresponse');
	});
});
