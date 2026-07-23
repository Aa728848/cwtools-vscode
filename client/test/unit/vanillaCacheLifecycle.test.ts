import { expect } from 'chai';
import {
    handleVanillaCacheGenerated,
    parseVanillaCacheGeneratedParams,
    type VanillaCacheGeneratedDependencies,
} from '../../extension/vanillaCacheLifecycle';

describe('vanilla cache generation lifecycle', () => {
    it('accepts only registered game profiles', () => {
        expect(parseVanillaCacheGeneratedParams({
            gameId: ' Stellaris ',
            message: ' Cache updated ',
        })).to.deep.equal({ gameId: 'stellaris', message: 'Cache updated' });
        expect(parseVanillaCacheGeneratedParams({ gameId: 'unknown', message: 'Cache updated' })).to.equal(undefined);
        expect(parseVanillaCacheGeneratedParams({ gameId: 'stellaris' })).to.equal(undefined);
        expect(parseVanillaCacheGeneratedParams('stellaris')).to.equal(undefined);
    });

    it('rebuilds the matching vanilla symbol database before reloading', async () => {
        const events: string[] = [];
        const dependencies: VanillaCacheGeneratedDependencies = {
            refreshVanillaSymbols: async gameIds => { events.push(`refresh:${gameIds.join(',')}`); },
            showInformationMessage: message => { events.push(`message:${message}`); },
            reloadWindow: () => { events.push('reload'); },
            debug: message => { events.push(`debug:${message}`); },
            warn: message => { events.push(`warn:${message}`); },
        };

        const result = await handleVanillaCacheGenerated({
            gameId: 'stellaris',
            message: 'Cache updated',
        }, dependencies);

        expect(result).to.equal('refreshed');
        expect(events).to.deep.equal([
            'refresh:stellaris',
            'debug:Rebuilt vanilla symbol cache for stellaris',
            'message:Cache updated',
            'reload',
        ]);
    });

    it('reports a failed rebuild but still honors the required reload', async () => {
        const events: string[] = [];
        const failure = new Error('disk full');
        const dependencies: VanillaCacheGeneratedDependencies = {
            refreshVanillaSymbols: async () => { events.push('refresh'); throw failure; },
            showInformationMessage: message => { events.push(`message:${message}`); },
            reloadWindow: () => { events.push('reload'); },
            debug: message => { events.push(`debug:${message}`); },
            warn: (message, error) => { events.push(`warn:${message}:${error === failure}`); },
        };

        const result = await handleVanillaCacheGenerated({
            gameId: 'hoi4',
            message: 'Cache updated',
        }, dependencies);

        expect(result).to.equal('refresh-failed');
        expect(events).to.deep.equal([
            'refresh',
            'warn:Failed to rebuild vanilla symbol cache for hoi4:true',
            'message:Cache updated',
            'reload',
        ]);
    });

    it('does not refresh or reload for an invalid notification', async () => {
        const events: string[] = [];
        const dependencies: VanillaCacheGeneratedDependencies = {
            refreshVanillaSymbols: async () => { events.push('refresh'); },
            showInformationMessage: () => { events.push('message'); },
            reloadWindow: () => { events.push('reload'); },
            debug: message => { events.push(`debug:${message}`); },
            warn: message => { events.push(`warn:${message}`); },
        };

        const result = await handleVanillaCacheGenerated({ gameId: '../stellaris', message: 'Cache updated' }, dependencies);

        expect(result).to.equal('invalid');
        expect(events).to.deep.equal(['warn:Ignored invalid vanillaCacheGenerated notification payload']);
    });
});
