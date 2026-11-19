import { afterEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @n8n/community-nodes/no-restricted-imports -- Test-only verification of local package artifacts; never runs in n8n.
import { readFileSync } from 'node:fs';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeParameters,
	INodeProperties,
	NodeApiError,
} from 'n8n-workflow';
import { NodeHelpers } from 'n8n-workflow';
import { NaceDocumentIntelligence } from '../nodes/NaceDocumentIntelligence/NaceDocumentIntelligence.node';
import { getWorkspaces } from '../nodes/NaceDocumentIntelligence/ndi';
import { properties } from '../nodes/NaceDocumentIntelligence/properties';
import { CLIENT } from '../nodes/Nace/constants';

const API_KEY = 'synthetic-ndi-test-key';
const UPLOAD_URL = 'https://upload.example.com/v1/workspaces/ws-9/files';
const UPLOAD_TOKEN = 'synthetic-upload-token';
const invoice = { data: '', mimeType: 'application/pdf', fileName: 'scan/invoice-42.pdf' };
const invoiceBytes = Buffer.from('%PDF-1.4 synthetic invoice');

function full(statusCode: number, body: unknown, headers: Record<string, unknown> = {}) {
	return { statusCode, headers, body };
}
function job(jobId: string, status: string, result: unknown, extra: Record<string, unknown> = {}) {
	return { job_id: jobId, kind: 'document_parse', status, result, cost: 0.012, ...extra };
}
function uploadJob() {
	return full(
		200,
		JSON.stringify({
			job_id: 'job-upload',
			kind: 'file_upload',
			status: 'succeeded',
			result: { file: { file_id: 'file-7', workspace_id: 'ws-9' } },
		}),
	);
}
function grant(uploadUrl = UPLOAD_URL) {
	return full(200, {
		workspace_id: 'ws-9',
		upload_url: uploadUrl,
		token: UPLOAD_TOKEN,
		expires_at: '2026-11-20T12:00:00Z',
		max_bytes: 104857600,
		transient: false,
	});
}
function fake(
	params: Record<string, unknown> = {},
	credentials: object = {},
	items: INodeExecutionData[] = [{ json: {} }],
	buffers: Record<string, Buffer> = {},
) {
	const values: Record<string, unknown> = {
		resource: 'document',
		operation: 'parse',
		source: 'url',
		url: 'https://files.example.test/invoice-42.pdf',
		outputFormats: ['markdown'],
		options: {},
		...params,
	};
	const auth = vi.fn();
	const plain = vi.fn();
	const context = {
		getInputData: () => items,
		getNode: () => ({
			id: 'test',
			name: 'Nace Document Intelligence',
			type: '@nace-ai/n8n-nodes-nace.naceDocumentIntelligence',
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
			openRouterBaseUrl: 'https://openrouter.example.com/api',
			apiKey: API_KEY,
			...credentials,
		}),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: auth,
			httpRequest: plain,
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
		auth,
		plain,
		raw: context,
		run: async () =>
			new NaceDocumentIntelligence().execute.call(context as unknown as IExecuteFunctions),
	};
}

afterEach(() => vi.useRealTimers());

