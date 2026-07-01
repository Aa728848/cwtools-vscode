import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import * as vs from 'vscode';
import { decodeDds, decodeTga } from './ddsDecoder';
import {
	buildDdsImageMagickArgs,
	DDS_OUTPUT_FORMATS,
	type DdsOutputFormat,
	type DdsOutputFormatId,
} from './ddsOutputFormats';

const execFileAsync = promisify(execFile);
const IMAGE_EXTS = new Set(['.dds', '.tga', '.png', '.jpg', '.jpeg', '.bmp']);

function isChineseLocale(): boolean {
	return vs.env.language.toLowerCase().startsWith('zh');
}

function localize(en: string, zh: string): string {
	return isChineseLocale() ? zh : en;
}

function imageMagickBin(): string {
	return vs.workspace.getConfiguration('stellarisLanguageServices.ai').get<string>('imageMagickPath')?.trim() || 'magick';
}

function activeImageUri(resource?: vs.Uri): vs.Uri | undefined {
	if (resource?.scheme === 'file' && IMAGE_EXTS.has(path.extname(resource.fsPath).toLowerCase())) return resource;
	const editor = vs.window.activeTextEditor;
	if (!editor || editor.document.uri.scheme !== 'file') return undefined;
	return IMAGE_EXTS.has(path.extname(editor.document.uri.fsPath).toLowerCase()) ? editor.document.uri : undefined;
}

async function ensureWritableOutput(outputPath: string): Promise<boolean> {
	if (!fs.existsSync(outputPath)) return true;
	const choice = await vs.window.showWarningMessage(
		localize(
			`${path.basename(outputPath)} already exists. Overwrite it?`,
			`${path.basename(outputPath)} 已存在。覆盖它吗？`,
		),
		{ modal: true },
		localize('Overwrite', '覆盖'),
	);
	return choice === localize('Overwrite', '覆盖');
}

function defaultOutputPath(inputPath: string, extension: string): string {
	const parsed = path.parse(inputPath);
	return path.join(parsed.dir, `${parsed.name}${extension}`);
}

function dataUriToPngBuffer(dataUri: string): Buffer {
	const comma = dataUri.indexOf(',');
	if (comma < 0) throw new Error('Decoder returned an invalid PNG data URI.');
	return Buffer.from(dataUri.slice(comma + 1), 'base64');
}

async function convertDecodedTextureToPng(sourcePath: string, outputPath: string): Promise<void> {
	const ext = path.extname(sourcePath).toLowerCase();
	const decoded = ext === '.dds'
		? decodeDds(sourcePath)
		: ext === '.tga'
			? decodeTga(sourcePath)
			: null;
	if (!decoded) throw new Error('The texture could not be decoded locally.');
	await fs.promises.writeFile(outputPath, dataUriToPngBuffer(decoded.dataUri));
}

async function runImageMagick(args: string[]): Promise<void> {
	await execFileAsync(imageMagickBin(), args, { timeout: 120000, windowsHide: true });
}

type DdsFormatPick = vs.QuickPickItem & { format: DdsOutputFormat };

const DDS_FORMAT_DETAILS: Record<DdsOutputFormatId, { descriptionEn: string; descriptionZh: string; detailEn: string; detailZh: string }> = {
	dxt5: {
		descriptionEn: 'Recommended for UI, icons, and sprites with alpha',
		descriptionZh: '推荐：适合带透明通道的 UI、图标、精灵',
		detailEn: 'Compressed BC3/DXT5 DDS with mipmaps. This matches the previous default conversion.',
		detailZh: '带 mipmaps 的 BC3/DXT5 压缩 DDS。等同于之前的默认转换格式。',
	},
	dxt1: {
		descriptionEn: 'Opaque textures, smaller output',
		descriptionZh: '不透明贴图，输出更小',
		detailEn: 'Compressed BC1/DXT1 DDS with mipmaps. Do not use when the texture needs smooth alpha.',
		detailZh: '带 mipmaps 的 BC1/DXT1 压缩 DDS。需要平滑透明通道时不要使用。',
	},
	dxt3: {
		descriptionEn: 'Legacy explicit alpha',
		descriptionZh: '旧式显式透明通道',
		detailEn: 'Compressed BC2/DXT3 DDS with mipmaps. Useful only for assets that specifically expect DXT3.',
		detailZh: '带 mipmaps 的 BC2/DXT3 压缩 DDS。仅在资源明确需要 DXT3 时使用。',
	},
	rgba: {
		descriptionEn: 'Uncompressed, largest output',
		descriptionZh: '不压缩，输出最大',
		detailEn: 'Uncompressed DDS with mipmaps. Use when compression artifacts are unacceptable.',
		detailZh: '带 mipmaps 的未压缩 DDS。压缩失真不可接受时使用。',
	},
};

async function selectDdsOutputFormat(): Promise<DdsOutputFormat | undefined> {
	const picks: DdsFormatPick[] = DDS_OUTPUT_FORMATS.map(format => {
		const copy = DDS_FORMAT_DETAILS[format.id];
		return {
			label: format.label,
			description: localize(copy.descriptionEn, copy.descriptionZh),
			detail: localize(copy.detailEn, copy.detailZh),
			format,
		};
	});

	const picked = await vs.window.showQuickPick(picks, {
		title: localize('DDS Output Format', 'DDS 输出格式'),
		placeHolder: localize('Choose the DDS format for the converted file', '选择转换后 DDS 文件的格式'),
		matchOnDescription: true,
		matchOnDetail: true,
	});

	return picked?.format;
}

