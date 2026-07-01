import { expect } from 'chai';
import {
	buildDdsImageMagickArgs,
	DDS_OUTPUT_FORMATS,
	DEFAULT_DDS_OUTPUT_FORMAT,
} from '../../extension/ddsOutputFormats';

describe('DDS output formats', () => {
	it('keeps DXT5 with mipmaps as the default conversion format', () => {
		expect(DEFAULT_DDS_OUTPUT_FORMAT.id).to.equal('dxt5');
		expect(buildDdsImageMagickArgs('input.png', 'output.dds')).to.deep.equal([
			'input.png',
			'-define',
			'dds:compression=dxt5',
			'-define',
			'dds:mipmaps=true',
			'output.dds',
		]);
	});

	it('builds ImageMagick arguments for each selectable DDS format', () => {
		const formats = new Map(DDS_OUTPUT_FORMATS.map(format => [format.id, format]));

		expect(buildDdsImageMagickArgs('in.png', 'out.dds', formats.get('dxt1')!)).to.include('dds:compression=dxt1');
		expect(buildDdsImageMagickArgs('in.png', 'out.dds', formats.get('dxt3')!)).to.include('dds:compression=dxt3');
		expect(buildDdsImageMagickArgs('in.png', 'out.dds', formats.get('rgba')!)).to.include('dds:compression=none');
	});
});
