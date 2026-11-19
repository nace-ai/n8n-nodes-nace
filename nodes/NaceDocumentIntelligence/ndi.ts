import type {
	IBinaryData,
	ICredentialDataDecryptedObject,
	IDataObject,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeOperationError, randomString, sleep } from 'n8n-workflow';
import { retryDelay } from '../Nace/api';
import { CLIENT } from '../Nace/constants';
import { resolveBaseUrl } from '../Nace/baseUrl';
import {
	apiFailure,
	cleanJson,
	cleanText,
	isObject,
	itemText,
	operationFailure,
	scalarId,
	unexpected,
} from '../Nace/safety';

export interface NdiRequestContext {
	getNode(): INode;
	getCredentials(name: string): Promise<ICredentialDataDecryptedObject>;
	helpers: {
		httpRequestWithAuthentication: (
			credentialsType: string,
			options: IHttpRequestOptions,
		) => Promise<unknown>;
	};
}
export interface NdiContext extends NdiRequestContext {
	helpers: NdiRequestContext['helpers'] & {
		httpRequest: (options: IHttpRequestOptions) => Promise<unknown>;
		assertBinaryData: (itemIndex: number, propertyName: string) => IBinaryData;
		getBinaryDataBuffer: (itemIndex: number, propertyName: string) => Promise<Buffer>;
	};
}
interface FullResponse {
	statusCode: number;
	headers?: Record<string, unknown>;
	body?: unknown;
}
interface NdiRequest {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	qs?: IDataObject;
	body?: IDataObject;
	headers?: Record<string, string>;
	// A 503 whose body has error.code job_pending may mean the job create is already running.
	retryJobPending?: boolean;
	timeout: number;
	itemIndex?: number;
}
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const RETRIES = 5;
const GRANT_TIMEOUT = 60000;
const UPLOAD_TIMEOUT = 120000;
const FINAL_STATES = ['succeeded', 'failed', 'cancelled'];

