import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { fail } from './questions';

const MIB = 1024 * 1024;
const bodyError =
	"'State' / 'Questions' / 'Input Binary Fields': JSON request body must be smaller than 4 MiB, including base64 images. Resize images or shorten the state.";
function metadataBytes(size: string | undefined): number | undefined {
	if (!size) return undefined;
	const match = /^\s*(\d+(?:\.\d+)?)\s*(b|bytes?|kb|mb|gb|kib|mib|gib)?\s*$/i.exec(size);
	if (!match) return undefined;
	const multipliers: Record<string, number> = {
		b: 1,
		byte: 1,
		bytes: 1,
		kb: 1000,
		mb: 1000000,
		gb: 1000000000,
		kib: 1024,
		mib: MIB,
		gib: 1024 * MIB,
	};
	return Number(match[1]) * multipliers[(match[2] || 'b').toLowerCase()];
}
function matchesMagic(buffer: Buffer, mime: string): boolean {
	if (mime === 'image/png')
		return (
			buffer.length >= 4 &&
			buffer[0] === 0x89 &&
			buffer[1] === 0x50 &&
			buffer[2] === 0x4e &&
			buffer[3] === 0x47
		);
	if (mime === 'image/jpeg')
		return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
	return (
		mime === 'image/webp' &&
		buffer.length >= 12 &&
		buffer.toString('ascii', 0, 4) === 'RIFF' &&
		buffer.toString('ascii', 8, 12) === 'WEBP'
	);
}
export async function attachImages(
	context: IExecuteFunctions,
	index: number,
	body: IDataObject,
	names: string[],
	openRouter: boolean,
): Promise<void> {
	const limit = openRouter ? 4 : 8;
	if (names.length > limit)
		fail(
			context,
			index,
			`'Input Binary Fields': ${openRouter ? 'OpenRouter' : 'Nace'}: At most ${limit} images are allowed per request`,
		);
	const entries = names.map((name) => {
		const binary = context.helpers.assertBinaryData(index, name);
		if (!['image/png', 'image/jpeg', 'image/webp'].includes(binary.mimeType))
			fail(
				context,
				index,
				`'Input Binary Fields': Image ${name}: only PNG, JPEG, or WebP is supported`,
			);
		const size = metadataBytes(binary.fileSize);
		if (size !== undefined && size > 16 * MIB)
			fail(context, index, `'Input Binary Fields': Image ${name} exceeds the 16 MiB limit`);
		return { name, mime: binary.mimeType, size };
	});
	if (entries.reduce((sum, entry) => sum + (entry.size || 0), 0) > 32 * MIB)
		fail(context, index, "'Input Binary Fields': Images exceed the 32 MiB total limit");
	const baseBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
	const projectedBase64 = entries.reduce(
		(sum, entry) => sum + (entry.size === undefined ? 0 : 4 * Math.ceil(entry.size / 3)),
		0,
	);
	if (baseBytes + projectedBase64 >= 4 * MIB) fail(context, index, bodyError);
	const state = body.state;
	const images: string[] = [];
	let total = 0;
	let encodedBytes = 0;
	for (const entry of entries) {
		const buffer = await context.helpers.getBinaryDataBuffer(index, entry.name);
		if (buffer.length > 16 * MIB)
			fail(context, index, `'Input Binary Fields': Image ${entry.name} exceeds the 16 MiB limit`);
		total += buffer.length;
		if (total > 32 * MIB)
			fail(context, index, "'Input Binary Fields': Images exceed the 32 MiB total limit");
		encodedBytes += 4 * Math.ceil(buffer.length / 3);
		if (baseBytes + encodedBytes >= 4 * MIB) fail(context, index, bodyError);
		if (!matchesMagic(buffer, entry.mime))
			fail(
				context,
				index,
				`'Input Binary Fields': Image ${entry.name}: content does not match its PNG, JPEG, or WebP MIME type`,
			);
		images.push(`data:${entry.mime};base64,${buffer.toString('base64')}`);
		if (openRouter)
			body.state = [
				{ type: 'text', text: typeof state === 'string' ? state : JSON.stringify(state) },
				...images.map((url) => ({ type: 'image_url', image_url: { url } })),
			];
		else body.images = images;
		if (Buffer.byteLength(JSON.stringify(body), 'utf8') >= 4 * MIB) fail(context, index, bodyError);
	}
	if (baseBytes >= 4 * MIB) fail(context, index, bodyError);
}