async function convertToPng(resource?: vs.Uri): Promise<void> {
	const uri = activeImageUri(resource);
	if (!uri) {
		void vs.window.showWarningMessage(localize('Select or open an image first.', '请先选择或打开一张图片。'));
		return;
	}

	const sourcePath = uri.fsPath;
	const outputPath = defaultOutputPath(sourcePath, '.png');
	if (path.extname(sourcePath).toLowerCase() === '.png') {
		await vs.window.showInformationMessage(localize('The selected image is already PNG.', '所选图片已经是 PNG。'));
		return;
	}
	if (!(await ensureWritableOutput(outputPath))) return;

	try {
		await vs.window.withProgress({ location: vs.ProgressLocation.Notification, title: localize('Converting image to PNG...', '正在转换图片为 PNG...') }, async () => {
			const ext = path.extname(sourcePath).toLowerCase();
			if (ext === '.dds' || ext === '.tga') {
				await convertDecodedTextureToPng(sourcePath, outputPath);
			} else {
				await runImageMagick([sourcePath, outputPath]);
			}
		});
		await vs.window.showInformationMessage(localize(`PNG written: ${outputPath}`, `PNG 已写入：${outputPath}`));
	} catch (e) {
		await vs.window.showErrorMessage(localize(
			`Image conversion failed: ${(e as Error)?.message ?? String(e)}`,
			`图片转换失败：${(e as Error)?.message ?? String(e)}`,
		));
	}
}

async function convertToDds(resource?: vs.Uri): Promise<void> {
	const uri = activeImageUri(resource);
	if (!uri) {
		void vs.window.showWarningMessage(localize('Select or open an image first.', '请先选择或打开一张图片。'));
		return;
	}

	const sourcePath = uri.fsPath;
	const outputPath = defaultOutputPath(sourcePath, '.dds');
	if (path.extname(sourcePath).toLowerCase() === '.dds') {
		void vs.window.showInformationMessage(localize('The selected image is already DDS.', '所选图片已经是 DDS。'));
		return;
	}
	const outputFormat = await selectDdsOutputFormat();
	if (!outputFormat) return;
	if (!(await ensureWritableOutput(outputPath))) return;

	try {
		await vs.window.withProgress({ location: vs.ProgressLocation.Notification, title: localize('Converting image to DDS...', '正在转换图片为 DDS...') }, async () => {
			await runImageMagick(buildDdsImageMagickArgs(sourcePath, outputPath, outputFormat));
		});
		await vs.window.showInformationMessage(localize(`DDS written (${outputFormat.label}): ${outputPath}`, `DDS 已写入（${outputFormat.label}）：${outputPath}`));
	} catch (e) {
		await vs.window.showErrorMessage(localize(
			`Image conversion failed: ${(e as Error)?.message ?? String(e)}`,
			`图片转换失败：${(e as Error)?.message ?? String(e)}`,
		));
	}
}

async function editExternally(resource?: vs.Uri): Promise<void> {
	const uri = activeImageUri(resource);
	if (!uri) {
		void vs.window.showWarningMessage(localize('Select or open an image first.', '请先选择或打开一张图片。'));
		return;
	}
	await vs.env.openExternal(uri);
}

async function configureImageMagickPath(): Promise<void> {
	const picked = await vs.window.showOpenDialog({
		canSelectFiles: true,
		canSelectFolders: false,
		canSelectMany: false,
		openLabel: localize('Use ImageMagick', '使用 ImageMagick'),
		title: localize('Select the ImageMagick executable', '选择 ImageMagick 可执行文件'),
	});
	if (!picked?.[0]) return;
	await vs.workspace.getConfiguration('stellarisLanguageServices.ai').update('imageMagickPath', picked[0].fsPath, vs.ConfigurationTarget.Global);
}

async function checkImageMagick(): Promise<void> {
	try {
		const { stdout } = await execFileAsync(imageMagickBin(), ['--version'], { timeout: 10000, windowsHide: true });
		const firstLine = stdout.split(/\r?\n/)[0] ?? imageMagickBin();
		await vs.window.showInformationMessage(localize(`ImageMagick available: ${firstLine}`, `ImageMagick 可用：${firstLine}`));
	} catch {
		await vs.window.showWarningMessage(localize(
			`ImageMagick was not found at "${imageMagickBin()}". Configure the executable path or add it to PATH.`,
			`未在 "${imageMagickBin()}" 找到 ImageMagick。请配置可执行文件路径或将其加入 PATH。`,
		));
	}
}

export function registerImageTools(context: vs.ExtensionContext): void {
	context.subscriptions.push(
		vs.commands.registerCommand('cwtools.images.convertToPng', (resource?: vs.Uri) => convertToPng(resource)),
		vs.commands.registerCommand('cwtools.images.convertToDds', (resource?: vs.Uri) => convertToDds(resource)),
		vs.commands.registerCommand('cwtools.images.editExternally', (resource?: vs.Uri) => editExternally(resource)),
		vs.commands.registerCommand('cwtools.images.configureImageMagickPath', configureImageMagickPath),
		vs.commands.registerCommand('cwtools.images.checkImageMagick', checkImageMagick),
	);
}
