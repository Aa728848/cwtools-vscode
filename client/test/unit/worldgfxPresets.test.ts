import { expect } from 'chai';

const vscodeStub = {
    window: {
        createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }),
        showErrorMessage: () => undefined,
    },
};

function loadModule() {
    const moduleLoader = require('module') as { _load: (...args: unknown[]) => unknown };
    const originalLoad = moduleLoader._load;
    moduleLoader._load = function (this: unknown, request: string, ...args: unknown[]) {
        if (request === 'vscode') return vscodeStub;
        return originalLoad.apply(this, [request, ...args] as never);
    };
    try {
        return require('../../extension/worldgfxPresets') as typeof import('../../extension/worldgfxPresets');
    } finally {
        moduleLoader._load = originalLoad;
    }
}

const { parseWorldGfxFile } = loadModule();

const DEFAULT_TXT = `#reloadworldgfx
gfx_settings =
{
	# world tag identifier
	world = default

	center_entity = "default_galaxy_center_entity"

    color_lut = "gfx/worldgfx/colorcorrection_neutral.tga"
	environment_map = "gfx/worldgfx/cubemap_filtered_ldr.dds"
	galaxy_background = { texture = "gfx/worldgfx/stars.dds" trigger = { always = yes } ycocg = no }

	galaxy_background_hsv_shift = { 0.0 0.0 0.0 }
	galaxy_background_lut = "gfx/worldgfx/colorcorrection_neutral.tga"

	light_hdr_range = 1.0
	bright_threshold = 0.5		# used by both bloom and lens flare

	system_light="system_light"
}
`;

const STAR_M_TXT = `#reloadworldgfx
gfx_settings =
{
	world = m_star
	#center_entity = "test_ships_entity"

    color_lut = "gfx/worldgfx/colorcorrection_m_class.tga"
	environment_map = "gfx/worldgfx/cubemap_filtered_ldr.dds"

	galaxy_background = { texture = "gfx/map/sky_core.dds" 	trigger = { distance_to_core_percent < 0.50 } ycocg = yes }
	galaxy_background = { texture = "gfx/map/sky_mid.dds" 		trigger = { distance_to_core_percent < 0.75 } ycocg = yes }
	galaxy_background = { texture = "gfx/map/sky_rim.dds" 	trigger = { always = yes } ycocg = yes }

	galaxy_background_hsv_shift = { -0.51 -0.1 0.0 }

	#galaxy_background_lut = "gfx/worldgfx/colorcorrection_neutral.tga"
	galaxy_background_lut = "gfx/worldgfx/colorcorrection_m_class_skybox.tga"

	cubemap_intensity = 0.4#0.4

	system_back_light_diffuse = hsv { 0.0 0.1 0.6 } #0.4

	ambient = hsv { 0.0	0.9	0.0	}	#0.1 global ambient, no direction

	cam_light_1_diffuse = hsv { 0.12 0.2 0.5} #1
	cam_light_2_diffuse = hsv { 0.55 0.4 0.45} #0.45
	cam_light_3_diffuse = hsv { 0.03 0.30 0.75 } # 0.5

	rim_light_diffuse = hsv { 0.56 0.5 0.25}#0.25	#GOOD

	lava_bright_color = hsv { 0.05 1.0 1.0 } #
	lava_bright_color = hsv { 0.0 0.9 0.9 }

	tonemap_middlegrey = 0.14
	tonemap_whiteluminance = 2.0

	system_light="m_class_star"
}
`;

const SHIP_DESIGNER_TXT = `#reloadworldgfx
# Ship designer

gfx_settings =
{
	world = ship_designer

    color_lut = "gfx/worldgfx/colorcorrection_neutral.tga"
	environment_map = "gfx/worldgfx/cubemap_filtered_ldr.dds"

	galaxy_background = { texture = "gfx/map/sky_rim.dds" ycocg = yes }
	galaxy_background_hsv_shift = { 0.0 0.0 0.0 }
	galaxy_background_lut = "gfx/worldgfx/colorcorrection_neutral.tga"

 	bright_threshold = 0.95

	cubemap_intensity = 0.4#0.7

	ambient = hsv { 0.58	0.5	0.4	}	#global ambient, no direction

	cam_light_1_diffuse = hsv { 0.12 0.2 0.0} #1
	cam_light_2_diffuse = hsv { 0.55 0.4 0.45} #0.45
	cam_light_3_diffuse = hsv { 0.55 0.35 0.75 } # 0.8

	rim_light_diffuse = hsv { 0.56 0.5 0.25}#0.25

	system_light="ship_designer_light"
}
`;

