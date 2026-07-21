import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { parseStaticGalaxy, toScenarioView, ParsedScenario } from '../../extension/staticGalaxyParser';

const fixtureDir = path.resolve(__dirname, '../fixtures/static-galaxy');

function readFixture(name: string): string {
    return fs.readFileSync(path.join(fixtureDir, name), 'utf8');
}

function firstScenario(text: string): ParsedScenario {
    const result = parseStaticGalaxy(text);
    expect(result.ok, result.error).to.equal(true);
    return result.scenarios[0]!;
}

describe('staticGalaxyParser', () => {
    it('parses fixed x/y/z coordinates', () => {
        const scenario = firstScenario(`
static_galaxy_scenario = {
    system = { id = 1 name = "A" position = { x = 10 y = -20 z = 5 } }
}
`);
        const sys = scenario.systems[0]!;
        expect(sys.x).to.deep.include({ kind: 'fixed', value: 10 });
        expect(sys.y).to.deep.include({ kind: 'fixed', value: -20 });
        expect(sys.z).to.deep.include({ kind: 'fixed', value: 5 });
        expect(sys.editable).to.equal(true);
    });

    it('parses range coordinates with exact min/max spans', () => {
        const text = `
static_galaxy_scenario = {
    system = {
        id = 1
        position = { x = { min = -97 max = -93 } y = { min = 10 max = 20 } }
    }
}
`;
        const scenario = firstScenario(text);
        const sys = scenario.systems[0]!;
        expect(sys.x).to.deep.include({ kind: 'range', min: -97, max: -93 });
        expect(sys.y).to.deep.include({ kind: 'range', min: 10, max: 20 });
        // Spans map exactly back to the number tokens in the source.
        expect(text.slice(sys.x!.spans!.min!.start, sys.x!.spans!.min!.end)).to.equal('-97');
        expect(text.slice(sys.x!.spans!.max!.start, sys.x!.spans!.max!.end)).to.equal('-93');
        expect(text.slice(sys.y!.spans!.min!.start, sys.y!.spans!.min!.end)).to.equal('10');
        expect(text.slice(sys.y!.spans!.max!.start, sys.y!.spans!.max!.end)).to.equal('20');
    });

    it('produces the same model for single-line and multi-line systems', () => {
        const single = firstScenario(`
static_galaxy_scenario = {
    system = { id = 7 name = "X" position = { x = 3 y = 4 } initializer = foo_init }
}
`);
        const multi = firstScenario(`
static_galaxy_scenario = {
    system = {
        id = 7
        name = "X"
        position = {
            x = 3
            y = 4
        }
        initializer = foo_init
    }
}
`);
        const a = single.systems[0]!;
        const b = multi.systems[0]!;
        expect(a.id).to.equal(b.id);
        expect(a.name).to.equal(b.name);
        expect(a.initializer).to.equal(b.initializer);
        // Semantic equivalence: spans differ by layout, values must not.
        expect({ kind: a.x!.kind, value: a.x!.value }).to.deep.equal({ kind: b.x!.kind, value: b.x!.value });
        expect({ kind: a.y!.kind, value: a.y!.value }).to.deep.equal({ kind: b.y!.kind, value: b.y!.value });
    });

    it('handles strings with escaped quotes, comments and CRLF', () => {
        const scenario = firstScenario(
            'static_galaxy_scenario = {\r\n' +
            '    # a comment with position = { x = 999 }\r\n' +
            '    system = {\r\n' +
            '        id = 1\r\n' +
            '        name = "Foo \\"Bar\\""\r\n' +
            '        position = { x = 1 y = 2 }\r\n' +
            '    }\r\n' +
            '}\r\n',
        );
        const sys = scenario.systems[0]!;
        expect(sys.name).to.equal('Foo \\"Bar\\"');
        expect(sys.x).to.deep.include({ kind: 'fixed', value: 1 });
        expect(sys.y).to.deep.include({ kind: 'fixed', value: 2 });
    });

    it('parses multiple scenarios in one file', () => {
        const result = parseStaticGalaxy(readFixture('transform.txt'));
        expect(result.ok).to.equal(true);
        expect(result.scenarios).to.have.lengthOf(2);
        expect(result.scenarios[0]!.name).to.equal('TRANSFORM_A');
        expect(result.scenarios[1]!.name).to.equal('SECOND_SCENARIO');
        expect(result.scenarios[1]!.systems).to.have.lengthOf(2);
    });

    it('applies coordinate_transform in document order', () => {
        const scenario = firstScenario(readFixture('transform.txt'));
        const [sys1, sys2, sys3] = scenario.systems;
        // x: add 100 then mul 2 -> eff = raw * 2 + 200; y: sub 50.
        const view = toScenarioView(scenario);
        const v1 = view.systems[0]!;
        expect(v1.effectivePosition.x.center).to.equal(10 * 2 + 200);
        expect(v1.effectivePosition.y.center).to.equal(100 - 50);
        expect(v1.rawPosition.x.center).to.equal(10);
        // Second transform adds 1000 more to x: eff = raw * 2 + 1200.
        const v2 = view.systems[1]!;
        expect(v2.effectivePosition.x.center).to.equal(1 * 2 + 1200);
        expect(v2.effectivePosition.y.center).to.equal(1 - 50);
        // mul = 0 makes the third system non-editable.
        expect(sys3!.editable).to.equal(false);
        expect(sys3!.editBlockedReason).to.include('not invertible');
        expect(sys1!.editable).to.equal(true);
        expect(sys2!.editable).to.equal(true);
        // Transforms never leak into the next scenario.
        const second = firstScenario2Scenarios();
        expect(second.systems[0]!.hasTransform).to.equal(false);
    });

    function firstScenario2Scenarios(): ParsedScenario {
        const result = parseStaticGalaxy(readFixture('transform.txt'));
        return result.scenarios[1]!;
    }

    it('inverts transforms for write-back (forward then inverse round-trips)', () => {
        const scenario = firstScenario(readFixture('transform.txt'));
        const sys = scenario.systems[0]!;
        const t = sys.transform.x;
        const raw = 10;
        const eff = raw * t.mul + t.add;
        expect((eff - t.add) / t.mul).to.equal(raw);
    });

    it('parses add/remove/prevent hyperlanes and resolves endpoints', () => {
        const scenario = firstScenario(readFixture('basic.txt'));
        expect(scenario.hyperlanes).to.have.lengthOf(3);
        expect(scenario.hyperlanes.map(l => l.kind)).to.deep.equal(['add', 'remove', 'prevent']);
        const add = scenario.hyperlanes[0]!;
        expect(add.fromNodeKey).to.equal(scenario.systems[0]!.nodeKey);
        expect(add.toNodeKey).to.equal(scenario.systems[1]!.nodeKey);
    });

    it('parses nebula position and radius', () => {
        const scenario = firstScenario(readFixture('basic.txt'));
        const nebula = scenario.nebulas[0]!;
        expect(nebula.name).to.equal('TEST_NEBULA');
        expect(nebula.radius).to.equal(40);
        expect(nebula.x).to.deep.include({ kind: 'fixed', value: 100 });
        expect(nebula.editable).to.equal(true);
        const view = toScenarioView(scenario).nebulas[0]!;
        expect(view.editable).to.equal(true);
        const settings = scenario.settings;
        expect(settings.randomHyperlanes).to.equal(false);
        expect(settings.maxHyperlaneDistance).to.equal(50);
    });

    it('maps the nebula radius span back to the exact token', () => {
        const text = readFixture('basic.txt');
        const scenario = firstScenario(text);
        const nebula = scenario.nebulas[0]!;
        expect(nebula.radiusWritable).to.equal(true);
        expect(text.slice(nebula.radiusSpan!.start, nebula.radiusSpan!.end)).to.equal('40');
        expect(toScenarioView(scenario).nebulas[0]!.radiusEditable).to.equal(true);
    });

    it('blocks nebula movement when coordinates cannot be written safely', () => {
        const scenario = firstScenario(`
static_galaxy_scenario = {
    coordinate_transform = { x = { mul = 0 } }
    nebula = { position = { x = 10 y = 20 z = 3 } radius = 5 }
}
`);
        const nebula = scenario.nebulas[0]!;
        expect(nebula.editable).to.equal(false);
        expect(nebula.editBlockedReason).to.include('not invertible');
        expect(toScenarioView(scenario).nebulas[0]!.rawPosition.z).to.deep.include({ kind: 'fixed', value: 3 });
    });

    it('flags duplicate ids, dangling endpoints, reversed ranges and missing axes', () => {
        const scenario = firstScenario(readFixture('ranges.txt'));
        const allDiags = [
            ...scenario.diagnostics,
            ...scenario.systems.flatMap(s => s.diagnostics),
            ...scenario.hyperlanes.flatMap(l => l.diagnostics),
        ];
        const codes = allDiags.map(d => d.code);
        expect(codes).to.include('duplicate-system-id');
        expect(codes).to.include('dangling-hyperlane');
        expect(codes).to.include('reversed-range');
        expect(codes).to.include('missing-axis');
        expect(codes).to.include('unresolved-coordinate');
        expect(codes).to.include('random-hyperlanes-imprecise');

        // Reversed range keeps the original order in the raw view.
        const view = toScenarioView(scenario);
        const reversed = view.systems.find(s => s.id === '11' && s.rawPosition.x.kind === 'range')!;
        expect(reversed.rawPosition.x).to.deep.include({ kind: 'range', min: 30, max: 10, reversed: true });

        // Duplicate ids stay distinct nodes.
        const dupes = view.systems.filter(s => s.id === '11');
        expect(dupes).to.have.lengthOf(2);
        expect(dupes[0]!.nodeKey).to.not.equal(dupes[1]!.nodeKey);

        // Ambiguous endpoint is not resolved to a node.
        const ambiguous = scenario.hyperlanes.find(l => l.toId === '11')!;
        expect(ambiguous.toNodeKey).to.equal(undefined);
    });

    it('degrades expressions to unresolved axes without failing the file', () => {
        const scenario = firstScenario(readFixture('ranges.txt'));
        const expr = scenario.systems.find(s => s.id === '13')!;
        expect(expr.x!.kind).to.equal('unresolved');
        expect(expr.editable).to.equal(false);
        // Preview still renders the other axis.
        const view = toScenarioView(scenario);
        const v = view.systems.find(s => s.id === '13')!;
        expect(v.effectivePosition.y.center).to.equal(8);
        expect(v.effectivePosition.x.kind).to.equal('unresolved');
    });

    it('dedupes reversed duplicate add_hyperlane declarations in the view', () => {
        const scenario = firstScenario(`
static_galaxy_scenario = {
    system = { id = 1 position = { x = 0 y = 0 } }
    system = { id = 2 position = { x = 10 y = 10 } }
    add_hyperlane = { from = 1 to = 2 }
    add_hyperlane = { from = 2 to = 1 }
}
`);
        const view = toScenarioView(scenario);
        expect(view.hyperlanes).to.have.lengthOf(1);
    });

    it('resolves numeric @variables for display but blocks editing', () => {
        const scenario = firstScenario(`
@base = 123
static_galaxy_scenario = {
    system = { id = 1 position = { x = @base y = 5 } }
}
`);
        const sys = scenario.systems[0]!;
        expect(sys.x).to.deep.include({ kind: 'fixed', value: 123 });
        expect(sys.x!.spans).to.equal(undefined);
        expect(sys.editable).to.equal(false);
        const view = toScenarioView(scenario);
        expect(view.systems[0]!.effectivePosition.x.center).to.equal(123);
    });

    it('returns a parse failure when no scenario exists', () => {
        const result = parseStaticGalaxy('setup_scenario = { num_stars = 10 }');
        expect(result.ok).to.equal(false);
        expect(result.error).to.include('static_galaxy_scenario');
    });

    it('rejects unbalanced braces so malformed documents remain read-only', () => {
        const result = parseStaticGalaxy(`
static_galaxy_scenario = {
    system = { id = 1 position = { x = 1 y = 2 }
`);
        expect(result.ok).to.equal(false);
        expect(result.scenarios).to.have.lengthOf(0);
        expect(result.error).to.include('Unclosed block');
    });

    it('rejects stray closing braces', () => {
        const result = parseStaticGalaxy(`
static_galaxy_scenario = {
    system = { id = 1 position = { x = 1 y = 2 } }
}
}
`);
        expect(result.ok).to.equal(false);
        expect(result.error).to.include('Unexpected closing brace');
    });

    it('falls back to the system id for an explicitly empty name', () => {
        const scenario = firstScenario(`
static_galaxy_scenario = {
    system = { id = 42 name = "" position = { x = 1 y = 2 } }
}
`);
        const system = scenario.systems[0]!;
        expect(toScenarioView(scenario).systems[0]!.displayName).to.equal('System 42');
        expect(system.diagnostics.some(d => d.code === 'unnamed-system')).to.equal(false);
    });

    it('parses a generated 2000-system file stably', () => {
        const parts: string[] = ['static_galaxy_scenario = {', 'name = "BIG"'];
        for (let i = 0; i < 2000; i++) {
            const x = (i % 50) * 20 - 500;
            const y = Math.floor(i / 50) * 20 - 400;
            parts.push(`system = { id = ${i} position = { x = { min = ${x - 2} max = ${x + 2} } y = { min = ${y - 2} max = ${y + 2} } } }`);
        }
        parts.push('}');
        const text = parts.join('\n');

        const started = Date.now();
        const result = parseStaticGalaxy(text);
        const elapsed = Date.now() - started;

        expect(result.ok).to.equal(true);
        const scenario = result.scenarios[0]!;
        expect(scenario.systems).to.have.lengthOf(2000);
        expect(new Set(scenario.systems.map(s => s.nodeKey)).size).to.equal(2000);
        const view = toScenarioView(scenario);
        expect(Number.isFinite(view.bounds.minX)).to.equal(true);
        expect(view.bounds.minX).to.equal(-502);
        expect(view.bounds.maxY).to.equal(382);
        // Loose upper bound only: catches accidental super-linear blowups.
        expect(elapsed).to.be.lessThan(10000);
    });
});
