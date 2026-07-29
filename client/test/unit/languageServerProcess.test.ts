import { expect } from 'chai';
import {
	LanguageServerProcessController,
	type LanguageServerProcessEvent,
} from '../../extension/languageServerProcessController';

describe('LanguageServerProcessController', () => {
	it('tracks one server instance and terminates its exact process tree', async function () {
		this.timeout(10_000);
		const events: LanguageServerProcessEvent[] = [];
		const controller = new LanguageServerProcessController({
			command: process.execPath,
			args: ['-e', 'setInterval(() => {}, 1000)'],
			onEvent: event => events.push(event),
		});
		const serverOptions = controller.createServerOptions();
		expect(serverOptions).to.be.a('function');
		if (typeof serverOptions !== 'function') throw new Error('Expected function server options');

		const result = await serverOptions();
		const serverProcess = result.process;
		const pid = serverProcess.pid;
		expect(pid).to.be.a('number');
		expect(controller.captureCurrentProcess()).to.equal(serverProcess);

		await controller.terminateIfRunning(serverProcess, 'unit-test');

		expect(controller.captureCurrentProcess()).to.equal(undefined);
		expect(events.some(event => event.stage === 'spawned' && event.pid === pid)).to.equal(true);
		expect(events.some(event => event.stage === 'force-kill-start' && event.pid === pid)).to.equal(true);
		expect(events.some(event => event.stage === 'force-kill-complete' && event.pid === pid)).to.equal(true);
	});
});
