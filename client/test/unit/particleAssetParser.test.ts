import { expect } from 'chai';
import { tokenize, TokenType } from '../../extension/pdxTokenizer';
import { parseParticleFile } from '../../extension/particleAssetParser';
import { classifyAssetFile } from '../../extension/particleSniff';
import { replaceFieldSpan, serializeEffect, serializeFieldValue, serializeScalar } from '../../extension/particleAssetSerializer';
import { isRange } from '../../webview/particleTypes';

const SAMPLE = `
particle = {
\tname = arc_emitter_muzzle
\tscale = 1.000
\tsubsystem = {
\t\tname = glow
\t\tmax_amount = 255
\t\temitter_type = point
\t\tbillboard = yes
\t\tduration = -1
\t\tlife = { 0.250 0.500 }
\t\tsize = 4.00,grow
\t\temission = { 10 20 }
\t\tcolor = {
\t\t\tx = { 80 10 }
\t\t\ty = 255
\t\t\tz = 64
\t\t\talpha = 255,fade_alpha
\t\t}
\t\ttexture = { file = "gfx/particles/beam.dds" x = 4 y = 4 shader = ParticleAdditive }
\t\tposition = { }
\t\tvelocity_yaw = { -10 10 }
\t}
\tsubsystem = {
\t\tname = box_bits
\t\temitter_type = box
\t\tbox_emitter_x = { -1 1 }
\t\tbox_emitter_y = { -2 2 }
\t\tbox_emitter_z = { -3 3 }
\t}
\tanimation = {
\t\tname = grow
\t\tstart = 0
\t\tduration = 1
\t\trepeat = yes
\t\tminValue = 0
\t\tmaxValue = 1
\t\tcurve = { 0 0 1 1 }
\t\top = MUL
\t\ttime = life
\t}
\tforce = {
\t\tname = wind
\t\ttype = planar
\t\tdirection = { 0 1 0 }
\t\tamount = 1.000
\t}
}
`;