describe('Nace Document Intelligence', () => {
	it('parses from a URL in one job call, deletes the job, and never uploads', async () => {
		const f = fake({
			options: { parseMode: 'high', chunking: 'section', tableFormat: 'markdown', maxWait: 120 },
		});
		f.auth
			.mockResolvedValueOnce(
				full(200, job('job-1', 'succeeded', { document: { markdown: '# Invoice' } }), {
					'x-request-id': 'req-parse',
				}),
			)
			.mockResolvedValue(full(204, ''));
		const result = await f.run();
		expect(f.auth).toHaveBeenCalledTimes(2);
		expect(f.auth.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			url: 'https://console.nace.ai/v1/documents/parse',
			qs: { wait_seconds: 60 },
			body: {
				source: {
					type: 'url',
					url: 'https://files.example.test/invoice-42.pdf',
					file_name: 'invoice-42.pdf',
				},
				parse_mode: 'high',
				output: { formats: ['markdown'], table_format: 'markdown' },
				chunking: { strategy: 'section' },
			},
		});
		expect(f.auth.mock.calls[1][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/jobs/job-1',
		});
		expect(f.plain).not.toHaveBeenCalled();
		expect(result[0][0]).toMatchObject({
			json: {
				job_id: 'job-1',
				request_id: 'req-parse',
				cost: 0.012,
				document: { markdown: '# Invoice' },
				cleanup: { job_deleted: true },
			},
			pairedItem: { item: 0 },
		});
		expect(result[0][0].json.cleanup).not.toHaveProperty('file_deleted');
	});

	it('uploads a binary file with the token to the other origin and deletes the job, then the file', async () => {
		vi.useFakeTimers();
		const f = fake(
			{ source: 'binary', binaryPropertyName: 'data' },
			{},
			[{ json: {}, binary: { data: invoice } }],
			{ data: invoiceBytes },
		);
		f.auth
			.mockResolvedValueOnce(grant())
			.mockResolvedValueOnce(
				full(200, job('job-2', 'succeeded', { document: { text: 'Invoice' } })),
			)
			.mockResolvedValueOnce(full(204, ''))
			.mockResolvedValueOnce(full(202, { status: 'deleting' }))
			.mockResolvedValueOnce(full(200, { status: 'deleted' }));
		f.plain.mockResolvedValueOnce(uploadJob());
		const pending = f.run();
		await vi.advanceTimersByTimeAsync(2000);
		const result = await pending;
		const grantCall = f.auth.mock.calls[0][1];
		expect(grantCall.url).toBe('https://console.nace.ai/v1/documents/upload-grants');
		expect(grantCall.body.path).toMatch(/^n8n\/[a-z0-9]{16}\/invoice-42\.pdf$/);
		expect(grantCall.body).toMatchObject({
			total_size_bytes: invoiceBytes.length,
			ttl_seconds: 600,
		});
		const upload = f.plain.mock.calls[0][0];
		expect(upload).toMatchObject({
			method: 'POST',
			url: UPLOAD_URL,
			json: false,
			disableFollowRedirect: true,
			headers: { 'X-Upload-Token': UPLOAD_TOKEN, 'User-Agent': CLIENT },
		});
		expect(upload.headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/);
		expect(upload.headers).not.toHaveProperty('Authorization');
		expect(Buffer.isBuffer(upload.body)).toBe(true);
		expect(upload.body.indexOf(invoiceBytes)).toBeGreaterThan(0);
		const uploadText = upload.body.toString('utf8');
		expect(uploadText).toContain('name="metadata"');
		expect(JSON.parse(/name="metadata"\r\n\r\n(\{[^\r]+\})\r\n/.exec(uploadText)![1])).toEqual({
			path: grantCall.body.path,
			total_size_bytes: invoiceBytes.length,
		});
		expect(f.auth.mock.calls[1][1]).toMatchObject({
			method: 'POST',
			url: 'https://console.nace.ai/v1/documents/parse',
			body: {
				source: { type: 'workspace_file', workspace_id: 'ws-9', file_id: 'file-7' },
				parse_mode: 'low',
			},
		});
		expect(f.auth.mock.calls[2][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/jobs/job-2',
		});
		expect(f.auth.mock.calls[3][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/workspaces/ws-9/files/file-7',
		});
		expect(f.auth.mock.calls[4][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/workspaces/ws-9/files/file-7',
		});
		expect(result[0][0].json).toMatchObject({
			job_id: 'job-2',
			document: { text: 'Invoice' },
			cleanup: { job_deleted: true, file_deleted: true },
		});
		// A hostile MIME type cannot inject part headers.
		const hostile = fake(
			{ source: 'binary', binaryPropertyName: 'data' },
			{},
			[
				{
					json: {},
					binary: {
						data: {
							data: '',
							mimeType: 'application/pdf\r\n\r\nX-Injected: yes',
							fileName: 'invoice-42.pdf',
						},
					},
				},
			],
			{ data: invoiceBytes },
		);
		hostile.auth
			.mockResolvedValueOnce(grant())
			.mockResolvedValueOnce(full(200, job('job-9', 'succeeded', { document: {} })))
			.mockResolvedValueOnce(full(204, ''))
			.mockResolvedValueOnce(full(200, { status: 'deleted' }));
		hostile.plain.mockResolvedValueOnce(uploadJob());
		await hostile.run();
		const hostileText = hostile.plain.mock.calls[0][0].body.toString('utf8');
		expect(hostileText).toContain(
			'Content-Disposition: form-data; name="file"; filename="invoice-42.pdf"\r\nContent-Type: application/octet-stream\r\n\r\n',
		);
		expect(hostileText).not.toContain('X-Injected');
		// An unconfirmed file deletion surfaces the identifiers for manual cleanup.
		const unconfirmed = fake(
			{ source: 'binary', binaryPropertyName: 'data' },
			{},
			[{ json: {}, binary: { data: invoice } }],
			{ data: invoiceBytes },
		);
		unconfirmed.auth
			.mockResolvedValueOnce(grant())
			.mockResolvedValueOnce(full(200, job('job-12', 'succeeded', { document: {} })))
			.mockResolvedValueOnce(full(204, ''))
			.mockResolvedValue(full(202, { status: 'deleting' }));
		unconfirmed.plain.mockResolvedValueOnce(uploadJob());
		const unconfirmedRun = unconfirmed.run();
		await vi.advanceTimersByTimeAsync(4000);
		const unconfirmedResult = await unconfirmedRun;
		expect(unconfirmedResult[0][0].json.cleanup).toEqual({
			job_deleted: true,
			file_deleted: false,
			workspace_id: 'ws-9',
			file_id: 'file-7',
		});
	});

	it('deletes the uploaded file and the job when the job fails, and reports the job message', async () => {
		const f = fake({ source: 'binary' }, {}, [{ json: {}, binary: { data: invoice } }], {
			data: invoiceBytes,
		});
		f.auth
			.mockResolvedValueOnce(grant())
			.mockResolvedValueOnce(
				full(202, {
					job_id: 'job-3',
					kind: 'document_parse',
					status: 'failed',
					error: { code: 'parse_failed', message: 'Could not parse the document' },
				}),
			)
			.mockResolvedValueOnce(full(204, ''))
			.mockResolvedValueOnce(full(200, { status: 'deleted' }));
		f.plain.mockResolvedValueOnce(uploadJob());
		await expect(f.run()).rejects.toThrow('Nace job failed: Could not parse the document [Item 1]');
		expect(f.auth.mock.calls[2][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/jobs/job-3',
		});
		expect(f.auth.mock.calls[3][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/workspaces/ws-9/files/file-7',
		});
	});

	it('refuses a Source value that is neither Binary File nor URL before any HTTP call', async () => {
		const f = fake({ source: 'ftp' });
		await expect(f.run()).rejects.toThrow("'Source' must be Binary File or URL");
		expect(f.auth).not.toHaveBeenCalled();
		expect(f.plain).not.toHaveBeenCalled();
	});

	it('retries a 503 job_pending create with the same Idempotency-Key and succeeds', async () => {
		vi.useFakeTimers();
		const f = fake();
		f.auth
			.mockResolvedValueOnce(
				full(503, { error: { code: 'job_pending', message: 'The job is still starting' } }),
			)
			.mockResolvedValueOnce(
				full(200, job('job-11', 'succeeded', { document: { markdown: 'ok' } })),
			)
			.mockResolvedValue(full(204, ''));
		const pending = f.run();
		await vi.advanceTimersByTimeAsync(2000);
		const result = await pending;
		const create = f.auth.mock.calls[0][1];
		const retry = f.auth.mock.calls[1][1];
		expect(create.url).toBe('https://console.nace.ai/v1/documents/parse');
		expect(create.headers['Idempotency-Key']).toMatch(/^n8n-/);
		expect(retry.headers['Idempotency-Key']).toBe(create.headers['Idempotency-Key']);
		expect(f.auth).toHaveBeenCalledTimes(3);
		expect(result[0][0].json).toMatchObject({
			job_id: 'job-11',
			document: { markdown: 'ok' },
			cleanup: { job_deleted: true },
		});
	});

	it('names the uploaded file and the job when the job fails and cleanup cannot be confirmed', async () => {
		const f = fake({ source: 'binary' }, {}, [{ json: {}, binary: { data: invoice } }], {
			data: invoiceBytes,
		});
		f.auth
			.mockResolvedValueOnce(grant())
			.mockResolvedValueOnce(
				full(202, {
					job_id: 'job-10',
					kind: 'document_parse',
					status: 'failed',
					error: { code: 'parse_failed', message: 'Could not parse the document' },
				}),
			)
			.mockResolvedValueOnce(full(503, { error: { message: 'Unavailable' } }))
			.mockResolvedValueOnce(full(503, { error: { message: 'Unavailable' } }));
		f.plain.mockResolvedValueOnce(uploadJob());
		await expect(f.run()).rejects.toSatisfy((error: NodeApiError) => {
			expect(error.message).toBe('Nace job failed: Could not parse the document [Item 1]');
			expect(error.description).toContain('Job ID: job-10');
			expect(error.description).toContain(
				'The job job-10 could not be deleted. Delete it in your Nace account.',
			);
			expect(error.description).toContain(
				'The uploaded file file-7 in workspace ws-9 could not be confirmed as deleted. Delete it in your Nace account.',
			);
			return true;
		});
	});

	it('extracts with the schema and instructions and returns data and fields', async () => {
		const schema = {
			type: 'object',
			properties: { vendor: { type: 'string' }, total: { type: 'number' } },
		};
		const f = fake({
			operation: 'extract',
			url: 'https://files.example.test/contract.pdf',
			schema: JSON.stringify(schema),
			options: { instructions: 'Extract the vendor and the total' },
		});
		f.auth
			.mockResolvedValueOnce(
				full(200, {
					job_id: 'job-4',
					kind: 'document_extract',
					status: 'succeeded',
					result: {
						data: { vendor: 'Nace', total: 42 },
						fields: { vendor: { status: 'extracted', citations: ['file-7:2'] } },
					},
					cost: 0.05,
				}),
			)
			.mockResolvedValue(full(204, ''));
		const result = await f.run();
		expect(f.auth.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			url: 'https://console.nace.ai/v1/documents/extract',
			qs: { wait_seconds: 60 },
			body: {
				source: {
					type: 'url',
					url: 'https://files.example.test/contract.pdf',
					file_name: 'contract.pdf',
				},
				parse_mode: 'low',
				schema,
				instructions: 'Extract the vendor and the total',
			},
		});
		expect(result[0][0].json).toMatchObject({
			job_id: 'job-4',
			data: { vendor: 'Nace', total: 42 },
			fields: { vendor: { status: 'extracted', citations: ['file-7:2'] } },
			cost: 0.05,
			cleanup: { job_deleted: true },
		});
	});

	it('polls a running job until it succeeds and reports the timeout after Max Wait', async () => {
		vi.useFakeTimers();
		const f = fake();
		f.auth
			.mockResolvedValueOnce(full(202, job('job-5', 'running', null, { result_state: 'pending' })))
			.mockResolvedValueOnce(full(202, job('job-5', 'running', null)))
			.mockResolvedValueOnce(full(200, job('job-5', 'succeeded', { document: { markdown: 'ok' } })))
			.mockResolvedValue(full(204, ''));
		const pending = f.run();
		await vi.advanceTimersByTimeAsync(2000);
		const result = await pending;
		expect(f.auth.mock.calls[0][1].qs).toEqual({ wait_seconds: 60 });
		expect(f.auth.mock.calls[1][1]).toMatchObject({
			method: 'GET',
			url: 'https://console.nace.ai/v1/documents/jobs/job-5',
			qs: { wait_seconds: 25 },
		});
		expect(f.auth.mock.calls[2][1]).toMatchObject({
			method: 'GET',
			url: 'https://console.nace.ai/v1/documents/jobs/job-5',
		});
		expect(result[0][0].json).toMatchObject({
			job_id: 'job-5',
			document: { markdown: 'ok' },
			cleanup: { job_deleted: true },
		});
		const slow = fake({ options: { maxWait: 1 } });
		slow.auth.mockImplementation(async () => full(202, job('job-6', 'running', null)));
		const failure = expect(slow.run()).rejects.toThrow(
			"The job job-6 did not finish in 1 seconds. Increase 'Max Wait (Seconds)'. [Item 1]",
		);
		await vi.advanceTimersByTimeAsync(5000);
		await failure;
		expect(slow.auth).toHaveBeenCalledTimes(4);
		expect(slow.auth.mock.calls[3][1]).toMatchObject({
			method: 'DELETE',
			url: 'https://console.nace.ai/v1/documents/jobs/job-6',
		});
	});

	it('searches the workspace path for both fact and agent answers without deleting jobs', async () => {
		const f = fake({
			resource: 'workspace',
			operation: 'search',
			workspaceId: 'ws-7',
			query: 'What is the total of invoice 42?',
			searchOptions: { topK: 3, pathPrefix: 'invoices/2026', context: 'Billing files only' },
		});
		const evidences = [{ file_id: 'file-1', page: 2, text: 'Total: 42 EUR' }];
		f.auth.mockResolvedValueOnce(
			full(
				200,
				{
					job_id: 'job-7',
					kind: 'automatic_search',
					status: 'succeeded',
					result: {
						output: {
							answer: 'The total is 42 EUR',
							confidence: 0.9,
							evidences,
							structured_answer: { total: 42 },
							routing: 'fact',
						},
					},
					cost: 0.02,
				},
				{ 'x-request-id': 'req-search' },
			),
		);
		const fact = await f.run();
		expect(f.auth).toHaveBeenCalledTimes(1);
		expect(f.auth.mock.calls[0][1]).toMatchObject({
			method: 'POST',
			url: 'https://console.nace.ai/v1/workspaces/ws-7/automatic-search',
			qs: { wait_seconds: 60 },
			body: {
				query: 'What is the total of invoice 42?',
				mode: 'auto',
				top_k: 3,
				path_prefix: 'invoices/2026',
				context: 'Billing files only',
			},
		});
		expect(fact[0][0].json).toMatchObject({
			job_id: 'job-7',
			request_id: 'req-search',
			answer: 'The total is 42 EUR',
			confidence: 0.9,
			evidences,
			structured_answer: { total: 42 },
			cost: 0.02,
		});
		expect(fact[0][0].json.output.evidences).not.toBeNull();
		expect(fact[0][0].json.output.evidences).toEqual(evidences);
		expect(fact[0][0].json.evidences).toEqual(fact[0][0].json.output.evidences);
		const agent = fake({
			resource: 'workspace',
			operation: 'search',
			workspaceId: 'ws-7',
			query: 'Summarize the refunds',
		});
		agent.auth.mockResolvedValueOnce(
			full(200, {
				job_id: 'job-8',
				kind: 'automatic_search',
				status: 'succeeded',
				result: {
					output: {
						answer: {
							answer: 'Two refunds',
							confidence: 0.8,
							evidences: [1, 2],
							structured_answer: { refunds: 2 },
						},
					},
				},
				cost: 0.03,
			}),
		);
		const agentResult = await agent.run();
		expect(agent.auth).toHaveBeenCalledTimes(1);
		expect(agentResult[0][0].json).toMatchObject({
			answer: 'Two refunds',
			confidence: 0.8,
			evidences: [1, 2],
			structured_answer: { refunds: 2 },
		});
		expect(agentResult[0][0].json.output.answer.evidences).not.toBeNull();
		expect(agentResult[0][0].json.output.answer.evidences).toEqual([1, 2]);
		expect(agentResult[0][0].json.evidences).toEqual(
			agentResult[0][0].json.output.answer.evidences,
		);
	});

	it('refuses OpenRouter before HTTP and refuses a non-HTTPS upload URL without sending the token', async () => {
		const openRouter = fake({}, { backend: 'openrouter' });
		await expect(openRouter.run()).rejects.toThrow(
			"'Backend': Nace Document Intelligence needs the Nace backend. OpenRouter serves only Drex models. [Item 1]",
		);
		expect(openRouter.auth).not.toHaveBeenCalled();
		const insecure = fake({ source: 'binary' }, {}, [{ json: {}, binary: { data: invoice } }], {
			data: invoiceBytes,
		});
		insecure.auth.mockResolvedValueOnce(grant('http://ndi-insecure.example.test/v1/files'));
		await expect(insecure.run()).rejects.toThrow('not a plain HTTPS URL');
		expect(insecure.auth).toHaveBeenCalledTimes(1);
		expect(insecure.plain).not.toHaveBeenCalled();
		const strayOperation = fake({ resource: 'workspace', operation: 'browse' });
		await expect(strayOperation.run()).rejects.toThrow(
			"'Operation' must be Search for the Workspace resource",
		);
		expect(strayOperation.auth).not.toHaveBeenCalled();
		const strayResource = fake({ resource: 'staging' });
		await expect(strayResource.run()).rejects.toThrow("'Resource' must be Document or Workspace");
		expect(strayResource.auth).not.toHaveBeenCalled();
		const emptySchema = fake({ operation: 'extract', schema: '{"type":"object","properties":{}}' });
		await expect(emptySchema.run()).rejects.toThrow(
			"'Schema (JSON)' must be an object schema with at least one property",
		);
		expect(emptySchema.auth).not.toHaveBeenCalled();
	});

	it('continues with an error item that never contains the API key', async () => {
		const secret = 'synthetic-ndi-secret-key';
		const f = fake({}, { apiKey: secret });
		f.auth.mockResolvedValueOnce(
			full(422, { error: { code: 'invalid_request', message: `Rejected ${secret}` } }),
		);
		f.raw.continueOnFail = () => true;
		const result = await f.run();
		expect(result[0][0]).toMatchObject({
			json: {
				error: 'Rejected [REDACTED] [Item 1]',
				description: 'Code: invalid_request [Item 1]',
			},
			pairedItem: { item: 0 },
		});
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it('loads workspaces as options', async () => {
		const f = fake();
		f.auth.mockResolvedValueOnce(
			full(200, {
				items: [
					{ workspace_id: 'ws-1', name: 'Invoices', status: 'active' },
					{ workspace_id: 'ws-2', name: 'Contracts', status: 'active' },
				],
				next_cursor: null,
				total_count: 2,
			}),
		);
		const options = await getWorkspaces.call(f.raw as never);
		expect(options).toEqual([
			{ name: 'Invoices', value: 'ws-1' },
			{ name: 'Contracts', value: 'ws-2' },
		]);
		expect(f.auth.mock.calls[0][1]).toMatchObject({
			method: 'GET',
			url: 'https://console.nace.ai/v1/workspaces',
			qs: { limit: 200 },
		});
	});

	it('registers the node in package.json without runtime dependencies', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
			dependencies?: unknown;
			n8n: { nodes: string[] };
		};
		expect(pkg.n8n.nodes).toContain(
			'dist/nodes/NaceDocumentIntelligence/NaceDocumentIntelligence.node.js',
		);
		expect(pkg).not.toHaveProperty('dependencies');
		expect(pkg.dependencies).toBeUndefined();
	});

	it('shows Chunking for Parse and Instructions for Extract inside Options', () => {
		const node = { typeVersion: 1 };
		const values = (operation: string): INodeParameters => ({
			resource: 'document',
			operation,
		});
		const fields = (properties.find((property) => property.name === 'options')!.options ??
			[]) as INodeProperties[];
		const chunking = fields.find((field) => field.name === 'chunking')!;
		const instructions = fields.find((field) => field.name === 'instructions')!;
		expect(NodeHelpers.displayParameterPath(values('parse'), chunking, 'options', node, null)).toBe(
			true,
		);
		expect(
			NodeHelpers.displayParameterPath(values('extract'), chunking, 'options', node, null),
		).toBe(false);
		expect(
			NodeHelpers.displayParameterPath(values('extract'), instructions, 'options', node, null),
		).toBe(true);
		expect(
			NodeHelpers.displayParameterPath(values('parse'), instructions, 'options', node, null),
		).toBe(false);
	});
});
