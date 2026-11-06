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
	IHttpRequestOptions,
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
		model:
			(credentials as IDataObject).backend === 'openrouter' ? 'nace-ai/drex-v2.0' : 'drex-v2.0',
		stateFormat: 'text',
		stateText: 'Synthetic text',
		questionsMode: 'json',
		questionsJson: JSON.stringify({ approved: noul }),
		...params,
	};
	const http = vi.fn().mockImplementation(async (_credential, options) => {
		const questions = options.body?.questions || {};
		const answers = Object.fromEntries(
			Object.entries(questions).map(([id, raw]) => {
				const question = raw as { type: string; criteria: IDataObject | string[] };
				return [
					id,
					question.type === 'noul'
						? answerSet.noul
						: question.type === 'score'
							? answerSet.score
							: {
									...answerSet.choice,
									choice: Object.keys(question.criteria).includes('support')
										? 'support'
										: Object.keys(question.criteria)[0],
								},
				];
			}),
		);
		return response(answers);
	});
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
async function credentialCheck(
	credentials: object,
	http = vi.fn().mockResolvedValue({ statusCode: 200, headers: {}, body: {} }),
) {
	const credential = new NaceApi();
	const data = {
		backend: 'nace',
		baseUrl: 'https://console.nace.ai',
		openRouterBaseUrl: 'https://openrouter.ai/api',
		...credentials,
	};
	const test = credential.test.request;
	try {
		const headers = Object.fromEntries(
			Object.entries(test.headers || {}).map(([key, value]) => [
				key,
				typeof value === 'string' && value.startsWith('=')
					? evaluateMetadata(value, {}, data)
					: value,
			]),
		);
		const options = await credential.authenticate(data, {
			...test,
			baseURL: evaluateMetadata(test.baseURL as string, {}, data),
			url: evaluateMetadata(test.url as string, {}, data),
			headers,
		});
		const response = await http({ ...options, uri: options.baseURL + options.url });
		return {
			result: {
				status: response.statusCode < 300 ? 'OK' : 'Error',
				message: `n8n HTTP status ${response.statusCode}`,
			},
			http,
		};
	} catch (caught) {
		return {
			result: {
				status: 'Error',
				message: caught instanceof Error ? caught.message : 'n8n credential test status',
			},
			http,
		};
	}
}
function assertSecretAbsent(value: unknown, secret: string, seen = new WeakSet<object>()) {
	if (typeof value === 'string') {
		expect(value).not.toContain(secret);
		return;
	}
	if (
		!value ||
		(typeof value !== 'object' && typeof value !== 'function') ||
		seen.has(value as object)
	)
		return;
	seen.add(value as object);
	for (const key of Object.getOwnPropertyNames(value)) {
		expect(key).not.toContain(secret);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor) assertSecretAbsent(descriptor.value, secret, seen);
	}
}
function body(http: ReturnType<typeof vi.fn>, call = 0) {
	return http.mock.calls[call][1].body;
}
function evaluateMetadata(expression: string, parameters: object = {}, credentials: object = {}) {
	return new Expression('UTC').resolveSimpleParameterValue(expression, {
		$parameter: parameters,
		$credentials: credentials,
	} as never);
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
	it.each([
		{
			question: noul,
			answer: { type: 'noul', noul: 0, choice: 'approved', confidence: 1 },
			value: 0,
		},
		{
			question: noul,
			answer: { type: 'noul', noul: 0, score: 99, confidence: 1 },
			value: 0,
		},
		{
			question: choice,
			answer: { type: 'choice', choice: 'support', noul: 0, score: 99, confidence: 1 },
			value: 'support',
		},
		{
			question: score,
			answer: { type: 'score', score: 0, choice: 'approved', noul: 1, confidence: 1 },
			value: 0,
		},
	])(
		'simplifies only the validated $answer.type field despite conflicting fields',
		async ({ question, answer, value }) => {
			const f = fake({ questionsJson: { decision: question }, options: { simplify: true } });
			f.http.mockResolvedValue(response({ decision: answer }));
			const result = await f.run();
			expect(result[0][0].json.answers).toEqual({ decision: { value, confidence: 1 } });
		},
	);
	it('supports JSON state, whole input and simplify with other input fields', async () => {
		const f = fake({
			questionsJson: { noul, choice, score },
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
		const fixture =
			_label === 'total bytes'
				? {
						...imageItem,
						binary: {
							red: { ...imageItem.binary.red, fileSize: '16 MiB' },
							blue: { ...imageItem.binary.blue, fileSize: '16 MiB' },
						},
					}
				: imageItem;
		const f = fake({ model: 'drex-max', imageProperties }, {}, [fixture], buffers);
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
		await expect(f.run()).rejects.toThrow(status === 401 ? 'API Key' : 'https://console.nace.ai');
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
		expect(new Nace().description.credentials).toContainEqual({
			name: 'naceApi',
			required: true,
		});
		expect('test' in credential).toBe(true);
		const check = await credentialCheck({
			backend: 'nace',
			apiKey: 'synthetic',
			baseUrl: 'https://console.nace.ai',
		});
		expect(check.result.status).toBe('OK');
		expect(check.http.mock.calls[0][0]).toMatchObject({
			uri: 'https://console.nace.ai/v1/models',
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
			const check = await credentialCheck(credentials);
			expect(check.result.status).toBe('OK');
			expect(check.http.mock.calls[0][0].uri).toBe(
				`${expectedBase}${backend === 'nace' ? '/v1/models' : '/v1/key'}`,
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
		const check = await credentialCheck({
			backend: 'openrouter',
			baseUrl: 'https://console.nace.ai',
		});
		expect(check.result.status).toBe('OK');
		expect(check.http.mock.calls[0][0].uri).toBe('https://openrouter.ai/api/v1/key');
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
			json: { error: 'Labels: Route requires at least one label [Item 1]' },
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
				json: { error: `${path} expression failed [Item 1]` },
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
				assertSecretAbsent(result, syntheticCredential);
				expect(result[0][0].json).toMatchObject({
					error: 'Bad request with [REDACTED] [Item 1]',
					description: expect.stringContaining('questions.[REDACTED]: Rejected [REDACTED]'),
				});
			} else {
				await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
					expect(error.message).toBe('Bad request with [REDACTED] [Item 1]');
					expect(error.description).toContain('questions.[REDACTED]: Rejected [REDACTED]');
					assertSecretAbsent(error, syntheticCredential);
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
		assertSecretAbsent(result, syntheticCredential);
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
			json: { original: true, error: 'Invalid timeout expression [Item 1]' },
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
	it.each([false, true])(
		'preserves shared input values and redacts nested strings (continue=%s)',
		async (continued) => {
			const secret = 'synthetic-input-key';
			const shared = { name: 'Customer', nested: [{ note: `Key: ${secret}` }] };
			const createdAt = new Date('2026-11-06T00:00:00Z');
			const bytes = Buffer.from([1, 2, 3]);
			class Customer {
				name = 'Customer';
			}
			const customerRecord = new Customer();
			const input = {
				customer: shared,
				billingCustomer: shared,
				createdAt,
				bytes,
				customerRecord,
			};
			const f = fake({ options: { includeOtherFields: true } }, { apiKey: secret }, [
				{ json: input as unknown as IDataObject },
			]);
			if (continued) {
				f.raw.continueOnFail = () => true;
				f.http.mockResolvedValue(response({}, 422));
			}
			const result = (await f.run())[0][0].json;
			const expected = { name: 'Customer', nested: [{ note: 'Key: [REDACTED]' }] };
			expect(result.customer).toEqual(expected);
			expect(result.billingCustomer).toEqual(expected);
			expect(result.createdAt).toBe(createdAt);
			expect(result.bytes).toBe(bytes);
			expect(result.customerRecord).toBe(customerRecord);
			expect(shared.nested[0].note).toBe(`Key: ${secret}`);
			assertSecretAbsent(result, secret);
		},
	);
	it.each([false, true])(
		'handles actual input cycles without losing later references (continue=%s)',
		async (continued) => {
			const customer: IDataObject = { name: 'Customer' };
			customer.self = customer;
			const input = { customer, billingCustomer: customer };
			const f = fake({ options: { includeOtherFields: true } }, {}, [{ json: input }]);
			if (continued) {
				f.raw.continueOnFail = () => true;
				f.http.mockResolvedValue(response({}, 422));
			}
			const result = (await f.run())[0][0].json;
			expect(result.customer).toEqual({ name: 'Customer', self: null });
			expect(result.billingCustomer).toEqual({ name: 'Customer', self: null });
			expect(customer.self).toBe(customer);
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
					: credentials.openRouterBaseUrl.includes('@')
						? 'Base URL must not include userinfo'
						: 'OpenRouter Base URL must use openrouter.ai or a subdomain of openrouter.ai';
			await expect(f.run()).rejects.toBeInstanceOf(NodeOperationError);
			await expect(f.run()).rejects.toThrow(expectedMessage);
			await expect(getModels.call(f.context as never)).rejects.toThrow(expectedMessage);
			const check = await credentialCheck(credentials);
			expect(check.result.status).toBe('Error');
			expect(check.http).not.toHaveBeenCalled();
			expect(check.result.message).toContain('Base URL');
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
			const check = await credentialCheck(credentials);
			expect(check.result.status).toBe('OK');
			expect(check.http.mock.calls[0][0].uri).toBe(
				expected + (credentials.backend === 'openrouter' ? '/v1/key' : '/v1/models'),
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
			const check = await credentialCheck(credentials);
			expect(check.result.status).toBe('OK');
			expect(check.http.mock.calls[0][0].uri).toBe(
				expected + (credentials.backend === 'openrouter' ? '/v1/key' : '/v1/models'),
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
		assertSecretAbsent(result, syntheticCredential);
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
				expect(error.message).toBe('Drex API returned status 500 [Item 1]');
				expect(error.httpCode).toBe('500');
				expect(error.description || '').not.toContain('Request ID:');
				return true;
			});
			f.raw.continueOnFail = () => true;
			const output = (await f.run())[0][0].json;
			expect(output.error).toBe('Drex API returned status 500 [Item 1]');
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
					`Unexpected response from ${backend === 'openrouter' ? 'OpenRouter' : 'Nace'} [Item 1]`,
				);
				expect(error.description).toBe('Expected a JSON object in the response body. [Item 1]');
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
	it('uses at most one retry for model loading', async () => {
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
		expect(f.http).toHaveBeenCalledTimes(2);
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

describe('security review round one', () => {
	it.each([
		{ backend: 'nace', baseUrl: 'http://console.nace.ai' },
		{ backend: 'nace', baseUrl: 'http://example.test:8000' },
		{ backend: 'openrouter', openRouterBaseUrl: 'http://openrouter.ai/api' },
	])('requires HTTPS on a non-local backend: $backend', async (credentials) => {
		const f = fake({}, credentials);
		await expect(f.run()).rejects.toThrow('Base URL must use HTTPS');
		expect(f.http).not.toHaveBeenCalled();
		const check = await credentialCheck(credentials);
		expect(check.result).toMatchObject({
			status: 'Error',
			message: expect.stringContaining('HTTPS'),
		});
		expect(check.http).not.toHaveBeenCalled();
	});
	it.each(['localhost', '127.0.0.1', '[::1]'])('allows local Nace HTTP for %s', async (host) => {
		const f = fake({}, { baseUrl: `http://${host}:8080/api/` });
		await f.run();
		expect(f.http.mock.calls[0][1].url).toBe(`http://${host}:8080/api/v1/systemone`);
		const check = await credentialCheck({ baseUrl: `http://${host}:8080/api/` });
		expect(check.result.status).toBe('OK');
		expect(check.http.mock.calls[0][0].uri).toBe(`http://${host}:8080/api/v1/models`);
	});
	it.each(['?debug=1', '?', '#fragment', '#', '/?x=1'])(
		'rejects URL suffix %s for execution and credential tests',
		async (suffix) => {
			for (const backend of ['nace', 'openrouter']) {
				const credentials = {
					backend,
					baseUrl: `https://console.nace.ai${suffix}`,
					openRouterBaseUrl: `https://openrouter.ai/api${suffix}`,
				};
				const f = fake({}, credentials);
				await expect(f.run()).rejects.toThrow('query, or a fragment');
				expect(f.http).not.toHaveBeenCalled();
				const check = await credentialCheck(credentials);
				expect(check.result.status).toBe('Error');
				expect(check.http).not.toHaveBeenCalled();
			}
		},
	);
	it.each(['user:password@', '@'])('rejects userinfo %s without exposing it', async (userinfo) => {
		const f = fake({}, { baseUrl: `https://${userinfo}console.nace.ai` });
		await expect(f.run()).rejects.toThrow('userinfo');
		expect(f.http).not.toHaveBeenCalled();
	});
	it('normalizes origins, dot segments, ports, and trailing slashes everywhere', async () => {
		const credentials = {
			backend: 'nace',
			baseUrl: '  https://CONSOLE.NACE.AI:443/first/../api///  ',
		};
		const f = fake({}, credentials);
		await f.run();
		expect(f.http.mock.calls[0][1].url).toBe('https://console.nace.ai/api/v1/systemone');
		const check = await credentialCheck(credentials);
		expect(check.http.mock.calls[0][0].uri).toBe('https://console.nace.ai/api/v1/models');
	});
	it.each(['nace', 'openrouter'])(
		'uses standard declarative credential tests for %s',
		async (backend) => {
			const check = await credentialCheck({
				backend,
				baseUrl: 'https://console.nace.ai',
				openRouterBaseUrl: 'https://openrouter.ai/api',
			});
			expect(check.result.status).toBe('OK');
			expect(check.http.mock.calls[0][0]).toMatchObject({
				uri:
					backend === 'openrouter'
						? 'https://openrouter.ai/api/v1/key'
						: 'https://console.nace.ai/v1/models',
				disableFollowRedirect: true,
			});
			expect('test' in new NaceApi()).toBe(true);
		},
	);
	const syntheticCredential = 'synthetic-key-for-deep-inspection';
	function axiosError() {
		const error = Object.assign(new Error(`Proxy echoed ${syntheticCredential}`), {
			isAxiosError: true,
			config: { headers: { Authorization: `Bearer ${syntheticCredential}` } },
			request: { bytes: Buffer.from(syntheticCredential) },
			response: { status: 500, data: { error: { message: syntheticCredential } } },
		});
		Object.defineProperty(error, 'cause', {
			value: { config: error.config, stack: syntheticCredential },
			enumerable: false,
		});
		return error;
	}
	it('projects transport errors without retaining axios config, response, cause, or bytes', async () => {
		const f = fake({}, { apiKey: syntheticCredential });
		f.http.mockRejectedValue(axiosError());
		await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
			assertSecretAbsent(error, syntheticCredential);
			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.errorResponse).toMatchObject({ message: 'Proxy echoed [REDACTED] [Item 1]' });
			expect(error.errorResponse).not.toHaveProperty('config');
			expect(error.errorResponse).not.toHaveProperty('response');
			expect(error.errorResponse).not.toHaveProperty('cause');
			return true;
		});
	});
	it('redacts 4xx projections including issue paths without retaining unknown payloads', async () => {
		const f = fake({}, { apiKey: syntheticCredential });
		f.http.mockResolvedValue({
			statusCode: 422,
			headers: {},
			body: {
				error: {
					type: syntheticCredential,
					message: syntheticCredential,
					issues: [
						null,
						{ path: ['questions', syntheticCredential], message: syntheticCredential },
					],
				},
				config: { headers: { Authorization: syntheticCredential } },
				request_id: syntheticCredential,
			},
		});
		await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
			assertSecretAbsent(error, syntheticCredential);
			expect(error.description).toContain('questions.[REDACTED]: [REDACTED]');
			expect(error.errorResponse).not.toHaveProperty('config');
			return true;
		});
	});
	it('redacts every success field and rejects an echoed invalid Route choice safely', async () => {
		const f = fake({}, { apiKey: syntheticCredential });
		f.http.mockResolvedValue(
			response(
				undefined,
				200,
				{},
				{
					model: syntheticCredential,
					usage: { echoed: syntheticCredential },
					nested: { value: syntheticCredential },
					request_id: syntheticCredential,
				},
			),
		);
		assertSecretAbsent(await f.run(), syntheticCredential);
		const route = fake(
			{ operation: 'route', labels: { label: [{ label: 'support' }] } },
			{ apiKey: syntheticCredential },
		);
		route.http.mockResolvedValue(
			response({ route: { ...answerSet.choice, choice: syntheticCredential } }),
		);
		route.raw.continueOnFail = () => true;
		const result = await route.run();
		expect(result[0]).toEqual([]);
		expect(result[1][0].json.error).toContain('Unexpected response');
		assertSecretAbsent(result, syntheticCredential);
	});
	it('uses only the standard credential test declaration and no node-level tester', () => {
		const node = new Nace();
		expect(node.methods).not.toHaveProperty('credentialTest');
		expect(node.description.credentials?.[0]).not.toHaveProperty('testedBy');
		expect(new NaceApi().test.request.method).toBe('GET');
	});
	it('does not traverse a transport cause at all', async () => {
		const error = new Error('Network failed');
		Object.defineProperty(error, 'cause', {
			get: () => {
				throw new Error('Must not traverse cause');
			},
		});
		const f = fake();
		f.http.mockRejectedValue(error);
		await expect(f.run()).rejects.toThrow('Network failed');
	});
	it.each([
		{ approved: null },
		{ approved: 'garbage' },
		{},
		{ approved: { type: 'choice', choice: 'yes' } },
		{ approved: { type: { toString: 'invalid' }, noul: 0.5 } },
		{ approved: { type: 'noul', noul: -0.1 } },
		{ approved: { type: 'noul', noul: 1.1 } },
		{ approved: { type: 'noul', noul: 'true' } },
		{ approved: { type: 'noul', noul: 0.5, confidence: 2 } },
		{ approved: { type: 'noul', noul: 0.5, probabilities: { true: -1 } } },
		{ approved: { type: 'noul', noul: 0.5, probabilities: { true: '0.5' } } },
	])('rejects malformed answers clearly even with Simplify enabled: %j', async (answers) => {
		const f = fake({ options: { simplify: true } });
		f.http.mockResolvedValue(response(answers));
		await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
			expect(error).toBeInstanceOf(NodeApiError);
			expect(error.message).toBe('Unexpected response from Nace [Item 1]');
			expect(error.description).toContain('Question approved');
			return true;
		});
	});
	it('rejects a nonnumeric score and an invalid choice with no label-output side effects', async () => {
		const f = fake({ questionsJson: { score } });
		f.http.mockResolvedValue(response({ score: { type: 'score', score: 'high' } }));
		await expect(f.run()).rejects.toThrow('Unexpected response');
		const route = fake({ operation: 'route', labels: { label: [{ label: 'support' }] } });
		route.raw.continueOnFail = () => true;
		route.http.mockResolvedValue(response({ route: { ...answerSet.choice, confidence: 2 } }));
		const outputs = await route.run();
		expect(outputs[0]).toEqual([]);
		expect(outputs[1][0].error).toBeInstanceOf(NodeApiError);
	});
	it('sets the installed response-size option for decisions and model lists', async () => {
		const f = fake();
		await f.run();
		expect(f.http.mock.calls[0][1].maxResponseBodyBytes).toBe(8 * 1024 * 1024);
		f.http.mockResolvedValue({ statusCode: 200, headers: {}, body: { models: [] } });
		await getModels.call(f.context as never);
		expect(f.http.mock.calls[1][1].maxResponseBodyBytes).toBe(16 * 1024 * 1024);
	});
	it('handles malformed model lists clearly and skips malformed entries', async () => {
		const f = fake();
		f.http.mockResolvedValue({ statusCode: 200, headers: {}, body: { models: {} } });
		await expect(getModels.call(f.context as never)).rejects.toThrow(
			'Unexpected response from Nace',
		);
		f.http.mockResolvedValue({
			statusCode: 200,
			headers: {},
			body: { models: [null, 'bad', {}, { name: 'drex-v2.0' }] },
		});
		expect(await getModels.call(f.context as never)).toEqual([
			{ name: 'drex-v2.0', value: 'drex-v2.0', description: '' },
		]);
	});
	it.each([
		{ mime: 'image/png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), valid: true },
		{ mime: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8, 0xff]), valid: true },
		{ mime: 'image/webp', bytes: Buffer.from('RIFF1234WEBP'), valid: true },
		{ mime: 'image/png', bytes: Buffer.from('not a PNG'), valid: false },
		{ mime: 'image/jpeg', bytes: red, valid: false },
		{ mime: 'image/webp', bytes: Buffer.from('RIFF1234FAKE'), valid: false },
	])('checks binary signature for $mime / valid=$valid', async ({ mime, bytes, valid }) => {
		const f = fake(
			{ model: 'drex-max', imageProperties: 'attachment' },
			{},
			[{ json: {}, binary: { attachment: { data: '', mimeType: mime } } }],
			{ attachment: bytes },
		);
		if (valid) {
			await f.run();
			expect(f.http).toHaveBeenCalledTimes(1);
		} else {
			await expect(f.run()).rejects.toThrow('Image attachment: content does not match');
			expect(f.http).not.toHaveBeenCalled();
		}
	});
	it.each([
		{ sizes: ['17 MiB'], message: '16 MiB' },
		{ sizes: ['12 MiB', '12 MiB', '12 MiB'], message: '32 MiB' },
		{ sizes: ['4 MiB'], message: '4 MiB' },
	])('rejects metadata sizes before any binary read: $sizes', async ({ sizes, message }) => {
		const binary = Object.fromEntries(
			sizes.map((size, i) => [`img${i}`, { data: '', mimeType: 'image/png', fileSize: size }]),
		);
		const f = fake({ model: 'drex-max', imageProperties: Object.keys(binary).join(',') }, {}, [
			{ json: {}, binary },
		]);
		await expect(f.run()).rejects.toThrow(message);
		expect(f.raw.helpers.getBinaryDataBuffer).not.toHaveBeenCalled();
		expect(f.http).not.toHaveBeenCalled();
	});
	it('fails the JSON budget after the first large binary instead of loading later images', async () => {
		const large = Buffer.alloc(3 * 1024 * 1024);
		red.copy(large);
		const f = fake({ model: 'drex-max', imageProperties: 'red,blue' }, {}, [imageItem], {
			red: large,
			blue,
		});
		await expect(f.run()).rejects.toThrow('4 MiB');
		expect(f.raw.helpers.getBinaryDataBuffer).toHaveBeenCalledTimes(1);
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each([undefined, '1 B'])(
		'checks actual image bytes before encoding when fileSize=%s',
		async (fileSize) => {
			const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
			const encode = vi.spyOn(oversized, 'toString');
			const f = fake(
				{ model: 'drex-max', imageProperties: 'red,blue' },
				{},
				[
					{
						...imageItem,
						binary: { ...imageItem.binary, red: { ...imageItem.binary.red, fileSize } },
					},
				],
				{ red: oversized, blue },
			);
			await expect(f.run()).rejects.toThrow('Image red exceeds the 16 MiB limit');
			expect(f.raw.helpers.getBinaryDataBuffer).toHaveBeenCalledTimes(1);
			expect(encode).not.toHaveBeenCalled();
			expect(f.http).not.toHaveBeenCalled();
		},
	);
	it.each(['nace', 'openrouter'])('uses the correct 402 billing URL for %s', async (backend) => {
		const f = fake({}, { backend });
		f.http.mockResolvedValue({ statusCode: 402, headers: {}, body: {} });
		await expect(f.run()).rejects.toThrow(
			backend === 'openrouter'
				? 'https://openrouter.ai/settings/credits'
				: 'https://console.nace.ai',
		);
	});
	it('refuses OpenRouter models without a provider prefix before HTTP', async () => {
		const f = fake({ model: 'drex-v2.0' }, { backend: 'openrouter' });
		await expect(f.run()).rejects.toThrow('Try nace-ai/drex-v2.0');
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each(['Unsure', 'uNsUrE', ' unsure '])('reserves Route label %s', async (label) => {
		const f = fake({ operation: 'route', labels: { label: [{ label }] } });
		await expect(f.run()).rejects.toThrow('reserved');
		expect(f.http).not.toHaveBeenCalled();
	});
	it.each([3000, 120000])(
		'handles Retry-After HTTP dates with a 60-second wait cap: %s ms',
		async (offset) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
			const f = fake();
			f.http.mockResolvedValueOnce(
				response({}, 429, { 'Retry-After': new Date(Date.now() + offset).toUTCString() }),
			);
			const pending = f.run();
			const delay = Math.min(offset, 60000);
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(f.http).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await pending;
			expect(f.http).toHaveBeenCalledTimes(2);
		},
	);
	it('asserts simplified noul values and retains binaries on successful inclusive output', async () => {
		const f = fake({ options: { simplify: true, includeOtherFields: true } }, {}, [imageItem]);
		const result = await f.run();
		expect(result[0][0].json.answers).toEqual({ approved: { value: 0.95, confidence: 0.9 } });
		expect(result[0][0].binary).toEqual(imageItem.binary);
	});
	it.each(['stateJson', 'questionsJson'])('reports invalid %s JSON before HTTP', async (name) => {
		const f = fake({ [name]: '{broken', ...(name === 'stateJson' ? { stateFormat: 'json' } : {}) });
		await expect(f.run()).rejects.toThrow(
			`${name === 'stateJson' ? 'State (JSON)' : 'Questions (JSON)'} must be valid JSON`,
		);
		expect(f.http).not.toHaveBeenCalled();
	});
	it('pins CLI and workflow actions and isolates npm publishing privileges', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
		const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
		expect(pkg.devDependencies['@n8n/node-cli']).toBe('0.55.5');
		expect(lock.packages[''].devDependencies['@n8n/node-cli']).toBe('0.55.5');
		const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
		const publish = readFileSync('.github/workflows/publish.yml', 'utf8');
		for (const workflow of [ci, publish]) {
			expect(workflow).toContain('contents: read');
			expect(workflow).toContain('persist-credentials: false');
			for (const match of workflow.matchAll(/uses: ([^\s#]+)/g))
				expect(match[1]).toMatch(/@[a-f0-9]{40}$/);
		}
		expect(ci).toContain('actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0');
		expect(ci).toContain('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0');
		const [build, release] = publish.split('\n  publish:');
		expect(build).not.toContain('id-token: write');
		expect(ci).toContain('npm ci --ignore-scripts');
		expect(build).toContain('npm ci --ignore-scripts');
		expect(build).toContain('npm run lint');
		expect(build).toContain('npm test');
		expect(build).toContain('npm run build');
		expect(build).toContain('npm pack');
		expect(build).toContain('actions/upload-artifact@');
		expect(publish).toContain("'v*.*.*'");
		expect(publish).toContain('workflow_dispatch:');
		expect(release).toContain('needs: build');
		expect(release).toContain('id-token: write');
		expect(release).toContain('environment: npm-publish');
		expect(release).not.toContain('npm ci');
		expect(release).not.toContain('actions/checkout');
		expect(release).toContain('actions/download-artifact@');
		expect(release).toContain('npm publish "$1" --provenance --access public');
	});
});

describe('declarative credential tests and verified-node wording', () => {
	it.each([
		{
			credentials: { backend: 'nace' },
			request: { uri: 'https://console.nace.ai/v1/models' },
		},
		{
			credentials: { backend: 'openrouter' },
			request: { uri: 'https://openrouter.ai/api/v1/key' },
		},
		{
			credentials: { backend: 'openrouter' },
			request: { uri: 'https://OPENROUTER.AI:443/api/v1/key' },
		},
		{
			credentials: { backend: 'openrouter' },
			request: { uri: '/v1/key', baseURL: 'https://openrouter.ai/api' },
		},
		{
			credentials: { backend: 'openrouter' },
			request: {
				uri: 'https://openrouter.ai:443/api/v1/key',
				url: '/v1/models',
				baseURL: 'https://openrouter.ai/api',
			},
		},
		{
			credentials: { backend: 'nace', baseUrl: 'https://drex.example/custom/api' },
			request: { uri: 'https://drex.example/custom/api/v1/models' },
		},
		{
			credentials: { backend: 'nace', baseUrl: 'https://drex.example/custom/api' },
			request: { uri: 'v1/models', baseURL: 'https://drex.example/custom/api/' },
		},
	])('authenticates the HTTP Request uri shape: %j', async ({ credentials, request }) => {
		const options = { ...request, headers: { 'X-Test': 'preserved' } };
		const authenticated = await new NaceApi().authenticate(
			{ ...credentials, apiKey: 'synthetic' },
			options,
		);
		expect(authenticated.uri).toBe(request.uri);
		expect(authenticated.url).toBe(request.url);
		expect(authenticated.headers).toEqual({
			'X-Test': 'preserved',
			Authorization: 'Bearer synthetic',
		});
		expect(options.headers).toEqual({ 'X-Test': 'preserved' });
	});
	it.each([
		{ uri: 'https://openrouter.ai@evil.example/' },
		{ url: 'https://openrouter.ai@evil.example/' },
		{ uri: 'https://openrouter.ai:8443/api/v1/key' },
		{ uri: 'https://evil.example/', url: 'https://openrouter.ai/api/v1/key' },
		{ uri: 'https://openrouter.ai/api/v1/key', url: 'https://evil.example/' },
		{ uri: '/capture', url: 'https://openrouter.ai/api/v1/key', baseURL: 'https://evil.example' },
		{ uri: 'https://openrouter.ai/api/v1/key', url: '/capture', baseURL: 'https://evil.example' },
		{ uri: '//evil.example/capture', baseURL: 'https://openrouter.ai/api' },
		{ uri: '/v1/key' },
		{ uri: 'https://[synthetic', url: 'https://openrouter.ai/api/v1/key' },
		{},
	])(
		'refuses unsafe or conflicting uri/url targets without leaking the key: %j',
		async (request) => {
			const options = { ...request, headers: { 'X-Test': 'preserved' } };
			const authentication = new NaceApi().authenticate(
				{ backend: 'openrouter', apiKey: 'synthetic' },
				options,
			);
			await expect(authentication).rejects.toThrow(/Nace API credentials/);
			await expect(authentication).rejects.not.toThrow('synthetic');
			expect(options.headers).toEqual({ 'X-Test': 'preserved' });
		},
	);
	it.each([
		{ url: 'https://OPENROUTER.AI:443/api/v1/key' },
		{ url: 'https://openrouter.ai/another/path', baseURL: 'https://example.org' },
		{ url: '/v1/key', baseURL: 'https://openrouter.ai/api' },
		{ url: 'v1/key', baseURL: 'https://openrouter.ai/api/' },
		{ url: '//openrouter.ai/api/v1/key', baseURL: 'https://openrouter.ai/api' },
	])('authenticates a same-origin effective request URL: %j', async (request) => {
		const options: IHttpRequestOptions = {
			...request,
			method: 'GET',
			headers: { 'X-Test': 'preserved' },
		};
		const authenticated = await new NaceApi().authenticate(
			{ backend: 'openrouter', apiKey: 'synthetic' },
			options,
		);
		expect(authenticated.url).toBe(request.url);
		expect(authenticated.headers).toEqual({
			'X-Test': 'preserved',
			Authorization: 'Bearer synthetic',
		});
		expect(options.headers).toEqual({ 'X-Test': 'preserved' });
	});
	it.each([
		{ url: 'http://example.org/capture' },
		{ url: 'https://example.org/synthetic', baseURL: 'https://openrouter.ai/api' },
		{ url: '/capture', baseURL: 'https://example.org' },
		{ url: 'capture', baseURL: 'https://example.org/path/' },
		{ url: '//example.org/capture', baseURL: 'https://openrouter.ai/api' },
		{ url: '/\\example.org/capture', baseURL: 'https://openrouter.ai/api' },
		{ url: 'https://openrouter.ai.example.org/capture' },
		{ url: 'https://sub.openrouter.ai/capture' },
		{ url: 'https://openrouter.ai:8443/capture' },
		{ url: 'http://openrouter.ai/capture' },
		{ url: '/capture' },
		{ url: 'https://[synthetic' },
	])(
		'refuses unsafe or unresolved effective request URLs without exposing the key: %j',
		async (request) => {
			const options: IHttpRequestOptions = {
				...request,
				method: 'GET',
				headers: { 'X-Test': 'preserved' },
			};
			const authentication = new NaceApi().authenticate(
				{ backend: 'openrouter', apiKey: 'synthetic' },
				options,
			);
			await expect(authentication).rejects.toThrow(/Nace API credentials/);
			await expect(authentication).rejects.not.toThrow('synthetic');
			expect(options.headers).toEqual({ 'X-Test': 'preserved' });
			expect(options.url).toBe(request.url);
		},
	);
	it.each(['nace', 'openrouter'])(
		'declares the standard %s endpoint and attribution headers',
		async (backend) => {
			const credential = new NaceApi();
			const data = {
				backend,
				apiKey: 'synthetic',
				baseUrl: ' https://CONSOLE.NACE.AI:443/old/../api/// ',
				openRouterBaseUrl: ' https://OPENROUTER.AI:443/old/../api/// ',
			};
			const test = credential.test.request;
			expect(test.method).toBe('GET');
			expect(test.maxResponseBodyBytes).toBe(16 * 1024 * 1024);
			expect(evaluateMetadata(test.url as string, {}, data)).toBe(
				backend === 'openrouter' ? '/v1/key' : '/v1/models',
			);
			const baseURL = evaluateMetadata(test.baseURL as string, {}, data) as string;
			const options = await credential.authenticate(data, {
				url: evaluateMetadata(test.url as string, {}, data) as string,
				baseURL,
				method: 'GET',
			});
			expect(options.baseURL).toBe(
				backend === 'openrouter' ? 'https://openrouter.ai/api' : 'https://console.nace.ai/api',
			);
			expect(options.headers?.Authorization).toBe('Bearer synthetic');
			expect(test.headers).toMatchObject({ 'User-Agent': CLIENT, 'X-Nace-Client': CLIENT });
			expect(evaluateMetadata(test.headers!['HTTP-Referer'] as string, {}, data)).toBe(
				backend === 'openrouter' ? 'https://nace.ai' : undefined,
			);
			expect(new Nace().methods).not.toHaveProperty('credentialTest');
			expect(new Nace().description.credentials?.[0]).not.toHaveProperty('testedBy');
		},
	);
	it('starts text placeholders with e.g. and keeps collection button labels', () => {
		function check(value: unknown) {
			if (!value || typeof value !== 'object') return;
			const field = value as Record<string, unknown>;
			if (field.type === 'string' && typeof field.placeholder === 'string')
				expect(field.placeholder).toMatch(/^e\.g\./);
			if (
				['collection', 'fixedCollection'].includes(String(field.type)) &&
				typeof field.placeholder === 'string'
			)
				expect(field.placeholder).toMatch(/^Add /);
			if (typeof field.description === 'string')
				expect(field.description).not.toMatch(/\b(error|problem|failure|mistake)s?\b/i);
			for (const entry of Object.values(field)) check(entry);
		}
		check(new Nace().description.properties);
		check(new NaceApi().properties);
		expect(
			new Nace().description.properties.find((field) => field.name === 'imageProperties')
				?.placeholder,
		).toBe('e.g. image1,image2');
	});
	it('names the parameter and uses the one-based item number on continued messages', async () => {
		const f = fake(
			{ model: (index: number) => (index === 0 ? 'nace-ai/drex-v2.0' : 'drex-v2.0') },
			{ backend: 'openrouter' },
			[{ json: {} }, { json: {} }],
		);
		f.raw.continueOnFail = () => true;
		const result = await f.run();
		expect(result[0][1].json.error).toBe(
			'Model Name or ID: OpenRouter models must start with nace-ai/. Try nace-ai/drex-v2.0. [Item 2]',
		);
		expect(result[0][1].pairedItem).toEqual({ item: 1 });
		expect(f.http).toHaveBeenCalledTimes(1);
	});
	it('uses Type instead of Error type and preserves API type strings verbatim', async () => {
		const f = fake();
		f.http.mockResolvedValue({
			statusCode: 401,
			headers: {},
			body: { error: { type: 'authentication_error', message: 'Invalid token' } },
		});
		await expect(f.run()).rejects.toSatisfy((issue: NodeApiError) => {
			expect(issue.message).toBe('API Key: Check your Nace API credential. [Item 1]');
			expect(issue.description).toContain('Type: authentication_error');
			expect(issue.description).not.toContain('Error type:');
			expect(issue.message + issue.description).not.toMatch(
				/\b(error|problem|failure|mistake)s?\b/i,
			);
			return true;
		});
	});
	it('names Questions in malformed response descriptions and includes the item once', async () => {
		const f = fake();
		f.http.mockResolvedValue(response({ approved: null }));
		await expect(f.run()).rejects.toSatisfy((issue: NodeApiError) => {
			expect(issue.description).toBe(
				'Questions: Question approved: expected an answer object [Item 1]',
			);
			expect(issue.message.match(/\[Item 1\]/g)).toHaveLength(1);
			return true;
		});
	});
	it('has no runtime lint exemptions or deprecated credential helper left', () => {
		for (const directory of ['nodes/Nace', 'credentials'])
			for (const file of readdirSync(directory).filter((name) => name.endsWith('.ts'))) {
				const source = readFileSync(`${directory}/${file}`, 'utf8');
				expect(source).not.toContain('eslint-disable');
				expect(source).not.toContain('helpers.request');
				expect(source).not.toContain('testNaceApi');
			}
	});
});
