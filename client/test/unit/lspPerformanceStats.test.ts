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

		expect(stats.recordValidationPublication('file:///events/test.txt', {
			diagnostics: 5,
			publishedDiagnostics: 3,
			errors: 1,
			warnings: 2,
			information: 1,
			hints: 1,
		})).to.equal(true);
		expect(stats.finishValidation('file:///events/test.txt', 5, 'shallow-complete')).to.equal(true);
		expect(stats.validationSnapshot()).to.deep.equal({
			totalTriggers: 2,
			completedRequests: 1,
			supersededRequests: 1,
			droppedRequests: 0,
			averageElapsedMs: 80,
			maxElapsedMs: 80,
		});
		expect(entries[0]?.message).to.include('ClientValidationFeedback request=2 trigger=change version=5 phase=shallow-complete elapsedMs=80');
		expect(entries[0]?.message).to.include('diagnostics=5 publishedDiagnostics=3 errors=1 warnings=2 information=1 hints=1');
		expect(stats.finishValidation('file:///events/test.txt', 5, 'deep-complete')).to.equal(false);
	});

	it('does not treat diagnostics-cleared publication or a stale validation phase as completion', () => {
		let now = 2_500;
		const entries: LspPerformanceLogEntry[] = [];
		const stats = new LspPerformanceStats(entry => entries.push(entry), () => now);
		const uri = 'file:///events/test.txt';
		stats.recordValidationTrigger({ uri, file: 'events/test.txt', version: 7, trigger: 'change' });
		now += 5;
		expect(stats.recordValidationPublication(uri, {
			diagnostics: 0, publishedDiagnostics: 0, errors: 0, warnings: 0, information: 0, hints: 0,
		})).to.equal(true);
		expect(stats.validationSnapshot().completedRequests).to.equal(0);
		expect(entries).to.be.empty;
		expect(stats.finishValidation(uri, 6, 'shallow-complete')).to.equal(false);

		now += 75;
		expect(stats.recordValidationPublication(uri, {
			diagnostics: 2, publishedDiagnostics: 2, errors: 1, warnings: 1, information: 0, hints: 0,
		})).to.equal(true);
		expect(stats.finishValidation(uri, 7, 'deep-complete')).to.equal(true);
		expect(entries[0]?.message).to.include('phase=deep-complete elapsedMs=80 diagnostics=2');
	});

	it('bounds pending validation state and forgets closed documents', () => {
		const entries: LspPerformanceLogEntry[] = [];
		const stats = new LspPerformanceStats(entry => entries.push(entry), () => 3_000, 2);
		stats.recordValidationTrigger({ uri: 'file:///a.txt', file: 'a.txt', version: 1, trigger: 'open' });
		stats.recordValidationTrigger({ uri: 'file:///b.txt', file: 'b.txt', version: 1, trigger: 'open' });
		stats.recordValidationTrigger({ uri: 'file:///c.txt', file: 'c.txt', version: 1, trigger: 'open' });
		stats.forgetValidation('file:///b.txt');

		expect(stats.validationSnapshot()).to.include({ totalTriggers: 3, droppedRequests: 1 });
		expect(stats.finishValidation('file:///a.txt', 1, 'deep-complete')).to.equal(false);
		expect(stats.finishValidation('file:///b.txt', 1, 'deep-complete')).to.equal(false);
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
