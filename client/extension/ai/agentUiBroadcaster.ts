import type { Disposable, Webview } from 'vscode';
import type { HostMessage } from './types';

/**
 * Tracks active chat webview surfaces and broadcasts host messages to all of them.
 */
export class AgentUiBroadcaster {
    private readonly targets = new Set<Webview>();

    register(webview: Webview): Disposable {
        this.targets.add(webview);
        return {
            dispose: () => {
                this.targets.delete(webview);
            },
        };
    }

    postMessage(msg: HostMessage): void {
        for (const target of this.targets) {
            target.postMessage(msg);
        }
    }
}
