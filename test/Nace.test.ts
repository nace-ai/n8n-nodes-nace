import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Test-only PNG generation; excluded from the build and published package.
import { deflateSync } from 'node:zlib';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Test-only verification of local package artifacts; never runs in n8n.
import { readFileSync, readdirSync } from 'node:fs';
import type {
	IExecuteFunctions,
	IDataObject,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, NodeHelpers, Expression } from 'n8n-workflow';
import { Nace } from '../nodes/Nace/Nace.node';
import { NaceApi } from '../credentials/NaceApi.credentials';
import { CLIENT, VERSION } from '../nodes/Nace/constants';
import { getModels } from '../nodes/Nace/api';

const noul = { type: 'noul', instructions: '', criteria: { true: 'Approved', false: 'Rejected' } };
const choice = {
	type: 'choice',
	instructions: 'Pick a category',
	criteria: { billing: null, support: 'Technical help' },
};
const score = { type: 'score', instructions: 'Rate urgency', criteria: ['Low', 'High'] };
const answerSet = {
	noul: { type: 'noul', noul: 0.95, confidence: 0.9 },
	choice: {
		type: 'choice',
		choice: 'support',
		confidence: 0.9,
		probabilities: { billing: 0.1, support: 0.9 },
	},
	score: {
		type: 'score',
		score: 0.8,
		legend: ['Low', 'High'],
		confidence: 0.8,
		probabilities: { '0': 0.2, '1': 0.8 },
	},
};
function response(
	answers: unknown = { approved: answerSet.noul },
	statusCode = 200,
	headers: object = {},
	extra: object = {},
) {
	return {
		statusCode,
		headers,
		body: {
			answers,
			model: 'drex-v2.0',
			usage: { input_tokens: 10, output_tokens: 3 },
			request_id: 'req-test',
			evaluation_time_ms: 25,
			...extra,
		},
	};
}
function fake(
	params: Record<string, unknown> = {},
	credentials: object = {},
	items: INodeExecutionData[] = [{ json: { ticket: 'Help', original: true } }],
	buffers: Record<string, Buffer> = {},
) {
	const values: Record<string, unknown> = {
		operation: 'evaluate',
		model: 'drex-v2.0',
		stateFormat: 'text',
		stateText: 'Synthetic text',
		questionsMode: 'json',
		questionsJson: JSON.stringify({ approved: noul }),
		...params,
	};
	const http = vi.fn().mockResolvedValue(response());
	const context = {
		getInputData: () => items,
		getNode: () => ({
			id: 'test',
			name: 'Drex by Nace',
			type: 'n8n-nodes-nace.nace',
			typeVersion: 1,
			position: [0, 0],
			parameters: values,
		}),
		getNodeParameter: (path: string, index: number, fallback: unknown) => {
			let result: unknown = values;
			for (const key of path.split('.'))
				result =
					result && typeof result === 'object'
						? (result as Record<string, unknown>)[key]
						: undefined;
			return typeof result === 'function' ? result(index) : (result ?? fallback);
		},
		getCredentials: vi.fn().mockResolvedValue({
			backend: 'nace',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://openrouter.ai/api',
			apiKey: 'synthetic-nace-test-key',
			...credentials,
		}),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: http,
			assertBinaryData: vi.fn((index: number, name: string) => {
				const binary = items[index].binary?.[name];
				if (!binary) throw new Error(`Missing binary property ${name}`);
				return binary;
			}),
			getBinaryDataBuffer: vi.fn(async (_index: number, name: string) => buffers[name]),
		},
	};
	return {
		context: context as unknown as IExecuteFunctions,
		http,
		raw: context,
		run: () => new Nace().execute.call(context as unknown as IExecuteFunctions),
	};
}
function body(http: ReturnType<typeof vi.fn>, call = 0) {
	return http.mock.calls[call][1].body;
}
function evaluateMetadata(expression: string, parameters: object = {}, credentials: object = {}) {
	// eslint-disable-next-line @n8n/community-nodes/no-dangerous-functions -- Test evaluates only package-owned metadata expressions, without user code.
	return new Function('$parameter', '$credentials', `return ${expression.slice(3, -2)}`)(
		parameters,
		credentials,
	);
}
// Generate actual 1x1 RGB PNGs with valid chunk CRCs, using only Node built-ins.
function png(red: number, green: number, blue: number) {
	function chunk(type: string, data: Buffer) {
		const payload = Buffer.concat([Buffer.from(type), data]);
		let crc = 0xffffffff;
		for (const byte of payload) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([length, payload, checksum]);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.from([0, red, green, blue]))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}
const red = png(255, 0, 0),
	blue = png(0, 0, 255);
const imageItem = {
	json: {},
	binary: { red: { data: '', mimeType: 'image/png' }, blue: { data: '', mimeType: 'image/png' } },
};

afterEach(() => vi.useRealTimers());
describe('typed evaluation', () => {
	for (const model of ['drex-v2.0', 'drex-max']) {
		for (const [type, question] of Object.entries({ noul, choice, score })) {
			it(`${type} on ${model} preserves the full answer and metadata`, async () => {
				const f = fake({ model, questionsJson: JSON.stringify({ [type]: question }) });
				const expected = { [type]: answerSet[type as keyof typeof answerSet] };
				f.http.mockResolvedValue(response(expected, 200, {}, { model }));
				const result = await f.run();
				expect(body(f.http)).toEqual({
					model,
					state: 'Synthetic text',
					questions: { [type]: question },
				});
				expect(result[0][0]).toMatchObject({
					json: {
						answers: expected,
						model,
						usage: { input_tokens: 10, output_tokens: 3 },
						request_id: 'req-test',
						evaluation_time_ms: 25,
					},
					pairedItem: { item: 0 },
				});
			});
		}
	}
	it('batches mixed questions in a single request', async () => {
		const f = fake({ questionsJson: { noul, choice, score } });
		f.http.mockResolvedValue(response(answerSet));
		expect((await f.run())[0][0].json.answers).toEqual(answerSet);
		expect(f.http).toHaveBeenCalledTimes(1);
		expect(body(f.http).questions).toEqual({ noul, choice, score });
	});
	it('normalizes missing instructions and null choice descriptions in JSON mode', async () => {
		const f = fake({
			questionsJson: {
				a: { type: 'noul', criteria: { true: 'Yes' } },
				b: { type: 'choice', criteria: { a: null, b: '' } },
			},
		});
		await f.run();
		expect(body(f.http).questions).toEqual({
			a: { type: 'noul', instructions: '', criteria: { true: 'Yes' } },
			b: { type: 'choice', instructions: '', criteria: { a: null, b: null } },
		});
	});
	it('builds all three question types from fixed collections', async () => {
		const f = fake({
			questionsMode: 'ui',
			questions: {
				question: [
					{ id: 'a', type: 'noul', trueMeaning: 'Allowed' },
					{
						id: 'b',
						type: 'choice',
						choices: { choice: [{ label: 'yes' }, { label: 'no', description: 'Denied' }] },
					},
					{
						id: 'c',
						type: 'score',
						levels: { level: [{ description: 'Low' }, { description: 'High' }] },
					},
				],
			},
		});
		await f.run();
		expect(body(f.http).questions).toEqual({
			a: { type: 'noul', instructions: '', criteria: { true: 'Allowed' } },
			b: { type: 'choice', instructions: '', criteria: { yes: null, no: 'Denied' } },
			c: { type: 'score', instructions: '', criteria: ['Low', 'High'] },
		});
	});
	it.each(['classify', 'score'])('builds the %s shortcut', async (operation) => {
		const f = fake({
			operation,
			instructions: 'Test',
			labels: { label: [{ label: 'a' }, { label: 'b' }] },
			levels: { level: [{ description: 'Low' }, { description: 'High' }] },
		});
		await f.run();
		expect(body(f.http).questions).toEqual({
			[operation]: {
				type: operation === 'score' ? 'score' : 'choice',
				instructions: 'Test',
				criteria: operation === 'score' ? ['Low', 'High'] : { a: null, b: null },
			},
		});
	});
	it('supports JSON state, whole input and simplify with other input fields', async () => {
		const f = fake({
			stateFormat: 'json',
			stateJson: '{"sample":true}',
			options: { simplify: true, includeOtherFields: true },
		});
		f.http.mockResolvedValue(response(answerSet));
		const result = await f.run();
		expect(body(f.http).state).toEqual({ sample: true });
		expect(result[0][0].json).toMatchObject({
			original: true,
			answers: {
				choice: { value: 'support', confidence: 0.9 },
				score: { value: 0.8, confidence: 0.8 },
			},
			request_id: 'req-test',
		});
		const whole = fake({ stateFormat: 'inputItem' });
		await whole.run();
		expect(body(whole.http).state).toEqual({ ticket: 'Help', original: true });
	});
});

