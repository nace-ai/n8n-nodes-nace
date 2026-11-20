import type {
	IBinaryData,
	ICredentialDataDecryptedObject,
	IDataObject,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodePropertyOptions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, randomString, sleep } from 'n8n-workflow';
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
	// Epoch milliseconds. No request is sent at or after this job deadline, and each request's
	// HTTP timeout is capped to the remaining time before it.
	deadline?: number;
	timeout: number;
	itemIndex?: number;
}
// Nace keeps an HTTP request open for at most 100 seconds, so wait_seconds cannot exceed it.
const SERVER_WAIT_LIMIT = 100;
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
// Upload ids reach output cleanup and delete URLs, so they must be plain identifiers: never echoes
// of the API key or upload token, and never whitespace or control characters.
function safeUploadId(value: unknown, secret: string, token: string): string | undefined {
	if (typeof value !== 'string' || !value || value === secret || value === token) return undefined;
	if (value.length > 256 || /\s/.test(value)) return undefined;
	return Array.from(value).every((char) => {
		const code = char.charCodeAt(0);
		return code > 31 && code !== 127;
	})
		? value
		: undefined;
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
			// With a job deadline, an HTTP request never outlives the remaining Max Wait budget.
			timeout:
				request.deadline === undefined
					? request.timeout
					: Math.max(1, Math.min(request.timeout, request.deadline - Date.now())),
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
		const delay = Math.min(retryDelay(responseHeaders, attempt), 60000, 120000 - totalSleep);
		// Max Wait bounds retries too: a retry whose send would land at or after the job deadline is
		// not made, so the last response's error surfaces instead.
		const sendableBeforeDeadline =
			request.deadline === undefined || Date.now() + delay < request.deadline;
		if (
			([429, 529].includes(response.statusCode) || jobPending) &&
			attempt < RETRIES &&
			totalSleep < 120000 &&
			sendableBeforeDeadline
		) {
			await sleep(delay);
			totalSleep += delay;
			// Timers can fire late; recheck so a retry never starts after the deadline.
			if (request.deadline === undefined || Date.now() < request.deadline) continue;
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
		// A rejected job create can still retain the request data; Nace names that job in this header.
		const rejectedJobId = scalarId(firstHeader(responseHeaders['x-drex-document-job']));
		const failure = apiFailure(node, secret, data, {
			status: response.statusCode,
			message,
			...(code === '' ? {} : { description: `Code: ${code}` }),
			requestId,
			itemIndex: request.itemIndex,
		}) as NodeApiError & { jobId?: string | number };
		if (rejectedJobId !== undefined) failure.jobId = rejectedJobId;
		throw failure;
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
	const uploaded =
		isObject(file)
			? {
					fileId: safeUploadId(file.file_id, secret, grant.token),
					workspaceId: safeUploadId(file.workspace_id, secret, grant.token),
				}
			: undefined;
	if (response.statusCode >= 200 && response.statusCode < 300) {
		if (uploaded?.fileId !== undefined && uploaded?.workspaceId !== undefined)
			return { workspaceId: uploaded.workspaceId, fileId: uploaded.fileId };
		throw apiFailure(node, secret, {}, {
			status: response.statusCode,
			message: 'Nace upload did not return a usable file and workspace ID.',
			description: uploadPathDescription(path),
			itemIndex,
		});
	}
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
	// Max Wait bounds the whole job run: create waits, retries, and polling never continue past it.
	const deadline = started + maxWaitSeconds * 1000;
	// The create wait uses the whole budget up to the longest Nace keeps an HTTP request open, so a
	// finished job is delivered directly; polling cannot recover a result that Nace did not retain.
	const createWait = Math.max(1, Math.min(SERVER_WAIT_LIMIT, Math.ceil(maxWaitSeconds)));
	// One key per runJob call: retries of this create reuse it, so Nace returns the same job.
	const idempotencyKey = `n8n-${randomString(32)}`;
	const didNotFinish = (id: string): NodeOperationError =>
		new NodeOperationError(
			node,
			itemText(
				`The job ${id} did not finish in ${maxWaitSeconds} seconds. Increase 'Max Wait (Seconds)'.`,
				itemIndex,
			),
			{ itemIndex },
		);
	let job: IDataObject;
	let requestId: string | number | undefined;
	try {
		({ data: job, requestId } = await ndiRequest(context, {
			method: 'POST',
			path,
			qs: { wait_seconds: createWait },
			body,
			headers: { 'Idempotency-Key': idempotencyKey },
			retryJobPending: true,
			timeout: (createWait + 30) * 1000,
			deadline,
			itemIndex,
		}));
	} catch (error) {
		// A rejected create can still leave a job with the retained request data; keep its id for cleanup.
		const rejectedJobId = scalarId((error as { jobId?: unknown }).jobId);
		if (jobId !== undefined && rejectedJobId !== undefined) jobId.current = String(rejectedJobId);
		// ndiRequest already builds node errors; re-wrap so the rejection keeps its message and description.
		throw operationFailure(node, secret, error, itemIndex);
	}
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
		// A result that arrives after the deadline is a timeout, not a success.
		if (Date.now() >= deadline) throw didNotFinish(id);
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
			if (!isObject(job.result)) {
				if (job.result_state === 'not_retained')
					throw apiFailure(node, secret, {}, {
						message: `The result of job ${id} was not retained.`,
						description: `Zero-retention accounts deliver a result only while the create request waits, so polling cannot recover it. Increase 'Max Wait (Seconds)' so the create can wait for the job (it waits up to ${SERVER_WAIT_LIMIT} seconds), or open the job in your Nace console. Running this node again starts a new job and can bill again.\nJob ID: ${id}`,
						requestId,
						itemIndex,
					});
				throw unexpected(
					node,
					secret,
					'Nace',
					`Expected a result object in the finished job. The job result state is ${cleanText(job.result_state, secret, 'unknown')}.`,
					itemIndex,
					requestId,
				);
			}
			return { job, requestId };
		}
		await sleep(Math.min(1000, deadline - Date.now()));
		// No poll is issued at or past the deadline: its response could not be accepted.
		if (Date.now() >= deadline) throw didNotFinish(id);
		const pollWait = Math.max(1, Math.min(25, Math.floor((deadline - Date.now()) / 1000)));
		const poll = await ndiRequest(context, {
			method: 'GET',
			path: `/v1/documents/jobs/${encodeURIComponent(id)}`,
			qs: { wait_seconds: pollWait },
			timeout: (pollWait + 30) * 1000,
			deadline,
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
