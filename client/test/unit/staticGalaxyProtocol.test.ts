import { expect } from 'chai';
import {
    isStaticGalaxyAxis,
    isStaticGalaxyHyperlaneUpdate,
    isStaticGalaxyPositionUpdate,
    isStaticGalaxySystemMove,
    parseStaticGalaxyWebviewMessage,
    STATIC_GALAXY_MAX_COORDINATE,
    STATIC_GALAXY_MAX_MOVES,
} from '../../shared/staticGalaxyProtocol';

describe('staticGalaxyProtocol', () => {
    describe('isStaticGalaxyAxis', () => {
        it('accepts fixed, range and unresolved axes', () => {
            expect(isStaticGalaxyAxis({ kind: 'fixed', value: 1, center: 1 })).to.equal(true);
            expect(isStaticGalaxyAxis({ kind: 'range', min: -5, max: 5, center: 0, width: 10, reversed: false })).to.equal(true);
            expect(isStaticGalaxyAxis({ kind: 'unresolved', raw: '@[x]', reason: 'expression' })).to.equal(true);
        });

        it('rejects malformed axes', () => {
            expect(isStaticGalaxyAxis(null)).to.equal(false);
            expect(isStaticGalaxyAxis({ kind: 'fixed', value: 'x' })).to.equal(false);
            expect(isStaticGalaxyAxis({ kind: 'fixed', value: NaN, center: 0 })).to.equal(false);
            expect(isStaticGalaxyAxis({ kind: 'range', min: 1, max: 2, center: 1.5, width: 1 })).to.equal(false);
            expect(isStaticGalaxyAxis({ kind: 'other' })).to.equal(false);
        });
    });

    describe('isStaticGalaxySystemMove', () => {
        it('accepts a valid move', () => {
            expect(isStaticGalaxySystemMove({ nodeKey: 'n1', x: 10, y: -20 })).to.equal(true);
        });

        it('rejects non-finite and out-of-range coordinates', () => {
            expect(isStaticGalaxySystemMove({ nodeKey: 'n1', x: Infinity, y: 0 })).to.equal(false);
            expect(isStaticGalaxySystemMove({ nodeKey: 'n1', x: 0, y: STATIC_GALAXY_MAX_COORDINATE + 1 })).to.equal(false);
            expect(isStaticGalaxySystemMove({ nodeKey: '', x: 0, y: 0 })).to.equal(false);
            expect(isStaticGalaxySystemMove({ x: 0, y: 0 })).to.equal(false);
        });
    });

    describe('isStaticGalaxyPositionUpdate', () => {
        it('requires at least one axis', () => {
            expect(isStaticGalaxyPositionUpdate({ nodeKey: 'n1' })).to.equal(false);
            expect(isStaticGalaxyPositionUpdate({ nodeKey: 'n1', x: { kind: 'fixed', value: 3 } })).to.equal(true);
            expect(isStaticGalaxyPositionUpdate({ nodeKey: 'n1', y: { kind: 'range', min: 1, max: 2 } })).to.equal(true);
            expect(isStaticGalaxyPositionUpdate({ nodeKey: 'n1', z: { kind: 'fixed', value: 7 } })).to.equal(true);
        });
    });

    describe('isStaticGalaxyHyperlaneUpdate', () => {
        it('requires two distinct node keys and a boolean state', () => {
            expect(isStaticGalaxyHyperlaneUpdate({ fromNodeKey: 'a', toNodeKey: 'b', connected: true })).to.equal(true);
            expect(isStaticGalaxyHyperlaneUpdate({ fromNodeKey: 'a', toNodeKey: 'a', connected: true })).to.equal(false);
            expect(isStaticGalaxyHyperlaneUpdate({ fromNodeKey: 'a', toNodeKey: 'b', connected: 'yes' })).to.equal(false);
        });
    });

    describe('parseStaticGalaxyWebviewMessage', () => {
        it('accepts simple command messages', () => {
            for (const type of ['ready', 'saveDocument', 'undo', 'redo', 'requestWorkshopEdit', 'copyToWorkspace']) {
                expect(parseStaticGalaxyWebviewMessage({ type })).to.deep.equal({ type });
            }
        });

        it('rejects unknown types and non-objects', () => {
            expect(parseStaticGalaxyWebviewMessage(null)).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage('ready')).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({ type: 'exec', cmd: 'rm -rf /' })).to.equal(null);
        });

        it('validates goToSource fields', () => {
            expect(parseStaticGalaxyWebviewMessage({ type: 'goToSource', revisionId: 'r1', nodeKey: 'n1' }))
                .to.deep.equal({ type: 'goToSource', revisionId: 'r1', nodeKey: 'n1' });
            expect(parseStaticGalaxyWebviewMessage({ type: 'goToSource', revisionId: 'r1' })).to.equal(null);
        });

        it('validates moveSystems envelope and moves', () => {
            const ok = parseStaticGalaxyWebviewMessage({
                type: 'moveSystems',
                requestId: 'q1',
                revisionId: 'r1',
                documentVersion: 3,
                moves: [{ nodeKey: 'n1', x: 1, y: 2 }],
            });
            expect(ok).to.not.equal(null);

            expect(parseStaticGalaxyWebviewMessage({
                type: 'moveSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 3, moves: [],
            })).to.equal(null);

            const tooMany = Array.from({ length: STATIC_GALAXY_MAX_MOVES + 1 }, (_, i) => ({ nodeKey: `n${i}`, x: 0, y: 0 }));
            expect(parseStaticGalaxyWebviewMessage({
                type: 'moveSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 3, moves: tooMany,
            })).to.equal(null);

            expect(parseStaticGalaxyWebviewMessage({
                type: 'moveSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 1.5,
                moves: [{ nodeKey: 'n1', x: 1, y: 2 }],
            })).to.equal(null);

            expect(parseStaticGalaxyWebviewMessage({
                type: 'moveSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 3,
                moves: [{ nodeKey: 'n1', x: NaN, y: 2 }],
            })).to.equal(null);
        });

        it('validates moveNebula envelope and move', () => {
            expect(parseStaticGalaxyWebviewMessage({
                type: 'moveNebula', requestId: 'q1', revisionId: 'r1', documentVersion: 3,
                move: { nodeKey: 'neb1', x: 1, y: 2 },
            })).to.not.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'moveNebula', requestId: 'q1', revisionId: 'r1', documentVersion: 3,
                move: { nodeKey: 'neb1', x: Infinity, y: 2 },
            })).to.equal(null);
        });

        it('validates updatePosition payloads', () => {
            const ok = parseStaticGalaxyWebviewMessage({
                type: 'updatePosition',
                requestId: 'q1',
                revisionId: 'r1',
                documentVersion: 4,
                update: { nodeKey: 'n1', x: { kind: 'range', min: -10, max: -6 } },
            });
            expect(ok).to.not.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'updatePosition', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                update: { nodeKey: 'n1', x: { kind: 'range', min: 'a', max: 2 } },
            })).to.equal(null);
        });

        it('validates setHyperlane payloads', () => {
            expect(parseStaticGalaxyWebviewMessage({
                type: 'setHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                update: { fromNodeKey: 's1', toNodeKey: 's2', connected: false },
            })).to.not.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'setHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                update: { fromNodeKey: 's1', toNodeKey: 's1', connected: false },
            })).to.equal(null);
        });

        it('validates updateNebulaRadius payloads', () => {
            expect(parseStaticGalaxyWebviewMessage({
                type: 'updateNebulaRadius', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                nodeKey: 'neb1', radius: 40,
            })).to.deep.equal({
                type: 'updateNebulaRadius', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                nodeKey: 'neb1', radius: 40,
            });
            expect(parseStaticGalaxyWebviewMessage({
                type: 'updateNebulaRadius', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                nodeKey: 'neb1', radius: 42.5,
            })).to.not.equal(null);
            for (const bad of [NaN, Infinity, -0.5]) {
                expect(parseStaticGalaxyWebviewMessage({
                    type: 'updateNebulaRadius', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                    nodeKey: 'neb1', radius: bad,
                }), `radius=${bad}`).to.equal(null);
            }
            expect(parseStaticGalaxyWebviewMessage({
                type: 'updateNebulaRadius', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                nodeKey: '', radius: 40,
            })).to.equal(null);
        });

        it('validates addHyperlanes payloads', () => {
            const ok = parseStaticGalaxyWebviewMessage({
                type: 'addHyperlanes', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                links: [
                    { fromNodeKey: 's1', toNodeKey: 's2' },
                    { fromNodeKey: 's2', toNodeKey: 's3' },
                ],
            });
            expect(ok).to.not.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'addHyperlanes', requestId: 'q1', revisionId: 'r1', documentVersion: 4, links: [],
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'addHyperlanes', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                links: [{ fromNodeKey: 's1', toNodeKey: 's1' }],
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'addHyperlanes', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                links: [{ fromNodeKey: 's1' }],
            })).to.equal(null);
        });

        it('validates spraySystems payloads', () => {
            const ok = parseStaticGalaxyWebviewMessage({
                type: 'spraySystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                scenarioKey: 'sc0', systems: [{ id: '42', x: 1, y: -2 }],
            });
            expect(ok).to.not.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'spraySystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                scenarioKey: 'sc0', systems: [],
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'spraySystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                scenarioKey: 'sc0', systems: [{ id: 'x', x: 1, y: 2 }],
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'spraySystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                scenarioKey: 'sc0', systems: [{ id: '1', x: 1, y: 2 }, { id: '1', x: 3, y: 4 }],
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'spraySystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                scenarioKey: 'sc0', systems: [{ id: '1', x: Infinity, y: 2 }],
            })).to.equal(null);
        });

        it('validates eraseSystems payloads', () => {
            expect(parseStaticGalaxyWebviewMessage({
                type: 'eraseSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                nodeKeys: ['sc0.sys1', 'sc0.sys2'],
            })).to.not.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'eraseSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4, nodeKeys: [],
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'eraseSystems', requestId: 'q1', revisionId: 'r1', documentVersion: 4, nodeKeys: [''],
            })).to.equal(null);
        });

        it('validates deleteHyperlane payloads', () => {
            expect(parseStaticGalaxyWebviewMessage({
                type: 'deleteHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                fromNodeKey: 's1', toNodeKey: 's2',
            })).to.deep.equal({
                type: 'deleteHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                fromNodeKey: 's1', toNodeKey: 's2',
            });
            expect(parseStaticGalaxyWebviewMessage({
                type: 'deleteHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                fromNodeKey: 's1', toNodeKey: 's1',
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'deleteHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 4,
                fromNodeKey: 's1',
            })).to.equal(null);
            expect(parseStaticGalaxyWebviewMessage({
                type: 'deleteHyperlane', requestId: 'q1', revisionId: 'r1', documentVersion: 1.5,
                fromNodeKey: 's1', toNodeKey: 's2',
            })).to.equal(null);
        });
    });
});