describe('images and limits', () => {
	it.each(['red', 'red,blue', 'blue,red'])(
		'keeps Image 1 first and subsequent images in property order: %s',
		async (order) => {
			const f = fake(
				{ model: 'drex-max', imageProperties: order, stateText: 'What colour is Image 1?' },
				{},
				[imageItem],
				{ red, blue },
			);
			await f.run();
			expect(body(f.http).images).toEqual(
				order
					.split(',')
					.map(
						(key) =>
							`data:image/png;base64,${{ red, blue }[key as 'red' | 'blue'].toString('base64')}`,
					),
			);
		},
	);
	it('refuses images on drex-v2.0 before any HTTP call', async () => {
		const f = fake({ imageProperties: 'red' }, {}, [imageItem], { red });
		await expect(f.run()).rejects.toThrow(NodeOperationError);
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each([
		['count', 'At most 8', Array(9).fill('red').join(','), { red }],
		['individual bytes', '16 MiB', 'red', { red: Buffer.alloc(16 * 1024 * 1024 + 1) }],
		[
			'total bytes',
			'32 MiB',
			'red,blue,red',
			{ red: Buffer.alloc(16 * 1024 * 1024), blue: Buffer.alloc(16 * 1024 * 1024) },
		],
		['body bytes', '4 MiB', 'red', { red: Buffer.alloc(3 * 1024 * 1024) }],
	] as const)('rejects %s before HTTP', async (_label, error, imageProperties, buffers) => {
		const f = fake({ model: 'drex-max', imageProperties }, {}, [imageItem], buffers);
		await expect(f.run()).rejects.toThrow(error);
		expect(f.http).not.toHaveBeenCalled();
	});
	it('rejects unsupported MIME types', async () => {
		const f = fake(
			{ model: 'drex-max', imageProperties: 'x' },
			{},
			[{ json: {}, binary: { x: { data: '', mimeType: 'image/gif' } } }],
			{ x: red },
		);
		await expect(f.run()).rejects.toThrow('PNG, JPEG, or WebP');
		expect(f.http).not.toHaveBeenCalled();
	});
	it('enforces 512 questions and the text body limit', async () => {
		const many = fake({
			questionsJson: Object.fromEntries(Array.from({ length: 513 }, (_, i) => [`q${i}`, noul])),
		});
		await expect(many.run()).rejects.toThrow('512');
		expect(many.http).not.toHaveBeenCalled();
		const huge = fake({ stateText: 'x'.repeat(4 * 1024 * 1024) });
		await expect(huge.run()).rejects.toThrow('4 MiB');
		expect(huge.http).not.toHaveBeenCalled();
	});
});

describe('errors, retries, and routing', () => {
	it('includes every 422 issue path and message and the request ID', async () => {
		const f = fake();
		f.http.mockResolvedValue({
			statusCode: 422,
			headers: {},
			body: {
				error: {
					type: 'invalid_request_error',
					message: 'Invalid request',
					issues: [
						{ path: ['questions', 'q', 'instructions'], message: 'Must be a string' },
						{ path: 'model', message: 'Unknown model' },
					],
				},
				request_id: 'req-422',
			},
		});
		try {
			await f.run();
			throw new Error('Expected failure');
		} catch (error) {
			expect(error).toBeInstanceOf(NodeApiError);
			expect((error as NodeApiError).description).toContain(
				'questions.q.instructions: Must be a string',
			);
			expect((error as NodeApiError).description).toContain('model: Unknown model');
			expect((error as NodeApiError).description).toContain('req-422');
		}
	});
	it.each([401, 402])('explains status %s', async (status) => {
		const f = fake();
		f.http.mockResolvedValue({
			statusCode: status,
			headers: {},
			body: { error: { message: 'No' }, request_id: 'id' },
		});
		await expect(f.run()).rejects.toThrow(
			status === 401 ? 'Invalid API key' : 'https://console.nace.ai',
		);
	});
	it.each([429, 529])('honours retry-after-ms for %s', async (status) => {
		vi.useFakeTimers();
		const f = fake({ options: { timeout: 12345 } });
		f.http
			.mockResolvedValueOnce(response({}, status, { 'Retry-After-Ms': '250', 'retry-after': '10' }))
			.mockResolvedValueOnce(response());
		const pending = f.run();
		await vi.advanceTimersByTimeAsync(249);
		expect(f.http).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(f.http).toHaveBeenCalledTimes(2);
		expect(f.http.mock.calls.map((call) => call[1].timeout)).toEqual([12345, 12345]);
	});
	it.each([
		{ headers: { 'retry-after': '2' }, delay: 2000 },
		{ headers: {}, delay: 2000 },
	])('falls back to seconds or exponential backoff', async ({ headers, delay }) => {
		vi.useFakeTimers();
		const f = fake();
		f.http.mockResolvedValueOnce(response({}, 429, headers));
		const pending = f.run();
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(f.http).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await pending;
		expect(f.http).toHaveBeenCalledTimes(2);
	});
	it('caps retries at ten and stops after exhaustion', async () => {
		vi.useFakeTimers();
		const f = fake({ options: { maxRetries: 99 } });
		f.http.mockResolvedValue(response({}, 529, { 'retry-after-ms': '1' }));
		const failure = expect(f.run()).rejects.toBeInstanceOf(NodeApiError);
		await vi.runAllTimersAsync();
		await failure;
		expect(f.http).toHaveBeenCalledTimes(11);
	});
	it.each([
		{ confidence: 0.9, expected: 1 },
		{ confidence: 0.2, expected: 2 },
		{ confidence: 0.5, expected: 1 },
	])('routes confidence $confidence to output $expected', async ({ confidence, expected }) => {
		const f = fake({
			operation: 'route',
			labels: { label: [{ label: 'billing' }, { label: 'support' }] },
			confidenceThreshold: 0.5,
		});
		f.http.mockResolvedValue(response({ route: { ...answerSet.choice, confidence } }));
		const result = await f.run();
		expect(result).toHaveLength(3);
		expect(result[expected]).toHaveLength(1);
		expect(result.flat()).toHaveLength(1);
		expect(result[expected][0].json.answers).toEqual({
			route: { ...answerSet.choice, confidence },
		});
	});
	it('routes errors to Unsure and continues processing later items', async () => {
		const f = fake({ operation: 'route', labels: { label: [{ label: 'support' }] } }, {}, [
			{ json: { n: 1 } },
			{ json: { n: 2 } },
		]);
		f.raw.continueOnFail = () => true;
		f.http
			.mockResolvedValueOnce(response({}, 422))
			.mockResolvedValueOnce(response({ route: answerSet.choice }));
		const result = await f.run();
		expect(result[1][0]).toMatchObject({ pairedItem: { item: 0 } });
		expect(result[1][0].error).toBeInstanceOf(NodeApiError);
		expect(result[0][0].pairedItem).toEqual({ item: 1 });
	});
	it('exposes dynamic output names matching configured label order', () => {
		const expression = new Nace().description.outputs as string;
		const evaluate = (parameter: object) => evaluateMetadata(expression, parameter);
		expect(
			evaluate({
				operation: 'route',
				labels: { label: [{ label: 'A' }, { label: 'B' }] },
			}),
		).toEqual([
			{ type: 'main', displayName: 'A' },
			{ type: 'main', displayName: 'B' },
			{ type: 'main', displayName: 'Unsure' },
		]);
	});
});

describe('credentials, models, and attribution', () => {
	it('keeps the version constant synchronized with package.json', () => {
		expect(VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
	});
	it('attributes every execution and uses the authenticated full-response helper', async () => {
		const f = fake();
		await f.run();
		expect(f.http).toHaveBeenCalledWith(
			'naceApi',
			expect.objectContaining({
				url: 'https://console.nace.ai/v1/systemone',
				timeout: 60000,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				headers: { 'User-Agent': CLIENT, 'X-Nace-Client': CLIENT },
			}),
		);
	});
	it('loads models, removes retired models, displays aliases and attributes GET requests', async () => {
		const f = fake();
		f.http.mockResolvedValue({
			statusCode: 200,
			headers: {},
			body: {
				models: [
					{ name: 'drex-v2.0' },
					{ name: 'drex-latest', alias_for: 'drex-v2.0' },
					{ name: 'old', retired: true },
					{ name: 'old2', status: 'retired' },
				],
			},
		});
		const models = await getModels.call(f.context as never);
		expect(models.map((m) => m.value)).toEqual(['drex-v2.0', 'drex-latest']);
		expect(models[1].name).toContain('alias of drex-v2.0');
		expect(f.http.mock.calls[0][1]).toMatchObject({
			method: 'GET',
			url: 'https://console.nace.ai/v1/models',
			headers: { 'User-Agent': CLIENT, 'X-Nace-Client': CLIENT },
		});
		expect(f.http.mock.calls[0][1]).not.toHaveProperty('qs');
	});
	it('requests all OpenRouter output modalities and displays names while filtering to Nace model IDs', async () => {
		const f = fake(
			{},
			{
				backend: 'openrouter',
				baseUrl: 'https://console.nace.ai',
				openRouterBaseUrl: 'https://openrouter.ai/api',
			},
		);
		f.http.mockResolvedValue({
			statusCode: 200,
			headers: {},
			body: {
				data: [
					{
						id: 'nace-ai/drex-max',
						name: 'Nace.AI: Drex Max',
						description: 'Drex decisions with images',
					},
					{
						id: 'nace-ai/drex-v2.0',
						name: 'Nace.AI: Drex v2.0',
						description: 'Fast text decisions',
					},
					{ id: 'nace-ai/drex-v1.5' },
					{ id: 'other-vendor/model', name: 'Another model' },
					{ id: 'nace-ai/retired', name: 'Old Drex', retired: true },
				],
			},
		});
		expect(await getModels.call(f.context as never)).toEqual([
			{
				name: 'Nace.AI: Drex Max',
				value: 'nace-ai/drex-max',
				description: 'Drex decisions with images',
			},
			{
				name: 'Nace.AI: Drex v2.0',
				value: 'nace-ai/drex-v2.0',
				description: 'Fast text decisions',
			},
			{ name: 'nace-ai/drex-v1.5', value: 'nace-ai/drex-v1.5', description: '' },
		]);
		expect(f.http.mock.calls[0][1]).toMatchObject({
			method: 'GET',
			url: 'https://openrouter.ai/api/v1/models',
			qs: { output_modalities: 'all' },
		});
		expect(f.http.mock.calls[0][1].headers).toMatchObject({
			'HTTP-Referer': 'https://nace.ai',
			'X-OpenRouter-Title': 'Drex for n8n',
		});
	});
	it('configures bearer credentials, visible base URLs, and attributed credential tests', async () => {
		const credential = new NaceApi();
		const authenticated = await credential.authenticate(
			{
				backend: 'nace',
				apiKey: 'synthetic',
				baseUrl: 'https://console.nace.ai',
				openRouterBaseUrl: 'https://openrouter.ai/api',
			},
			{
				url: 'https://console.nace.ai/v1/models',
				method: 'GET',
				headers: { 'X-Test': 'preserved' },
			},
		);
		expect(authenticated.headers).toEqual({
			Authorization: 'Bearer synthetic',
			'X-Test': 'preserved',
		});
		expect(credential.properties.find((p) => p.name === 'apiKey')?.typeOptions?.password).toBe(
			true,
		);
		expect(
			credential.properties
				.filter((p) => ['baseUrl', 'openRouterBaseUrl'].includes(p.name))
				.map((p) => [p.name, p.type, p.default]),
		).toEqual([
			['baseUrl', 'string', 'https://console.nace.ai'],
			['openRouterBaseUrl', 'string', 'https://openrouter.ai/api'],
		]);
		expect(credential.test.request).toMatchObject({
			url: expect.stringContaining('/v1/key'),
			headers: { 'User-Agent': CLIENT, 'X-Nace-Client': CLIENT },
		});
	});
	it.each(['nace-ai/drex-max', 'nace-ai/drex-max-v1.1'])(
		'uses OpenRouter image content parts for %s',
		async (model) => {
			const f = fake(
				{
					model,
					imageProperties: 'blue,red',
					stateFormat: 'json',
					stateJson: '{"prompt":"Describe Image 1"}',
				},
				{
					backend: 'openrouter',
					baseUrl: 'https://console.nace.ai',
					openRouterBaseUrl: 'https://openrouter.ai/api',
				},
				[imageItem],
				{ red, blue },
			);
			await f.run();
			expect(body(f.http)).not.toHaveProperty('images');
			expect(body(f.http).state).toEqual([
				{ type: 'text', text: '{"prompt":"Describe Image 1"}' },
				{
					type: 'image_url',
					image_url: { url: `data:image/png;base64,${blue.toString('base64')}` },
				},
				{
					type: 'image_url',
					image_url: { url: `data:image/png;base64,${red.toString('base64')}` },
				},
			]);
			expect(f.http.mock.calls[0][1]).toMatchObject({
				url: 'https://openrouter.ai/api/v1/systemone',
				headers: {
					'HTTP-Referer': 'https://nace.ai',
					'X-OpenRouter-Title': 'Drex for n8n',
					'User-Agent': CLIENT,
					'X-Nace-Client': CLIENT,
				},
			});
		},
	);
	it('supports OpenRouter v2 text and refuses its images', async () => {
		const f = fake(
			{ model: 'nace-ai/drex-v2.0' },
			{
				backend: 'openrouter',
				baseUrl: 'https://console.nace.ai',
				openRouterBaseUrl: 'https://openrouter.ai/api',
			},
		);
		await f.run();
		expect(body(f.http).state).toBe('Synthetic text');
		expect(body(f.http).questions.approved.instructions).toBe('');
		const invalid = fake(
			{ model: 'nace-ai/drex-v2.0', imageProperties: 'red' },
			{ backend: 'openrouter' },
			[imageItem],
			{ red },
		);
		await expect(invalid.run()).rejects.toThrow('drex-max');
		expect(invalid.http).not.toHaveBeenCalled();
	});
});

it('ships importable workflow JSON examples without credential IDs or keys', () => {
	const files = readdirSync('examples');
	expect(files).toHaveLength(3);
	for (const file of files) {
		const workflow = JSON.parse(readFileSync(`examples/${file}`, 'utf8'));
		expect(workflow.nodes.length).toBeGreaterThan(1);
		for (const node of workflow.nodes)
			for (const credential of Object.values(node.credentials || {}) as IDataObject[])
				expect(Object.keys(credential)).toEqual(['name']);
	}
});

describe('review regressions', () => {
	it.each(['nace', 'openrouter'])(
		'isolates stored backend URLs for %s requests, model loading, and credential tests',
		async (backend) => {
			const credentials = {
				backend,
				baseUrl: 'https://nace.example.test/',
				openRouterBaseUrl: 'https://gateway.openrouter.ai/api/',
			};
			const expectedBase =
				backend === 'nace' ? 'https://nace.example.test' : 'https://gateway.openrouter.ai/api';
			const f = fake({}, credentials);
			await f.run();
			expect(f.http.mock.calls[0][1].url).toBe(`${expectedBase}/v1/systemone`);
			f.http.mockResolvedValue({ statusCode: 200, headers: {}, body: { models: [] } });
			await getModels.call(f.context as never);
			expect(f.http.mock.calls[1][1].url).toBe(`${expectedBase}/v1/models`);
			const test = new NaceApi().test.request;
			expect(evaluateMetadata(test.baseURL as string, {}, credentials)).toBe(expectedBase);
			expect(evaluateMetadata(test.url as string, {}, credentials)).toBe(
				backend === 'nace' ? '/v1/models' : '/v1/key',
			);
		},
	);
	it('uses only the OpenRouter default when its selected URL field is absent', async () => {
		const f = fake(
			{},
			{ backend: 'openrouter', baseUrl: 'https://console.nace.ai', openRouterBaseUrl: undefined },
		);
		await f.run();
		expect(f.http.mock.calls[0][1].url).toBe('https://openrouter.ai/api/v1/systemone');
		const request = new NaceApi().test.request;
		expect(
			evaluateMetadata(
				request.baseURL as string,
				{},
				{ backend: 'openrouter', baseUrl: 'https://console.nace.ai' },
			),
		).toBe('https://openrouter.ai/api');
	});
	it('always exposes Unsure and fixes only Route label names while allowing description expressions', () => {
		const properties = new Nace().description.properties;
		expect(properties.some((property) => property.name === 'unsureOutput')).toBe(false);
		const labels = properties.find(
			(property) =>
				property.name === 'labels' && property.displayOptions?.show?.operation?.includes('route'),
		)!;
		const fields = (labels.options![0] as { values: typeof properties }).values;
		expect(fields.find((field) => field.name === 'label')?.noDataExpression).toBe(true);
		expect(fields.find((field) => field.name === 'description')?.noDataExpression).not.toBe(true);
		const outputs = evaluateMetadata(new Nace().description.outputs as string, {
			operation: 'route',
			labels: { label: [{ label: 'support' }] },
		});
		expect(outputs.map((output: { displayName: string }) => output.displayName)).toEqual([
			'support',
			'Unsure',
		]);
	});
	it('rejects zero Route labels before HTTP and can return a paired continued error', async () => {
		const f = fake({ operation: 'route', labels: { label: [] } });
		await expect(f.run()).rejects.toThrow('Route requires at least one label');
		expect(f.http).not.toHaveBeenCalled();
		f.raw.continueOnFail = () => true;
		const result = await f.run();
		expect(result[0][0]).toMatchObject({
			json: { error: 'Route requires at least one label' },
			pairedItem: { item: 0 },
		});
	});
	it('rejects imported expression label names before HTTP', async () => {
		const f = fake({ operation: 'route', labels: { label: [{ label: '={{ $json.label }}' }] } });
		await expect(f.run()).rejects.toThrow('Route label names must be fixed values');
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each(['options', 'labels.label'])(
		'continues with a paired error when per-item %s resolution fails',
		async (path) => {
			const f = fake({ operation: 'route', labels: { label: [{ label: 'support' }] } }, {}, [
				{ json: { n: 1 } },
				{ json: { n: 2 } },
			]);
			const getParameter = f.raw.getNodeParameter;
			f.raw.getNodeParameter = (name, index, fallback) => {
				if (name === path && index === 0) throw new Error(`${path} expression failed`);
				return getParameter(name, index, fallback);
			};
			f.raw.continueOnFail = () => true;
			f.http.mockResolvedValue(response({ route: answerSet.choice }));
			const result = await f.run();
			expect(result[1][0]).toMatchObject({
				json: { error: `${path} expression failed` },
				pairedItem: { item: 0 },
			});
			expect(result[0][0].pairedItem).toEqual({ item: 1 });
			expect(f.http).toHaveBeenCalledTimes(1);
		},
	);
	it('keeps per-item label descriptions consistent between questions and routing', async () => {
		const f = fake(
			{
				operation: 'route',
				labels: { label: [{ label: 'support', description: '={{ $json.description }}' }] },
			},
			{},
			[{ json: {} }, { json: {} }],
		);
		const getParameter = f.raw.getNodeParameter;
		f.raw.getNodeParameter = (name, index, fallback) =>
			name === 'labels.label'
				? [{ label: 'support', description: `Description ${index}` }]
				: getParameter(name, index, fallback);
		f.http.mockResolvedValue(response({ route: answerSet.choice }));
		const result = await f.run();
		expect(result[0]).toHaveLength(2);
		expect(body(f.http, 0).questions.route.criteria).toEqual({ support: 'Description 0' });
		expect(body(f.http, 1).questions.route.criteria).toEqual({ support: 'Description 1' });
	});
	it('always places continued Route errors on Unsure and preserves the marker for n8n Error output handling', async () => {
		const f = fake({
			operation: 'route',
			labels: { label: [{ label: 'billing' }, { label: 'support' }] },
		});
		f.raw.continueOnFail = () => true;
		f.http.mockResolvedValue(response({}, 422));
		const result = await f.run();
		const error = result[2][0];
		expect(error.error).toBeInstanceOf(NodeApiError);
		expect(error.json.error).toBeTruthy();
		expect(error.pairedItem).toEqual({ item: 0 });
		expect(result.flat()).toHaveLength(1);
		// n8n-core 2.46.5 handleNodeErrorOutput scans every main output for this marker.
		const configuredNode = { ...f.raw.getNode(), onError: 'continueErrorOutput' as const };
		const description = new Nace().description;
		const workflow = {
			expression: {
				getSimpleParameterValue: () =>
					evaluateMetadata(description.outputs as string, configuredNode.parameters),
			},
		};
		const outputs = NodeHelpers.getNodeOutputs(
			workflow as never,
			configuredNode as never,
			description,
		);
		expect(outputs.at(-1)).toMatchObject({ category: 'error', displayName: 'Error' });
		expect(outputs).toHaveLength(result.length + 1);
	});
	it.each([0.9, 0.1])(
		'returns Route tool results on output 0 for confidence %s',
		async (confidence) => {
			const f = fake({
				operation: 'route',
				labels: { label: [{ label: 'billing' }, { label: 'support' }] },
				confidenceThreshold: 0.5,
			});
			const getNode = f.raw.getNode;
			f.raw.getNode = () => ({ ...getNode(), type: 'n8n-nodes-nace.naceTool' });
			f.http.mockResolvedValue(response({ route: { ...answerSet.choice, confidence } }));
			const result = await f.run();
			expect(result).toHaveLength(1);
			expect(result[0][0].json).toMatchObject({
				routeLabel: confidence < 0.5 ? 'Unsure' : 'support',
				answers: { route: { choice: 'support', confidence } },
			});
		},
	);
	it('collects multiple Route tool decisions on output 0 in input order', async () => {
		const f = fake(
			{ operation: 'route', labels: { label: [{ label: 'billing' }, { label: 'support' }] } },
			{},
			[{ json: {} }, { json: {} }, { json: {} }],
		);
		const getNode = f.raw.getNode;
		f.raw.getNode = () => ({ ...getNode(), type: 'n8n-nodes-nace.naceTool' });
		f.http
			.mockResolvedValueOnce(response({ route: { ...answerSet.choice, choice: 'billing' } }))
			.mockResolvedValueOnce(response({ route: answerSet.choice }))
			.mockResolvedValueOnce(response({ route: { ...answerSet.choice, confidence: 0.1 } }));
		const result = await f.run();
		expect(result).toHaveLength(1);
		expect(result[0].map((item) => item.json.routeLabel)).toEqual(['billing', 'support', 'Unsure']);
		expect(result[0].map((item) => item.pairedItem)).toEqual([
			{ item: 0 },
			{ item: 1 },
			{ item: 2 },
		]);
	});
	it('keeps continued tool errors on output 0 too', async () => {
		const f = fake({
			operation: 'route',
			labels: { label: [{ label: 'billing' }, { label: 'support' }] },
		});
		const getNode = f.raw.getNode;
		f.raw.getNode = () => ({ ...getNode(), type: 'n8n-nodes-nace.naceTool' });
		f.raw.continueOnFail = () => true;
		f.http.mockResolvedValue(response({}, 422));
		const result = await f.run();
		expect(result).toHaveLength(1);
		expect(result[0][0].error).toBeInstanceOf(NodeApiError);
	});
	it.each([false, true])(
		'redacts echoed credential values from API errors and continued results (continue=%s)',
		async (continued) => {
			const syntheticCredential = 'synthetic-sensitive-key-123'; // gitleaks:allow (synthetic test value)
			const f = fake({}, { apiKey: syntheticCredential });
			f.raw.continueOnFail = () => continued;
			f.http.mockResolvedValue({
				statusCode: 422,
				headers: { 'x-request-id': `request-${syntheticCredential}` },
				body: {
					error: {
						type: `invalid-${syntheticCredential}`,
						message: `Bad request with ${syntheticCredential}`,
						issues: [
							{
								path: ['questions', syntheticCredential],
								message: `Rejected ${syntheticCredential}`,
							},
						],
					},
					proxy: { authorization: `Bearer ${syntheticCredential}` },
				},
			});
			if (continued) {
				const result = await f.run();
				expect(JSON.stringify(result)).not.toContain(syntheticCredential);
				expect(result[0][0].json).toMatchObject({
					error: 'Bad request with [REDACTED]',
					description: expect.stringContaining('questions.[REDACTED]: Rejected [REDACTED]'),
				});
			} else {
				await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
					expect(error.message).toBe('Bad request with [REDACTED]');
					expect(error.description).toContain('questions.[REDACTED]: Rejected [REDACTED]');
					expect(JSON.stringify(error)).not.toContain(syntheticCredential);
					return true;
				});
			}
		},
	);
	it('redacts proxy transport errors including nested causes and stack messages', async () => {
		const syntheticCredential = 'synthetic-transport-secret';
		const f = fake({}, { apiKey: syntheticCredential });
		const error = Object.assign(new Error(`Proxy rejected ${syntheticCredential}`), {
			cause: {
				message: `Bearer ${syntheticCredential}`,
				issues: [{ message: syntheticCredential }],
			},
		});
		f.http.mockRejectedValue(error);
		f.raw.continueOnFail = () => true;
		const result = await f.run();
		expect(JSON.stringify(result)).not.toContain(syntheticCredential);
		expect(result[0][0].json.error).toContain('[REDACTED]');
	});
	it('preserves configured input fields and binaries even when options resolution fails', async () => {
		const f = fake({ options: { includeOtherFields: true } }, {}, [
			{ ...imageItem, json: { original: true } },
		]);
		const getParameter = f.raw.getNodeParameter;
		f.raw.getNodeParameter = (name, index, fallback) => {
			if (name === 'options') throw new Error('Invalid timeout expression');
			return getParameter(name, index, fallback);
		};
		f.raw.continueOnFail = () => true;
		const result = await f.run();
		expect(result[0][0]).toMatchObject({
			json: { original: true, error: 'Invalid timeout expression' },
			binary: imageItem.binary,
			pairedItem: { item: 0 },
		});
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each([true, false])(
		'retains binaries on continued errors only when Include Other Input Fields=%s',
		async (includeOtherFields) => {
			const f = fake({ options: { includeOtherFields } }, {}, [imageItem]);
			f.http.mockResolvedValue(response({}, 422));
			f.raw.continueOnFail = () => true;
			const result = await f.run();
			expect(result[0][0].binary).toEqual(includeOtherFields ? imageItem.binary : undefined);
		},
	);
	it.each([
		{ headers: { 'retry-after-ms': '1000000000' }, wait: 60000, calls: 3 },
		{ headers: { 'retry-after': '1000000' }, wait: 60000, calls: 3 },
		{ headers: { 'retry-after-ms': '50000' }, wait: 50000, calls: 4 },
	])(
		'caps each retry wait and total sleep and returns the last error: $headers',
		async ({ headers, wait, calls }) => {
			vi.useFakeTimers();
			const f = fake({ options: { maxRetries: 10, timeout: 43210 } });
			let attempts = 0;
			f.http.mockImplementation(async () => ({
				statusCode: 529,
				headers,
				body: { error: { message: `Attempt ${++attempts}` } },
			}));
			const failure = expect(f.run()).rejects.toThrow(`Attempt ${calls}`);
			await vi.advanceTimersByTimeAsync(wait - 1);
			expect(f.http).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(f.http).toHaveBeenCalledTimes(2);
			await vi.advanceTimersByTimeAsync(120000 - wait - 1);
			expect(f.http).toHaveBeenCalledTimes(calls - 1);
			await vi.advanceTimersByTimeAsync(1);
			await failure;
			expect(f.http).toHaveBeenCalledTimes(calls);
			expect(f.http.mock.calls.map((call) => call[1].timeout)).toEqual(Array(calls).fill(43210));
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});

describe('backend and permanent Unsure regressions', () => {
	it.each([
		{
			backend: 'nace',
			baseUrl: 'https://openrouter.ai/api',
			openRouterBaseUrl: 'https://openrouter.ai/api',
		},
		{
			backend: 'nace',
			baseUrl: 'https://api.openrouter.ai/api',
			openRouterBaseUrl: 'https://openrouter.ai/api',
		},
		{
			backend: 'nace',
			baseUrl: 'https://OPENROUTER.AI./api',
			openRouterBaseUrl: 'https://openrouter.ai/api',
		},
		{
			backend: 'nace',
			baseUrl: 'https://notopenrouter.ai/api',
			openRouterBaseUrl: 'https://openrouter.ai/api',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://console.nace.ai',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://openrouter.ai.evil.test/api',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://notopenrouter.ai/api',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://openrouter.ai@evil.test/api',
		},
	])(
		'refuses an incompatible selected host before execution, model loading, or credential-test authentication: $backend / $baseUrl / $openRouterBaseUrl',
		async (credentials) => {
			const f = fake({}, credentials);
			const expectedMessage =
				credentials.backend === 'nace'
					? 'Nace Base URL must not use an openrouter.ai host'
					: 'OpenRouter Base URL must use openrouter.ai or a subdomain of openrouter.ai';
			await expect(f.run()).rejects.toBeInstanceOf(NodeOperationError);
			await expect(f.run()).rejects.toThrow(expectedMessage);
			await expect(getModels.call(f.context as never)).rejects.toThrow(expectedMessage);
			const credential = new NaceApi();
			const testBaseUrl = evaluateMetadata(
				credential.test.request.baseURL as string,
				{},
				credentials,
			);
			const testPath = evaluateMetadata(credential.test.request.url as string, {}, credentials);
			await expect(
				credential.authenticate(credentials, { url: testBaseUrl + testPath, method: 'GET' }),
			).rejects.toBeInstanceOf(NodeOperationError);
			expect(f.http).not.toHaveBeenCalled();
		},
	);
	it.each([
		{
			backend: 'nace',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://unused.example.test/api',
			expected: 'https://console.nace.ai',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://openrouter.ai/api',
			openRouterBaseUrl: 'https://openrouter.ai/api',
			expected: 'https://openrouter.ai/api',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: 'https://gateway.openrouter.ai/api',
			expected: 'https://gateway.openrouter.ai/api',
		},
	])(
		'ignores the other stored URL and accepts only the selected backend host: $backend / $expected',
		async ({ expected, ...credentials }) => {
			const f = fake({}, credentials);
			await f.run();
			expect(f.http.mock.calls[0][1].url).toBe(`${expected}/v1/systemone`);
			const credential = new NaceApi();
			expect(evaluateMetadata(credential.test.request.baseURL as string, {}, credentials)).toBe(
				expected,
			);
			await expect(
				credential.authenticate(credentials, { url: expected + '/v1/models', method: 'GET' }),
			).resolves.toMatchObject({ url: expected + '/v1/models' });
		},
	);
	it.each([
		{
			backend: 'nace',
			baseUrl: undefined,
			openRouterBaseUrl: 'https://openrouter.ai/api',
			expected: 'https://console.nace.ai',
		},
		{
			backend: 'nace',
			baseUrl: '',
			openRouterBaseUrl: 'https://openrouter.ai/api',
			expected: 'https://console.nace.ai',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: undefined,
			expected: 'https://openrouter.ai/api',
		},
		{
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
			openRouterBaseUrl: '',
			expected: 'https://openrouter.ai/api',
		},
	])(
		'uses its own default without cross-field fallback: $backend / $baseUrl / $openRouterBaseUrl',
		async ({ expected, ...credentials }) => {
			const f = fake({}, credentials);
			await f.run();
			expect(f.http.mock.calls[0][1].url).toBe(`${expected}/v1/systemone`);
			const credential = new NaceApi();
			expect(evaluateMetadata(credential.test.request.baseURL as string, {}, credentials)).toBe(
				expected,
			);
		},
	);
	it('always sends Route errors to the final Unsure output, even at threshold 0', async () => {
		const f = fake({
			operation: 'route',
			labels: { label: [{ label: 'billing' }, { label: 'support' }] },
			confidenceThreshold: 0,
		});
		f.raw.continueOnFail = () => true;
		f.http.mockResolvedValue(response({}, 422));
		const result = await f.run();
		expect(result).toHaveLength(3);
		expect(result[0]).toEqual([]);
		expect(result[1]).toEqual([]);
		expect(result[2][0]).toMatchObject({
			pairedItem: { item: 0 },
			error: expect.any(NodeApiError),
		});
	});
	it('uses threshold 0 to keep low-confidence decisions on their label output', async () => {
		const f = fake({
			operation: 'route',
			labels: { label: [{ label: 'billing' }, { label: 'support' }] },
			confidenceThreshold: 0,
		});
		f.http.mockResolvedValue(response({ route: { ...answerSet.choice, confidence: 0 } }));
		const result = await f.run();
		expect(result).toHaveLength(3);
		expect(result[1][0].json.routeLabel).toBe('support');
		expect(result[2]).toEqual([]);
	});
	it('resolves Classify label expressions per input item using the n8n expression evaluator', async () => {
		const labels = new Nace().description.properties.find(
			(property) =>
				property.name === 'labels' &&
				property.displayOptions?.show?.operation?.includes('classify'),
		)!;
		const fields = (labels.options![0] as { values: INodeProperties[] }).values;
		expect(fields.find((field) => field.name === 'label')?.noDataExpression).not.toBe(true);
		const items = [{ json: { label: 'billing' } }, { json: { label: 'support' } }];
		const configured = [
			{ label: '={{ $json.label }}', description: 'Dynamic label' },
			{ label: 'other' },
		];
		const f = fake({ operation: 'classify', labels: { label: configured } }, {}, items);
		const expression = new Expression('UTC');
		const getParameter = f.raw.getNodeParameter;
		f.raw.getNodeParameter = (path, index, fallback) =>
			path === 'labels.label'
				? configured.map((entry) => ({
						...entry,
						label: expression.resolveSimpleParameterValue(entry.label, {
							$json: items[index].json,
						} as never),
					}))
				: getParameter(path, index, fallback);
		f.http
			.mockResolvedValueOnce(response({ classify: { ...answerSet.choice, choice: 'billing' } }))
			.mockResolvedValueOnce(response({ classify: answerSet.choice }));
		const result = await f.run();
		expect(body(f.http, 0).questions.classify.criteria).toEqual({
			billing: 'Dynamic label',
			other: null,
		});
		expect(body(f.http, 1).questions.classify.criteria).toEqual({
			support: 'Dynamic label',
			other: null,
		});
		expect(result[0].map((item) => (item.json.answers as IDataObject).classify)).toEqual([
			{ ...answerSet.choice, choice: 'billing' },
			answerSet.choice,
		]);
		expect(result[0].map((item) => item.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
	});
});

describe.each(['nace', 'openrouter'])('%s response metadata', (backend) => {
	const idCases = [
		{
			request_id: 'req-body',
			headers: { 'X-Request-Id': 'req-header' },
			id: 'gen-dec-body',
			expected: 'req-body',
		},
		{
			request_id: null,
			headers: { 'X-Request-Id': 'req-header' },
			id: 'gen-dec-body',
			expected: 'req-header',
		},
		{
			request_id: undefined,
			headers: {},
			id: 'gen-dec-body',
			expected: backend === 'openrouter' ? 'gen-dec-body' : undefined,
		},
		{
			request_id: null,
			headers: {},
			id: 'gen-dec-body',
			expected: backend === 'openrouter' ? 'gen-dec-body' : undefined,
		},
	];
	it.each(idCases)(
		'selects request_id=$expected and preserves usage costs, provider, and score legend',
		async ({ request_id, headers, id, expected }) => {
			const f = fake({ questionsJson: { score } }, { backend });
			const usage = {
				input_tokens: 17,
				output_tokens: 4,
				cost: 0.000017,
				cost_details: { upstream_inference_cost: 0.000017 },
			};
			const legend = backend === 'openrouter' ? { '0': 'Low', '1': 'High' } : ['Low', 'High'];
			const answer = { ...answerSet.score, legend };
			f.http.mockResolvedValue(
				response({ score: answer }, 200, headers, {
					request_id,
					id,
					usage,
					provider: 'Synthetic provider',
				}),
			);
			const output = (await f.run())[0][0].json;
			expect(output.request_id).toBe(expected);
			expect(output.id).toBe(id);
			expect(output.usage).toEqual(usage);
			expect(output.provider).toBe('Synthetic provider');
			expect(output.answers).toEqual({ score: answer });
			expect(f.http.mock.calls[0][1]).not.toHaveProperty('qs');
		},
	);
	it.each(idCases)(
		'uses request_id=$expected in API error descriptions',
		async ({ request_id, headers, id, expected }) => {
			const f = fake({}, { backend });
			f.http.mockResolvedValue({
				statusCode: 422,
				headers,
				body: {
					request_id,
					id,
					error: {
						type: 'invalid_request_error',
						message: 'Invalid decision request',
						issues: [{ path: 'questions.score', message: 'Invalid criteria' }],
					},
				},
			});
			await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
				expect(error).toBeInstanceOf(NodeApiError);
				if (expected === undefined) expect(error.description).not.toContain('Request ID:');
				else expect(error.description).toContain(`Request ID: ${expected}`);
				expect(error.description).toContain('questions.score: Invalid criteria');
				return true;
			});
		},
	);
	it('redacts a credential echoed in the generation ID on a continued error', async () => {
		const syntheticCredential = 'synthetic-metadata-secret';
		const f = fake({}, { backend, apiKey: syntheticCredential });
		f.raw.continueOnFail = () => true;
		f.http.mockResolvedValue({
			statusCode: 422,
			headers: {},
			body: { id: `gen-dec-${syntheticCredential}`, error: { message: 'Invalid request' } },
		});
		const result = await f.run();
		if (backend === 'openrouter')
			expect(result[0][0].json.description).toContain('Request ID: gen-dec-[REDACTED]');
		else expect(result[0][0].json.description || '').not.toContain('Request ID:');
		expect(JSON.stringify(result)).not.toContain(syntheticCredential);
	});
	it('keeps usage costs when Simplify is enabled', async () => {
		const f = fake({ options: { simplify: true } }, { backend });
		const usage = { input_tokens: 2, output_tokens: 1, cost: 0.000002 };
		f.http.mockResolvedValue(
			response(undefined, 200, {}, { request_id: null, id: 'gen-dec-simple', usage }),
		);
		const output = (await f.run())[0][0].json;
		expect(output.request_id).toBe(backend === 'openrouter' ? 'gen-dec-simple' : undefined);
		expect(output.usage).toEqual(usage);
	});
});

describe.each(['nace', 'openrouter'])('%s response validation and missing IDs', (backend) => {
	it('accepts a successful response without any ID and omits request_id', async () => {
		const f = fake({}, { backend });
		f.http.mockResolvedValue({
			statusCode: 200,
			headers: {},
			body: { answers: { approved: answerSet.noul }, usage: { input_tokens: 1 } },
		});
		const output = (await f.run())[0][0].json;
		expect(output).not.toHaveProperty('request_id');
		expect(output.answers).toEqual({ approved: answerSet.noul });
	});
	it.each([undefined, null, ''])(
		'reports a clear bodyless 500 error without IDs (body=%s)',
		async (body) => {
			const f = fake({}, { backend });
			f.http.mockResolvedValue({ statusCode: 500, headers: {}, body });
			await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
				expect(error).toBeInstanceOf(NodeApiError);
				expect(error.message).toBe('Drex API returned status 500');
				expect(error.httpCode).toBe('500');
				expect(error.description || '').not.toContain('Request ID:');
				return true;
			});
			f.raw.continueOnFail = () => true;
			const output = (await f.run())[0][0].json;
			expect(output.error).toBe('Drex API returned status 500');
			expect(output).not.toHaveProperty('request_id');
		},
	);
	it.each([undefined, null, 'not-json', 42, false, [], [{ answers: {} }], new Date(0)])(
		'rejects a non-plain-object 2xx body clearly: %s',
		async (body) => {
			const f = fake({}, { backend });
			f.http.mockResolvedValue({
				statusCode: 200,
				headers: { 'x-request-id': ['req-header', 'ignored-header'] },
				body,
			});
			await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
				expect(error).toBeInstanceOf(NodeApiError);
				expect(error.message).toBe(
					`Unexpected response from ${backend === 'openrouter' ? 'OpenRouter' : 'Nace'}`,
				);
				expect(error.description).toBe('Expected a JSON object in the response body.');
				return true;
			});
		},
	);
	const scalarCases = [
		{ request_id: 0, header: ['req-header'], id: 'gen-dec-body', expected: 0 },
		{ request_id: 123, header: 'req-header', id: 'gen-dec-body', expected: 123 },
		{
			request_id: {},
			header: ['req-first', 'req-second'],
			id: 'gen-dec-body',
			expected: 'req-first',
		},
		{
			request_id: ['invalid-array'],
			header: 'req-header',
			id: 'gen-dec-body',
			expected: 'req-header',
		},
		{ request_id: null, header: 0, id: 'gen-dec-body', expected: 0 },
		{ request_id: null, header: [], id: 456, expected: backend === 'openrouter' ? 456 : undefined },
		{ request_id: null, header: [], id: 0, expected: backend === 'openrouter' ? 0 : undefined },
		{
			request_id: {},
			header: [{ malformed: true }, 'must-not-use-second'],
			id: ['invalid-array'],
			expected: undefined,
		},
		{ request_id: ['invalid-array'], header: {}, id: { malformed: true }, expected: undefined },
		{ request_id: false, header: true, id: false, expected: undefined },
		{ request_id: NaN, header: Infinity, id: Infinity, expected: undefined },
	];
	it.each(scalarCases)(
		'uses only scalar request IDs and the first header value (expected=$expected)',
		async ({ request_id, header, id, expected }) => {
			const f = fake({}, { backend });
			const body = { answers: { approved: answerSet.noul }, request_id, id };
			const headers = { 'X-Request-Id': header };
			f.http.mockResolvedValue({ statusCode: 200, headers, body });
			const output = (await f.run())[0][0].json;
			if (expected === undefined) expect(output).not.toHaveProperty('request_id');
			else expect(output.request_id).toBe(expected);
			f.http.mockResolvedValue({
				statusCode: 422,
				headers,
				body: { ...body, error: { message: 'Invalid request' } },
			});
			await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
				expect(error).toBeInstanceOf(NodeApiError);
				if (expected === undefined) expect(error.description || '').not.toContain('Request ID:');
				else expect(error.description).toContain(`Request ID: ${expected}`);
				expect(error.description || '').not.toContain('[object Object]');
				expect(error.description || '').not.toContain('must-not-use-second');
				return true;
			});
		},
	);
	it('normalizes IDs on a copy of a frozen plain response body', async () => {
		const f = fake({}, { backend });
		const body = Object.freeze({ answers: { approved: answerSet.noul } });
		f.http.mockResolvedValue({
			statusCode: 200,
			headers: { 'x-request-id': ['req-first', 'req-second'] },
			body,
		});
		expect((await f.run())[0][0].json.request_id).toBe('req-first');
		expect(body).not.toHaveProperty('request_id');
	});
});

describe('backend image counts and headerless retries', () => {
	it.each([
		{ backend: 'openrouter', count: 4, limit: 4 },
		{ backend: 'openrouter', count: 5, limit: 4 },
		{ backend: 'nace', count: 8, limit: 8 },
		{ backend: 'nace', count: 9, limit: 8 },
	])('$backend accepts at most $limit images (count=$count)', async ({ backend, count, limit }) => {
		const names = Array.from({ length: count }, (_, index) => `image${index + 1}`);
		const binary = Object.fromEntries(
			names.map((name) => [name, { data: '', mimeType: 'image/png' }]),
		);
		const buffers = Object.fromEntries(
			names.map((name, index) => [name, index % 2 === 0 ? red : blue]),
		);
		const f = fake(
			{
				model: backend === 'openrouter' ? 'nace-ai/drex-max' : 'drex-max',
				imageProperties: names.join(','),
			},
			{ backend },
			[{ json: {}, binary }],
			buffers,
		);
		if (count > limit) {
			await expect(f.run()).rejects.toSatisfy((error: NodeOperationError) => {
				expect(error).toBeInstanceOf(NodeOperationError);
				expect(error.message).toContain(backend === 'openrouter' ? 'OpenRouter' : 'Nace');
				expect(error.message).toContain(`At most ${limit} images`);
				return true;
			});
			expect(f.http).not.toHaveBeenCalled();
			expect(f.raw.helpers.getBinaryDataBuffer).not.toHaveBeenCalled();
		} else {
			await f.run();
			expect(f.http).toHaveBeenCalledTimes(1);
			const images =
				backend === 'openrouter'
					? body(f.http)
							.state.slice(1)
							.map((part: { image_url: { url: string } }) => part.image_url.url)
					: body(f.http).images;
			expect(images).toEqual(
				names.map((name) => `data:image/png;base64,${buffers[name].toString('base64')}`),
			);
		}
	});
	it('shows five default retries in the node UI', () => {
		const options = new Nace().description.properties.find(
			(property) => property.name === 'options',
		)!;
		const retries = (options.options as INodeProperties[]).find(
			(property) => property.name === 'maxRetries',
		)!;
		expect(retries.default).toBe(5);
	});
	it.each(['nace', 'openrouter'])(
		'retries headerless 429 responses five times on %s at 2, 4, 8, 16, and 30 seconds',
		async (backend) => {
			vi.useFakeTimers();
			const f = fake({}, { backend });
			f.http.mockResolvedValue({
				statusCode: 429,
				headers: {},
				body: { error: { message: 'Model busy, retry later' } },
			});
			const pending = expect(f.run()).rejects.toThrow('Model busy, retry later');
			await vi.advanceTimersByTimeAsync(0);
			let calls = 1;
			for (const delay of [2000, 4000, 8000, 16000, 30000]) {
				expect(f.http).toHaveBeenCalledTimes(calls);
				await vi.advanceTimersByTimeAsync(delay - 1);
				expect(f.http).toHaveBeenCalledTimes(calls);
				await vi.advanceTimersByTimeAsync(1);
				expect(f.http).toHaveBeenCalledTimes(++calls);
			}
			await pending;
			expect(f.http).toHaveBeenCalledTimes(6);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
	it('uses five default retries for model loading too', async () => {
		vi.useFakeTimers();
		const f = fake({}, { backend: 'openrouter' });
		f.http.mockResolvedValue({
			statusCode: 429,
			headers: {},
			body: { error: { message: 'Model busy, retry later' } },
		});
		const pending = expect(getModels.call(f.context as never)).rejects.toBeInstanceOf(NodeApiError);
		await vi.runAllTimersAsync();
		await pending;
		expect(f.http).toHaveBeenCalledTimes(6);
	});
	it('caps repeated headerless waits at 30 seconds and stops after 120 seconds total sleep', async () => {
		vi.useFakeTimers();
		const f = fake({ options: { maxRetries: 10 } }, { backend: 'openrouter' });
		f.http.mockResolvedValue({
			statusCode: 429,
			headers: {},
			body: { error: { message: 'Model busy, retry later' } },
		});
		const pending = expect(f.run()).rejects.toThrow('Model busy, retry later');
		await vi.advanceTimersByTimeAsync(0);
		let calls = 1;
		for (const delay of [2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(f.http).toHaveBeenCalledTimes(calls);
			await vi.advanceTimersByTimeAsync(1);
			expect(f.http).toHaveBeenCalledTimes(++calls);
		}
		await pending;
		expect(f.http).toHaveBeenCalledTimes(8);
		expect(vi.getTimerCount()).toBe(0);
	});
});
