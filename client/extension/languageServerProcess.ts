import {
	LanguageClient,
	type LanguageClientOptions,
} from 'vscode-languageclient/node';
import {
	LanguageServerProcessController,
} from './languageServerProcessController';

export {
	LanguageServerProcessController,
	type LanguageServerProcessEvent,
	type LanguageServerProcessOptions,
} from './languageServerProcessController';

export class ManagedLanguageClient extends LanguageClient {
	constructor(
		id: string,
		name: string,
		controller: LanguageServerProcessController,
		clientOptions: LanguageClientOptions,
	) {
		super(id, name, controller.createServerOptions(), clientOptions);
		this.controller = controller;
	}

	private readonly controller: LanguageServerProcessController;

	override async stop(timeout = 2_000): Promise<void> {
		const serverProcess = this.controller.captureCurrentProcess();
		let stopError: unknown;
		try {
			await super.stop(timeout);
		} catch (error) {
			stopError = error;
		} finally {
			await this.controller.terminateIfRunning(
				serverProcess,
				stopError === undefined ? 'client-stop-left-process-running' : 'client-stop-timeout-or-failure',
			);
		}
		if (stopError !== undefined) throw stopError;
	}
}
