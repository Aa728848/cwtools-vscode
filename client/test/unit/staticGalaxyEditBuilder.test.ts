import { expect } from 'chai';
import { buildStaticGalaxyEdits, StaticGalaxyEditError, StaticGalaxyEditRequest, StaticGalaxyReplacement } from '../../extension/staticGalaxyEditBuilder';
import { parseStaticGalaxy, ParsedScenario } from '../../extension/staticGalaxyParser';

function contextFor(text: string): { text: string; scenarios: ParsedScenario[] } {
    const result = parseStaticGalaxy(text);
    expect(result.ok, result.error).to.equal(true);
    return { text, scenarios: result.scenarios };
}

/** Applies back-to-front replacements to the source text. */
function applyReplacements(text: string, replacements: StaticGalaxyReplacement[]): string {
    let out = text;
    for (const rep of replacements) {
        out = out.slice(0, rep.span.start) + rep.text + out.slice(rep.span.end);
    }
    return out;
}

function build(request: StaticGalaxyEditRequest, text: string) {
    return buildStaticGalaxyEdits(request, contextFor(text));
}

describe('staticGalaxyEditBuilder', () => {
    it('moves a fixed coordinate by replacing exactly the number token', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 name = "A" position = { x = 20 y = -30 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({ kind: 'move', moves: [{ nodeKey, x: 27, y: -30 }] }, text);

        expect(built.replacements).to.have.lengthOf(1);
        expect(text.slice(built.replacements[0]!.span.start, built.replacements[0]!.span.end)).to.equal('20');
        expect(built.replacements[0]!.text).to.equal('27');
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('position = { x = 27 y = -30 }');
        // Everything except the target digits is byte-identical.
        expect(next.length).to.equal(text.length);
    });

    it('translates a range axis as a whole, preserving width and order', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = { min = -97 max = -93 } y = 5 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        // Move center from -95 to -85: delta +10 on both endpoints.
        const built = build({ kind: 'move', moves: [{ nodeKey, x: -85, y: 5 }] }, text);

        expect(built.replacements).to.have.lengthOf(2);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('x = { min = -87 max = -83 }');
        expect(next).to.include('y = 5');
    });

    it('moves x and y in one deterministic transaction', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 1 y = 2 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({ kind: 'move', moves: [{ nodeKey, x: 10, y: 20 }] }, text);

        expect(built.replacements).to.have.lengthOf(2);
        // Back-to-front order by start offset.
        expect(built.replacements[0]!.span.start).to.be.greaterThan(built.replacements[1]!.span.start);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('position = { x = 10 y = 20 }');
    });

    it('preserves whitespace, comments, field order and CRLF around the edit', () => {
        const text = 'static_galaxy_scenario = {\r\n' +
            '    # keep this comment\r\n' +
            '    system = {\r\n' +
            '        id = 1\r\n' +
            '        position = {   x = 5    y = 6 }\r\n' +
            '    }\r\n' +
            '}\r\n';
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({ kind: 'move', moves: [{ nodeKey, x: 9, y: 6 }] }, text);
        const next = applyReplacements(text, built.replacements);

        expect(next).to.equal(text.replace('x = 5', 'x = 9'));
        expect(next).to.include('\r\n');
        expect(next).to.include('# keep this comment');
    });

    it('inverts coordinate_transform before writing back', () => {
        const text = `static_galaxy_scenario = {
    coordinate_transform = { x = { add = 100 mul = 2 } }
    system = { id = 1 position = { x = 10 y = 3 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const sys = scenarios[0]!.systems[0]!;
        // Effective x = raw * 2 + 200. Drag to effective 220 -> raw 10... use 240 -> raw 20.
        const built = build({ kind: 'move', moves: [{ nodeKey: sys.nodeKey, x: 240, y: 3 }] }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('position = { x = 20 y = 3 }');
    });

    it('never swaps a reversed range while dragging', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = { min = 30 max = 10 } y = 0 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        // Center is 20; drag to center 25 -> both endpoints +5, order kept.
        const built = build({ kind: 'move', moves: [{ nodeKey, x: 25, y: 0 }] }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('x = { min = 35 max = 15 }');
    });

    it('lets the inspector fix a reversed range explicitly', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = { min = 30 max = 10 } y = 0 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({ kind: 'update', update: { nodeKey, x: { kind: 'range', min: 10, max: 30 } } }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('x = { min = 10 max = 30 }');
    });

    it('rejects edits against stale spans (token mismatch)', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 5 y = 5 } }
}
`;
        const ctx = contextFor(text);
        const nodeKey = ctx.scenarios[0]!.systems[0]!.nodeKey;
        // Simulate an external edit: the span now covers different text.
        const mutated = text.replace('x = 5', 'x = 9999');
        expect(() => buildStaticGalaxyEdits(
            { kind: 'move', moves: [{ nodeKey, x: 10, y: 5 }] },
            { text: mutated, scenarios: ctx.scenarios },
        )).to.throw(StaticGalaxyEditError).with.property('code', 'token-mismatch');
    });

    it('rejects unknown nodeKeys', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 5 y = 5 } }
}
`;
        expect(() => build({ kind: 'move', moves: [{ nodeKey: 'sc0.sys99', x: 1, y: 1 }] }, text))
            .to.throw(StaticGalaxyEditError).with.property('code', 'unknown-node');
    });

    it('rejects NaN/Infinity and absurd coordinates', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 5 y = 5 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        for (const bad of [NaN, Infinity, -Infinity, 2_000_000]) {
            expect(() => build({ kind: 'move', moves: [{ nodeKey, x: bad, y: 0 }] }, text), `x=${bad}`)
                .to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');
        }
    });

    it('rejects editing non-editable nodes (non-invertible transform)', () => {
        const text = `static_galaxy_scenario = {
    coordinate_transform = { x = { mul = 0 } }
    system = { id = 1 position = { x = 5 y = 5 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        expect(() => build({ kind: 'move', moves: [{ nodeKey, x: 10, y: 5 }] }, text))
            .to.throw(StaticGalaxyEditError).with.property('code', 'not-editable');
    });

    it('rejects unresolved expression axes', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = @[v * 2] y = 5 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        expect(() => build({ kind: 'move', moves: [{ nodeKey, x: 10, y: 5 }] }, text))
            .to.throw(StaticGalaxyEditError).with.property('code', 'not-editable');
    });

    it('inspector update replaces only the min token when max is unchanged', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = { min = -97 max = -93 } y = 0 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({ kind: 'update', update: { nodeKey, x: { kind: 'range', min: -90, max: -93 } } }, text);
        expect(built.replacements).to.have.lengthOf(1);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('x = { min = -90 max = -93 }');
    });

    it('rejects fixed updates on range axes and vice versa', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = { min = 1 max = 2 } y = 3 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        expect(() => build({ kind: 'update', update: { nodeKey, x: { kind: 'fixed', value: 5 } } }, text))
            .to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');
        expect(() => build({ kind: 'update', update: { nodeKey, y: { kind: 'range', min: 1, max: 2 } } }, text))
            .to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');
    });

    it('returns a no-op when the drag ends where it started', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 5 y = 5 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({ kind: 'move', moves: [{ nodeKey, x: 5, y: 5 }] }, text);
        expect(built.replacements).to.have.lengthOf(0);
    });

    it('accepts an unchanged inspector update as a no-op', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 5 y = { min = 10 max = 14 } } }
}
`;
        const scenarios = contextFor(text).scenarios;
        const nodeKey = scenarios[0]!.systems[0]!.nodeKey;
        const built = build({
            kind: 'update',
            update: {
                nodeKey,
                x: { kind: 'fixed', value: 5 },
                y: { kind: 'range', min: 10, max: 14 },
            },
        }, text);
        expect(built.replacements).to.have.lengthOf(0);
    });

    it('moves a nebula and inverts the active coordinate transform', () => {
        const text = `static_galaxy_scenario = {
    coordinate_transform = { x = { add = 10 } y = { mul = 2 } }
    nebula = { name = "Cloud" position = { x = 5 y = { min = 2 max = 6 } z = 9 } radius = 20 }
}
`;
        const nebula = contextFor(text).scenarios[0]!.nebulas[0]!;
        const built = build({ kind: 'move', moves: [{ nodeKey: nebula.nodeKey, x: 25, y: 20 }] }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('position = { x = 15 y = { min = 8 max = 12 } z = 9 }');
    });

    it('updates fixed and range z coordinates from the inspector', () => {
        const fixedText = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 z = 4 } }
}
`;
        const fixedNode = contextFor(fixedText).scenarios[0]!.systems[0]!;
        const fixed = build({
            kind: 'update',
            update: { nodeKey: fixedNode.nodeKey, z: { kind: 'fixed', value: 12 } },
        }, fixedText);
        expect(applyReplacements(fixedText, fixed.replacements)).to.include('z = 12');

        const rangeText = `static_galaxy_scenario = {
    nebula = { position = { x = 0 y = 0 z = { min = -2 max = 2 } } radius = 1 }
}
`;
        const rangeNode = contextFor(rangeText).scenarios[0]!.nebulas[0]!;
        const range = build({
            kind: 'update',
            update: { nodeKey: rangeNode.nodeKey, z: { kind: 'range', min: -5, max: 5 } },
        }, rangeText);
        expect(applyReplacements(rangeText, range.replacements)).to.include('z = { min = -5 max = 5 }');
    });

    it('inserts a missing z coordinate without rewriting the position block', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 5 y = 6 } }
}
`;
        const node = contextFor(text).scenarios[0]!.systems[0]!;
        const built = build({
            kind: 'update',
            update: { nodeKey: node.nodeKey, z: { kind: 'fixed', value: 7 } },
        }, text);
        expect(built.replacements).to.have.lengthOf(1);
        expect(applyReplacements(text, built.replacements)).to.equal(text.replace('y = 6 }', 'y = 6 z = 7 }'));
    });

    it('adds an explicit hyperlane before the scenario closing brace using the source EOL', () => {
        const text = 'static_galaxy_scenario = {\r\n' +
            '    system = { id = 1 position = { x = 0 y = 0 } }\r\n' +
            '    system = { id = 2 position = { x = 10 y = 0 } }\r\n' +
            '}\r\n';
        const systems = contextFor(text).scenarios[0]!.systems;
        const built = build({
            kind: 'hyperlane',
            update: { fromNodeKey: systems[0]!.nodeKey, toNodeKey: systems[1]!.nodeKey, connected: true },
        }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('    add_hyperlane = { from = 1 to = 2 }\r\n}\r\n');
        expect(next.replace(/\r\n/g, '')).to.not.include('\n');
    });

    it('disconnects and reconnects an existing lane by changing only its declaration key', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    add_hyperlane = { from = 2 to = 1 } # keep
}
`;
        const systems = contextFor(text).scenarios[0]!.systems;
        const disconnect = build({
            kind: 'hyperlane',
            update: { fromNodeKey: systems[0]!.nodeKey, toNodeKey: systems[1]!.nodeKey, connected: false },
        }, text);
        const disconnected = applyReplacements(text, disconnect.replacements);
        expect(disconnected).to.equal(text.replace('add_hyperlane', 'remove_hyperlane'));

        const reparsedSystems = contextFor(disconnected).scenarios[0]!.systems;
        const reconnect = build({
            kind: 'hyperlane',
            update: { fromNodeKey: reparsedSystems[0]!.nodeKey, toNodeKey: reparsedSystems[1]!.nodeKey, connected: true },
        }, disconnected);
        expect(applyReplacements(disconnected, reconnect.replacements)).to.equal(text);
    });

    it('rejects hyperlanes across scenarios and endpoints with duplicate ids', () => {
        const crossScenarioText = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
}
static_galaxy_scenario = {
    system = { id = 2 position = { x = 1 y = 1 } }
}
`;
        const crossScenarios = contextFor(crossScenarioText).scenarios;
        expect(() => build({
            kind: 'hyperlane',
            update: {
                fromNodeKey: crossScenarios[0]!.systems[0]!.nodeKey,
                toNodeKey: crossScenarios[1]!.systems[0]!.nodeKey,
                connected: true,
            },
        }, crossScenarioText)).to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');

        const duplicateText = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 1 position = { x = 1 y = 1 } }
    system = { id = 2 position = { x = 2 y = 2 } }
}
`;
        const duplicateSystems = contextFor(duplicateText).scenarios[0]!.systems;
        expect(() => build({
            kind: 'hyperlane',
            update: {
                fromNodeKey: duplicateSystems[0]!.nodeKey,
                toNodeKey: duplicateSystems[2]!.nodeKey,
                connected: true,
            },
        }, duplicateText)).to.throw(StaticGalaxyEditError).with.property('code', 'not-editable');
    });

    it('deletes an add_hyperlane declaration by removing its whole line', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    add_hyperlane = { from = 1 to = 2 }
    add_hyperlane = { from = 2 to = 1 }
}
`;
        const systems = contextFor(text).scenarios[0]!.systems;
        const built = build({
            kind: 'deleteLane',
            fromNodeKey: systems[0]!.nodeKey,
            toNodeKey: systems[1]!.nodeKey,
        }, text);
        // Both duplicate declarations (reversed duplicate) are removed.
        expect(built.replacements).to.have.lengthOf(2);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.not.include('add_hyperlane');
        expect(next).to.include('system = { id = 1 position = { x = 0 y = 0 } }');
        expect(next).to.include('system = { id = 2 position = { x = 10 y = 0 } }');
    });

    it('keeps trailing comments when deleting an inline lane declaration', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    add_hyperlane = { from = 1 to = 2 } # keep this note
}
`;
        const systems = contextFor(text).scenarios[0]!.systems;
        const built = build({
            kind: 'deleteLane',
            fromNodeKey: systems[0]!.nodeKey,
            toNodeKey: systems[1]!.nodeKey,
        }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.not.include('add_hyperlane');
        expect(next).to.include('# keep this note');
    });

    it('deletes lanes without touching CRLF structure', () => {
        const text = 'static_galaxy_scenario = {\r\n' +
            '    system = { id = 1 position = { x = 0 y = 0 } }\r\n' +
            '    system = { id = 2 position = { x = 10 y = 0 } }\r\n' +
            '    add_hyperlane = { from = 1 to = 2 }\r\n' +
            '}\r\n';
        const systems = contextFor(text).scenarios[0]!.systems;
        const built = build({
            kind: 'deleteLane',
            fromNodeKey: systems[0]!.nodeKey,
            toNodeKey: systems[1]!.nodeKey,
        }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.not.include('add_hyperlane');
        expect(next).to.equal('static_galaxy_scenario = {\r\n' +
            '    system = { id = 1 position = { x = 0 y = 0 } }\r\n' +
            '    system = { id = 2 position = { x = 10 y = 0 } }\r\n' +
            '}\r\n');
    });

    it('rejects deleting a lane that only exists as remove_hyperlane', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    remove_hyperlane = { from = 1 to = 2 }
}
`;
        const systems = contextFor(text).scenarios[0]!.systems;
        expect(() => build({
            kind: 'deleteLane',
            fromNodeKey: systems[0]!.nodeKey,
            toNodeKey: systems[1]!.nodeKey,
        }, text)).to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');
    });

    it('rejects deleting a lane with a stale declaration span', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    add_hyperlane = { from = 1 to = 2 }
}
`;
        const ctx = contextFor(text);
        const systems = ctx.scenarios[0]!.systems;
        const mutated = text.replace('from = 1', 'from = 9');
        expect(() => buildStaticGalaxyEdits({
            kind: 'deleteLane',
            fromNodeKey: systems[0]!.nodeKey,
            toNodeKey: systems[1]!.nodeKey,
        }, { text: mutated, scenarios: ctx.scenarios })).to.throw(StaticGalaxyEditError).with.property('code', 'token-mismatch');
    });

    it('replaces only the radius token for a nebula', () => {
        const text = `static_galaxy_scenario = {
    nebula = { name = "N" position = { x = 100 y = 100 } radius = 40 }
}
`;
        const nebula = contextFor(text).scenarios[0]!.nebulas[0]!;
        const built = build({ kind: 'nebulaRadius', nodeKey: nebula.nodeKey, radius: 55 }, text);
        expect(built.replacements).to.have.lengthOf(1);
        expect(text.slice(built.replacements[0]!.span.start, built.replacements[0]!.span.end)).to.equal('40');
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('radius = 55');
        expect(next.length).to.equal(text.length);
    });

    it('keeps radius as a float without rounding', () => {
        const text = `static_galaxy_scenario = {
    nebula = { name = "N" position = { x = 100 y = 100 } radius = 40 }
}
`;
        const nebula = contextFor(text).scenarios[0]!.nebulas[0]!;
        const built = build({ kind: 'nebulaRadius', nodeKey: nebula.nodeKey, radius: 42.5 }, text);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('radius = 42.5');
    });

    it('inserts a missing radius into single-line and multi-line nebula blocks', () => {
        const single = `static_galaxy_scenario = {
    nebula = { name = "N" position = { x = 1 y = 2 } }
}
`;
        const neb1 = contextFor(single).scenarios[0]!.nebulas[0]!;
        const built1 = build({ kind: 'nebulaRadius', nodeKey: neb1.nodeKey, radius: 30 }, single);
        expect(applyReplacements(single, built1.replacements)).to.include('position = { x = 1 y = 2 } radius = 30 }');

        const multi = 'static_galaxy_scenario = {\r\n' +
            '    nebula = {\r\n' +
            '        name = "N"\r\n' +
            '        position = { x = 1 y = 2 }\r\n' +
            '    }\r\n' +
            '}\r\n';
        const neb2 = contextFor(multi).scenarios[0]!.nebulas[0]!;
        const built2 = build({ kind: 'nebulaRadius', nodeKey: neb2.nodeKey, radius: 30 }, multi);
        const next2 = applyReplacements(multi, built2.replacements);
        expect(next2).to.include('radius = 30\r\n    }');
    });

    it('rejects invalid radius values and non-literal radius keys', () => {
        const text = `static_galaxy_scenario = {
    nebula = { name = "N" position = { x = 1 y = 2 } radius = 40 }
}
`;
        const nebula = contextFor(text).scenarios[0]!.nebulas[0]!;
        for (const bad of [NaN, Infinity, -1]) {
            expect(() => build({ kind: 'nebulaRadius', nodeKey: nebula.nodeKey, radius: bad }, text), `radius=${bad}`)
                .to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');
        }

        const varText = `@size = 40
static_galaxy_scenario = {
    nebula = { name = "N" position = { x = 1 y = 2 } radius = @size }
}
`;
        const varNebula = contextFor(varText).scenarios[0]!.nebulas[0]!;
        expect(varNebula.radiusWritable).to.equal(false);
        expect(() => build({ kind: 'nebulaRadius', nodeKey: varNebula.nodeKey, radius: 10 }, varText))
            .to.throw(StaticGalaxyEditError).with.property('code', 'not-editable');
    });

    it('rejects nebula radius edits against stale spans', () => {
        const text = `static_galaxy_scenario = {
    nebula = { name = "N" position = { x = 1 y = 2 } radius = 40 }
}
`;
        const ctx = contextFor(text);
        const nebula = ctx.scenarios[0]!.nebulas[0]!;
        const mutated = text.replace('radius = 40', 'radius = 99');
        expect(() => buildStaticGalaxyEdits(
            { kind: 'nebulaRadius', nodeKey: nebula.nodeKey, radius: 10 },
            { text: mutated, scenarios: ctx.scenarios },
        )).to.throw(StaticGalaxyEditError).with.property('code', 'token-mismatch');
    });

    it('adds a chained lane drawing as one anchored insertion', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    system = { id = 3 position = { x = 20 y = 0 } }
}
`;
        const systems = contextFor(text).scenarios[0]!.systems;
        const built = build({
            kind: 'addLanes',
            links: [
                { fromNodeKey: systems[0]!.nodeKey, toNodeKey: systems[1]!.nodeKey },
                { fromNodeKey: systems[1]!.nodeKey, toNodeKey: systems[2]!.nodeKey },
            ],
        }, text);
        // Both declarations merge into a single anchored insertion.
        expect(built.replacements).to.have.lengthOf(1);
        const next = applyReplacements(text, built.replacements);
        expect(next).to.include('add_hyperlane = { from = 1 to = 2 }');
        expect(next).to.include('add_hyperlane = { from = 2 to = 3 }');
        // Existing content and order are untouched.
        expect(next.indexOf('system = { id = 1')).to.be.lessThan(next.indexOf('add_hyperlane'));
    });

    it('renames conflicting declarations and dedupes repeated pairs when chaining', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 0 } }
    system = { id = 3 position = { x = 20 y = 0 } }
    remove_hyperlane = { from = 1 to = 2 }
}
`;
        const systems = contextFor(text).scenarios[0]!.systems;
        const built = build({
            kind: 'addLanes',
            links: [
                { fromNodeKey: systems[0]!.nodeKey, toNodeKey: systems[1]!.nodeKey },
                { fromNodeKey: systems[1]!.nodeKey, toNodeKey: systems[0]!.nodeKey },
                { fromNodeKey: systems[1]!.nodeKey, toNodeKey: systems[2]!.nodeKey },
            ],
        }, text);
        const next = applyReplacements(text, built.replacements);
        // remove_hyperlane renamed in place; only one new declaration for 2↔3.
        expect(next).to.not.include('remove_hyperlane');
        expect(next.match(/add_hyperlane/g)).to.have.lengthOf(2);
        expect(next).to.include('add_hyperlane = { from = 2 to = 3 }');
    });

    it('rejects chained lanes across scenarios or onto the same system', () => {
        const text = `static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
}
static_galaxy_scenario = {
    system = { id = 2 position = { x = 10 y = 0 } }
}
`;
        const scenarios = contextFor(text).scenarios;
        expect(() => build({
            kind: 'addLanes',
            links: [{ fromNodeKey: scenarios[0]!.systems[0]!.nodeKey, toNodeKey: scenarios[1]!.systems[0]!.nodeKey }],
        }, text)).to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');

        expect(() => build({
            kind: 'addLanes',
            links: [],
        }, text)).to.throw(StaticGalaxyEditError).with.property('code', 'invalid-value');
    });
});
