export type DdsOutputFormatId = 'dxt5' | 'dxt1' | 'dxt3' | 'rgba';
export type DdsCompression = 'dxt5' | 'dxt1' | 'dxt3' | 'none';

export interface DdsOutputFormat {
	id: DdsOutputFormatId;
	compression: DdsCompression;
	mipmaps: boolean;
	label: string;
}

export const DDS_OUTPUT_FORMATS: readonly DdsOutputFormat[] = [
	{ id: 'dxt5', compression: 'dxt5', mipmaps: false, label: 'BC3 / DXT5' },
	{ id: 'dxt1', compression: 'dxt1', mipmaps: false, label: 'BC1 / DXT1' },
	{ id: 'dxt3', compression: 'dxt3', mipmaps: false, label: 'BC2 / DXT3' },
	{ id: 'rgba', compression: 'none', mipmaps: false, label: 'RGBA uncompressed' },
];

export const DEFAULT_DDS_OUTPUT_FORMAT = DDS_OUTPUT_FORMATS[0]!;

export function buildDdsImageMagickArgs(
	sourcePath: string,
	outputPath: string,
	format: DdsOutputFormat = DEFAULT_DDS_OUTPUT_FORMAT,
): string[] {
	return [
		sourcePath,
		'-define',
		`dds:compression=${format.compression}`,
		'-define',
		`dds:mipmaps=${format.mipmaps ? 'true' : '0'}`,
		outputPath,
	];
}