describe('particle asset parser', () => {
    it('tokenizes comma curves without changing default tokenization', () => {
        const defaultTokens = tokenize('size = 4.00,grow');
        expect(defaultTokens.some(t => t.type === TokenType.Comma)).to.equal(false);

        const tokens = tokenize('size = 4.00,grow', { comma: true });
        expect(tokens.map(t => t.value).slice(0, 5)).to.deep.equal(['size', '=', '4.00', ',', 'grow']);
        expect(tokens[2]!.startOffset).to.equal(7);
    });

    it('sniffs top-level particle blocks and ignores nested entity particle refs', () => {
        expect(classifyAssetFile(SAMPLE)).to.equal('particle');
        expect(classifyAssetFile('entity = { name = ship state = { particle = arc_emitter_muzzle } }')).to.equal('entity');
        expect(classifyAssetFile('# particle = { broken = { \nentity = { name = ship }')).to.equal('entity');
        expect(classifyAssetFile('# entity = { { \nparticle = { name = spark }')).to.equal('particle');
    });

    it('parses curves, ranges, color ranges, empty positions, duration -1, box emitters, and forces', () => {
        const result = parseParticleFile(SAMPLE, 'sample.asset');
        expect(result.diagnostics).to.deep.equal([]);
        expect(result.effects).to.have.length(1);
        const effect = result.effects[0]!;
        expect(effect.name).to.equal('arc_emitter_muzzle');
        expect(effect.subsystems).to.have.length(2);

        const glow = effect.subsystems[0]!;
        expect(glow.maxAmount).to.equal(255);
        expect(glow.duration && !isRange(glow.duration) ? glow.duration.value : undefined).to.equal(-1);
        expect(glow.size && !isRange(glow.size) ? glow.size.curve : undefined).to.equal('grow');
        expect(glow.color?.r && isRange(glow.color.r) ? glow.color.r.a.value : undefined).to.equal(80);
        expect(glow.color?.alpha && !isRange(glow.color.alpha) ? glow.color.alpha.curve : undefined).to.equal('fade_alpha');
        expect(glow.position?.span?.startOffset).to.be.a('number');
        expect(glow.texture?.file).to.equal('gfx/particles/beam.dds');

        const box = effect.subsystems[1]!;
        expect(box.emitterType).to.equal('box');
        expect(box.boxEmitterX && isRange(box.boxEmitterX) ? box.boxEmitterX.b.value : undefined).to.equal(1);

        expect(effect.animations[0]?.points).to.deep.equal([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
        expect(effect.forces[0]?.direction).to.deep.equal([0, 1, 0]);
    });

    it('preserves multiple comma values on range endpoints', () => {
        const source = 'particle={ name=test subsystem={ name=glow pulse={ 0,alpha_fade,2 8,beta,4,other } } }';
        const effect = parseParticleFile(source).effects[0]!;
        const pulse = effect.subsystems[0]?.unknown?.find(item => item.key === 'pulse');
        expect(pulse?.raw).to.contain('0,alpha_fade,2');

        const parsed = parseParticleFile('particle={ name=test subsystem={ name=glow emission={ alpha_fade,2 8,beta,4,other } } }').effects[0]!;
        const emission = parsed.subsystems[0]!.emission!;
        expect(emission && isRange(emission) ? emission.a.raw : undefined).to.equal('alpha_fade');
        expect(emission && isRange(emission) ? emission.a.curve : undefined).to.equal('2');
        expect(emission && isRange(emission) ? emission.a.value : undefined).to.equal(0);
        expect(emission && isRange(emission) ? emission.a.suffixes : undefined).to.equal(undefined);
        expect(emission && isRange(emission) ? emission.b.curve : undefined).to.equal('beta');
        expect(emission && isRange(emission) ? emission.b.suffixes : undefined).to.deep.equal(['4', 'other']);
        expect(serializeScalar(emission)).to.equal('{ alpha_fade,2 8,beta,4,other }');
    });

    it('preserves curve names in both range endpoints', () => {
        const parsed = parseParticleFile('particle={ name=test subsystem={ name=glow emission={ alpha_fade beta_fade } } }').effects[0]!;
        const emission = parsed.subsystems[0]!.emission!;
        expect(emission && isRange(emission) ? emission.a.raw : undefined).to.equal('alpha_fade');
        expect(emission && isRange(emission) ? emission.b.raw : undefined).to.equal('beta_fade');
        expect(emission && isRange(emission) ? emission.a.suffixes : undefined).to.equal(undefined);
        expect(serializeScalar(emission)).to.equal('{ alpha_fade beta_fade }');
    });

    it('preserves comma-separated subsystem force references', () => {
        const source = 'particle={ name=test subsystem={ name=shards force=gravity,friction } force={ name=gravity type=planar } force={ name=friction type=friction } }';
        const effect = parseParticleFile(source).effects[0]!;
        expect(effect.subsystems[0]?.force).to.equal('gravity,friction');
        expect(serializeEffect(effect)).to.contain('force=gravity,friction');
    });

    it('serializes parsed effects back into parseable particle blocks', () => {
        const effect = parseParticleFile(SAMPLE).effects[0]!;
        const serialized = serializeEffect(effect);
        const roundTrip = parseParticleFile(serialized);
        expect(roundTrip.diagnostics).to.deep.equal([]);
        expect(roundTrip.effects[0]?.subsystems[0]?.name).to.equal('glow');
        expect(roundTrip.effects[0]?.animations[0]?.name).to.equal('grow');
        expect(serialized).to.contain('particle={');
        expect(serialized).to.contain('name="arc_emitter_muzzle"');
        expect(serialized).to.contain('scale=1.000');
        expect(serialized).to.contain('file="gfx/particles/beam.dds"');
        expect(serialized).to.contain('shader="ParticleAdditive"');
        expect(serialized).to.not.contain('name =');
        expect(serializeFieldValue('glow', undefined, true)).to.equal('"glow"');
    });

    it('uses spans for minimal scalar replacement', () => {
        const effect = parseParticleFile(SAMPLE).effects[0]!;
        const size = effect.subsystems[0]!.size!;
        const replacement = serializeScalar({ ...size, value: 8 } as typeof size);
        const edited = replaceFieldSpan(SAMPLE, size.span!, replacement);
        expect(edited).to.contain('size = 8.00,grow');
        expect(edited).to.contain('color = {');
    });
});