function failOperation(node: INode, itemIndex: number | undefined, message: string): never {
	throw new NodeOperationError(node, itemText(message, itemIndex), { itemIndex });
}
function firstHeader(value: unknown): unknown {
	return Array.isArray(value) ? value[0] : value;
}
function hasExtension(name: string): boolean {
	const dot = name.lastIndexOf('.');
	return dot > 0 && dot < name.length - 1;
}
// The node has no file id while the upload is not confirmed, so it cannot delete the file itself.
function uploadPathDescription(path: string): string {
	return `The upload path was ${path}. If the file exists in your Nace account, delete it there.`;
}
export function lastSegment(name: string): string {
	return name.split(/[\\/]/).pop() || '';
}
export async function ndiRequest(
	context: NdiRequestContext,
	request: NdiRequest,
): Promise<{ data: IDataObject; requestId: string | number | undefined }> {
	const node = context.getNode();
	const credentials = await context.getCredentials('naceApi');
	const secret = String(credentials.apiKey || '');
	let baseUrl: string;
	try {
		if (credentials.backend === 'openrouter')
			failOperation(
				node,
				request.itemIndex,
				"'Backend': Nace Document Intelligence needs the Nace backend. OpenRouter serves only Drex models.",
			);
		baseUrl = resolveBaseUrl(credentials, node, request.itemIndex);
	} catch (error) {
		// Projection drops the raw node object and keeps the message, like the Drex node does.
		throw operationFailure(node, secret, error, request.itemIndex);
	}
	const headers: Record<string, string> = {
		'User-Agent': CLIENT,
		'X-Nace-Client': CLIENT,
		...(request.headers ?? {}),
	};
	let totalSleep = 0;
	for (let attempt = 0; ; attempt++) {
		let response: FullResponse;
		const options: IHttpRequestOptions = {
			method: request.method,
			url: `${baseUrl}${request.path}`,
			headers,
			timeout: request.timeout,
			maxResponseBodyBytes: MAX_RESPONSE_BYTES,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			...(request.qs === undefined ? {} : { qs: request.qs }),
			...(request.body === undefined ? {} : { body: request.body }),
		};
		try {
			response = (await context.helpers.httpRequestWithAuthentication.call(
				context,
				'naceApi',
				options,
			)) as FullResponse;
		} catch (error) {
			throw apiFailure(node, secret, error, {
				message: cleanText(
					(error as { message?: unknown }).message,
					secret,
					'Nace request could not be completed',
				),
				itemIndex: request.itemIndex,
			});
		}
		const responseHeaders = Object.fromEntries(
			Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
		);
		const data = isObject(response.body) ? response.body : undefined;
		const jobPending =
			request.retryJobPending === true &&
			response.statusCode === 503 &&
			isObject(data?.error) &&
			data.error.code === 'job_pending';
		if (
			([429, 529].includes(response.statusCode) || jobPending) &&
			attempt < RETRIES &&
			totalSleep < 120000
		) {
			const delay = Math.min(retryDelay(responseHeaders, attempt), 60000, 120000 - totalSleep);
			await sleep(delay);
			totalSleep += delay;
			continue;
		}
		const requestId =
			scalarId(data?.request_id) ?? scalarId(firstHeader(responseHeaders['x-request-id']));
		if (response.statusCode >= 200 && response.statusCode < 300)
			return {
				data: data === undefined ? {} : (cleanJson(data, secret) as IDataObject),
				requestId,
			};
		const error = isObject(data?.error) ? data.error : {};
		const message =
			response.statusCode === 401
				? "'API Key': Check your Nace API credential."
				: response.statusCode === 402
					? 'Insufficient funds. Add funds in Billing: https://console.nace.ai'
					: cleanText(error.message, secret, `Nace API returned status ${response.statusCode}`);
		const code = cleanText(error.code, secret);
		throw apiFailure(node, secret, data, {
			status: response.statusCode,
			message,
			...(code === '' ? {} : { description: `Code: ${code}` }),
			requestId,
			itemIndex: request.itemIndex,
		});
	}
}
export async function uploadBinary(
	context: NdiContext,
	itemIndex: number,
	binaryPropertyName: string,
	timeout = UPLOAD_TIMEOUT,
): Promise<{ workspaceId: string; fileId: string }> {
	const node = context.getNode();
	const binary = context.helpers.assertBinaryData(itemIndex, binaryPropertyName);
	const buffer = await context.helpers.getBinaryDataBuffer(itemIndex, binaryPropertyName);
	const name = lastSegment(
		String(binary.fileName || (binary.fileExtension ? `document.${binary.fileExtension}` : '')),
	);
	if (!name || name === '.' || name === '..' || !hasExtension(name))
		failOperation(
			node,
			itemIndex,
			`'Input Binary Field': The file in '${binaryPropertyName}' needs a name with an extension, for example invoice.pdf`,
		);
	const path = `n8n/${randomString(16).toLowerCase()}/${name}`;
	const credentials = await context.getCredentials('naceApi');
	const secret = String(credentials.apiKey || '');
	const { data: grant } = await ndiRequest(context, {
		method: 'POST',
		path: '/v1/documents/upload-grants',
		body: { path, total_size_bytes: buffer.length, ttl_seconds: 600 },
		timeout: GRANT_TIMEOUT,
		itemIndex,
	});
	if (
		typeof grant.upload_url !== 'string' ||
		!grant.upload_url ||
		typeof grant.token !== 'string' ||
		!grant.token
	)
		throw unexpected(
			node,
			secret,
			'Nace',
			'Expected an upload grant with upload_url and token.',
			itemIndex,
		);
	let uploadUrl: URL | undefined;
	try {
		uploadUrl = new URL(grant.upload_url);
	} catch {
		uploadUrl = undefined;
	}
	const baseOrigin = new URL(resolveBaseUrl(credentials, node, itemIndex)).origin;
	if (
		!uploadUrl ||
		uploadUrl.username ||
		uploadUrl.password ||
		(uploadUrl.protocol !== 'https:' && uploadUrl.origin !== baseOrigin)
	)
		failOperation(
			node,
			itemIndex,
			`'Input Binary Field': Nace returned an upload URL that is not a plain HTTPS URL. The upload was not attempted, so the upload token was not sent.`,
		);
	const boundary = randomString(30);
	// Strip control characters (char codes 0-31 and 127) and quotes from the header value.
	const headerName = Array.from(name)
		.filter((char) => {
			const code = char.charCodeAt(0);
			return code > 31 && code !== 127 && char !== '"';
		})
		.join('');
	const partType =
		typeof binary.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(binary.mimeType)
			? binary.mimeType
			: 'application/octet-stream';
	const metadata = JSON.stringify({ path, total_size_bytes: buffer.length });
	const body: Buffer = Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${headerName}"\r\nContent-Type: ${partType}\r\n\r\n`,
		),
		buffer,
		Buffer.from(
			`\r\n--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${metadata}\r\n--${boundary}--\r\n`,
		),
	]);
	let response: FullResponse;
	try {
		response = (await context.helpers.httpRequest.call(context, {
			method: 'POST',
			url: grant.upload_url,
			body,
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
				'X-Upload-Token': grant.token,
				'User-Agent': CLIENT,
			},
			timeout,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			json: false,
		})) as FullResponse;
	} catch (error) {
		const transport = cleanText(
			(error as { message?: unknown }).message,
			secret,
			'Nace upload could not be completed',
		);
		throw apiFailure(
			node,
			secret,
			{},
			{
				message: grant.token ? transport.split(grant.token).join('[REDACTED]') : transport,
				description: uploadPathDescription(path),
				itemIndex,
			},
		);
	}
	let data: unknown = response.body;
	if (typeof response.body === 'string' || Buffer.isBuffer(response.body)) {
		const text = typeof response.body === 'string' ? response.body : response.body.toString('utf8');
		try {
			data = JSON.parse(text);
		} catch {
			data = undefined;
		}
	}
	const file =
		isObject(data) && isObject(data.result) && isObject(data.result.file)
			? (data.result as IDataObject).file
			: undefined;
	if (
		response.statusCode >= 200 &&
		response.statusCode < 300 &&
		isObject(file) &&
		typeof file.file_id === 'string' &&
		typeof file.workspace_id === 'string'
	)
		return { workspaceId: file.workspace_id, fileId: file.file_id };
	const cleaned = isObject(data) ? (cleanJson(data, grant.token) as IDataObject) : {};
	const error = isObject(cleaned.error) ? cleaned.error : {};
	throw apiFailure(node, secret, cleaned, {
		status: response.statusCode,
		message: cleanText(error.message, secret, `Nace upload returned status ${response.statusCode}`),
		description: uploadPathDescription(path),
		itemIndex,
	});
}
export async function runJob(
	context: NdiRequestContext,
	itemIndex: number | undefined,
	path: string,
	body: IDataObject,
	maxWaitSeconds: number,
	jobId?: { current?: string },
): Promise<{ job: IDataObject; requestId: string | number | undefined }> {
	const node = context.getNode();
	const credentials = await context.getCredentials('naceApi');
	const secret = String(credentials.apiKey || '');
	const started = Date.now();
	const createWait = Math.max(1, Math.min(60, Math.ceil(maxWaitSeconds)));
	// One key per runJob call: retries of this create reuse it, so Nace returns the same job.
	const idempotencyKey = `n8n-${randomString(32)}`;
	let { data: job, requestId } = await ndiRequest(context, {
		method: 'POST',
		path,
		qs: { wait_seconds: createWait },
		body,
		headers: { 'Idempotency-Key': idempotencyKey },
		retryJobPending: true,
		timeout: (createWait + 30) * 1000,
		itemIndex,
	});
	for (;;) {
		const id = typeof job.job_id === 'string' ? job.job_id : undefined;
		if (id !== undefined && jobId) jobId.current = id;
		const status = typeof job.status === 'string' ? job.status : undefined;
		if (id === undefined || status === undefined)
			throw unexpected(
				node,
				secret,
				'Nace',
				'Expected a job response with job_id and status.',
				itemIndex,
				requestId,
			);
		if (FINAL_STATES.includes(status)) {
			const error = isObject(job.error) ? job.error : {};
			if (status !== 'succeeded') {
				const code = cleanText(error.code, secret);
				throw apiFailure(node, secret, job, {
					message: `Nace job ${status}: ${cleanText(error.message, secret, 'no error message')}`,
					description: `${code === '' ? '' : `Code: ${code}\n`}Job ID: ${id}`,
					requestId,
					itemIndex,
				});
			}
			if (!isObject(job.result))
				throw unexpected(
					node,
					secret,
					'Nace',
					`Expected a result object in the finished job. The job result state is ${cleanText(job.result_state, secret, 'unknown')}.`,
					itemIndex,
					requestId,
				);
			return { job, requestId };
		}
		if (Date.now() - started > maxWaitSeconds * 1000)
			throw new NodeOperationError(
				node,
				itemText(
					`The job ${id} did not finish in ${maxWaitSeconds} seconds. Increase 'Max Wait (Seconds)'.`,
					itemIndex,
				),
				{ itemIndex },
			);
		await sleep(1000);
		const remaining = Math.ceil((maxWaitSeconds * 1000 - (Date.now() - started)) / 1000);
		const pollWait = Math.max(1, Math.min(25, remaining));
		const poll = await ndiRequest(context, {
			method: 'GET',
			path: `/v1/documents/jobs/${encodeURIComponent(id)}`,
			qs: { wait_seconds: pollWait },
			timeout: (pollWait + 30) * 1000,
			itemIndex,
		});
		job = poll.data;
		requestId = poll.requestId ?? requestId;
	}
}
export async function deleteJob(context: NdiRequestContext, jobId: string): Promise<boolean> {
	try {
		await ndiRequest(context, {
			method: 'DELETE',
			path: `/v1/documents/jobs/${encodeURIComponent(jobId)}`,
			timeout: 60000,
		});
		return true;
	} catch {
		return false;
	}
}
export async function deleteFile(
	context: NdiRequestContext,
	workspaceId: string,
	fileId: string,
): Promise<boolean> {
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			const { data } = await ndiRequest(context, {
				method: 'DELETE',
				path: `/v1/documents/workspaces/${encodeURIComponent(workspaceId)}/files/${encodeURIComponent(fileId)}`,
				timeout: 60000,
			});
			if (data.status === 'deleted') return true;
			if (data.status !== 'deleting') return false;
			if (attempt < 2) await sleep(2000);
		}
		return false;
	} catch {
		return false;
	}
}
export async function getWorkspaces(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const credentials = await this.getCredentials('naceApi');
	const secret = String(credentials.apiKey || '');
	const workspaces: INodePropertyOptions[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 5; page++) {
		const { data } = await ndiRequest(this, {
			method: 'GET',
			path: '/v1/workspaces',
			qs: { limit: 200, ...(cursor === undefined ? {} : { cursor }) },
			timeout: 60000,
		});
		if (!Array.isArray(data.items))
			throw unexpected(this.getNode(), secret, 'Nace', 'Expected a workspaces array.');
		for (const workspace of data.items as unknown[])
			if (
				isObject(workspace) &&
				typeof workspace.workspace_id === 'string' &&
				workspace.workspace_id !== ''
			)
				workspaces.push({
					name: cleanText(workspace.name, secret, 'Workspace'),
					value: workspace.workspace_id,
				});
		const next = data.next_cursor;
		if (typeof next !== 'string' || !next) break;
		cursor = next;
	}
	return workspaces;
}
