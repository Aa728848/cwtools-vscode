import type { Disposable, Webview } from 'vscode';
import type { HostMessage } from './types';

type AgentSurface = 'chat' | 'manager';

/**
 * Tracks active chat webview surfaces and broadcasts host messages to all of them.
 */
export class AgentUiBroadcaster {
    private readonly targets = new Map<Webview, AgentSurface | undefined>();

    register(webview: Webview, surface?: AgentSurface): Disposable {
        this.targets.set(webview, surface);
        return {
            dispose: () => {
                this.targets.delete(webview);
            },
        };
    }

    postMessage(msg: HostMessage, transform?: (webview: Webview, message: HostMessage) => HostMessage): void {
        for (const target of this.targets.keys()) {
            target.postMessage(transform ? transform(target, msg) : msg);
        }
    }

    postMessageToSurface(
        surface: AgentSurface,
        msg: HostMessage,
        transform?: (webview: Webview, message: HostMessage) => HostMessage,
    ): void {
        for (const [target, targetSurface] of this.targets) {
            if (targetSurface === surface) {
                target.postMessage(transform ? transform(target, msg) : msg);
            }
        }
    }
}