describe('worldgfxPresets parser', () => {
    it('parses default.txt: world id, background, LUTs, environment map', () => {
        const preset = parseWorldGfxFile(DEFAULT_TXT, 'default.txt');
        expect(preset).to.not.be.null;
        expect(preset!.id).to.equal('default');
        expect(preset!.backgrounds).to.have.lengthOf(1);
        expect(preset!.backgrounds[0]!.texturePath).to.equal('gfx/worldgfx/stars.dds');
        expect(preset!.backgrounds[0]!.ycocg).to.be.false;
        expect(preset!.backgrounds[0]!.trigger).to.equal('always = yes');
        expect(preset!.backgrounds[0]!.label).to.equal('stars');
        expect((preset as { colorLutPath?: string }).colorLutPath).to.equal('gfx/worldgfx/colorcorrection_neutral.tga');
        expect((preset as { environmentMapPath?: string }).environmentMapPath).to.equal('gfx/worldgfx/cubemap_filtered_ldr.dds');
    });

    it('parses star_m_class.txt: three triggered backgrounds, hsv shift, light rig', () => {
        const preset = parseWorldGfxFile(STAR_M_TXT, 'star_m_class.txt');
        expect(preset).to.not.be.null;
        expect(preset!.id).to.equal('m_star');
        expect(preset!.backgrounds).to.have.lengthOf(3);
        expect(preset!.backgrounds.map(b => b.label)).to.deep.equal(['core', 'mid', 'rim']);
        expect(preset!.backgrounds[0]!.trigger).to.equal('distance_to_core_percent < 0.5');
        expect(preset!.backgrounds[1]!.trigger).to.equal('distance_to_core_percent < 0.75');
        expect(preset!.backgrounds.every(b => b.ycocg)).to.be.true;
        expect(preset!.backgroundHsvShift).to.deep.equal([-0.51, -0.1, 0]);
        expect(preset!.cubemapIntensity).to.equal(0.4);
        expect(preset!.camLight1Hsv).to.deep.equal([0.12, 0.2, 0.5]);
        expect(preset!.camLight2Hsv).to.deep.equal([0.55, 0.4, 0.45]);
        expect(preset!.camLight3Hsv).to.deep.equal([0.03, 0.3, 0.75]);
        expect(preset!.rimLightHsv).to.deep.equal([0.56, 0.5, 0.25]);
        expect(preset!.ambientHsv).to.deep.equal([0, 0.9, 0]);
        expect(preset!.systemBackLightHsv).to.deep.equal([0, 0.1, 0.6]);
        expect(preset!.tonemapMiddleGrey).to.equal(0.14);
        expect(preset!.tonemapWhiteLuminance).to.equal(2);
        expect((preset as { backgroundLutPath?: string }).backgroundLutPath).to.equal('gfx/worldgfx/colorcorrection_m_class_skybox.tga');
    });

    it('parses ship_designer.txt: background without trigger, ambient light', () => {
        const preset = parseWorldGfxFile(SHIP_DESIGNER_TXT, 'ship_designer.txt');
        expect(preset).to.not.be.null;
        expect(preset!.id).to.equal('ship_designer');
        expect(preset!.backgrounds).to.have.lengthOf(1);
        expect(preset!.backgrounds[0]!.trigger).to.be.undefined;
        expect(preset!.backgrounds[0]!.ycocg).to.be.true;
        expect(preset!.ambientHsv).to.deep.equal([0.58, 0.5, 0.4]);
        expect(preset!.camLight1Hsv).to.deep.equal([0.12, 0.2, 0]);
    });

    it('returns null for content without gfx_settings/world', () => {
        expect(parseWorldGfxFile('foo = bar', 'x.txt')).to.be.null;
        expect(parseWorldGfxFile('gfx_settings = { bloom_width = 2 }', 'x.txt')).to.be.null;
        expect(parseWorldGfxFile('', 'x.txt')).to.be.null;
    });

    it('survives real game files when present (smoke test)', () => {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        const dir = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Stellaris\\gfx\\worldgfx';
        if (!fs.existsSync(dir)) return;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
        expect(files.length).to.be.greaterThan(5);
        let parsed = 0;
        for (const file of files) {
            const preset = parseWorldGfxFile(fs.readFileSync(path.join(dir, file), 'utf8'), file);
            if (preset) {
                parsed++;
                expect(preset.id).to.be.a('string').and.not.empty;
            }
        }
        expect(parsed).to.be.greaterThan(5);
    });
});
