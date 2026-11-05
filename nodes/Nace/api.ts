import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	JsonObject,
	JsonValue,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';
import { CLIENT } from './constants';
import { resolveBaseUrl } from './baseUrl';

type Context = IExecuteFunctions | ILoadOptionsFunctions;
interface FullResponse {
	statusCode: number;
	headers: Record<string, string | number | string[] | undefined>;
	body: unknown;
}

function isPlainObject(value: unknown): value is IDataObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function scalarRequestId(value: unknown): string | number | undefined {
	if (typeof value === 'string' && value !== '') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	return undefined;
}

// Sanitize the entire error payload before n8n stores it as the error cause.
function redact(value: unknown, secret: string, seen = new WeakSet<object>()): JsonValue {
	const clean = (text: string) => (secret ? text.split(secret).join('[REDACTED]') : text);
	if (typeof value === 'string') return clean(value);
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value !== 'object') return null;
	if (seen.has(value)) return '[Circular]';
	seen.add(value);
	if (Array.isArray(value)) return value.map((entry) => redact(entry, secret, seen));
	return Object.fromEntries(
		Object.getOwnPropertyNames(value).map((key) => [
			clean(key),
			redact((value as Record<string, unknown>)[key], secret, seen),
		]),
	);
}

export async function request(
	context: Context,
	method: 'GET' | 'POST',
	body?: IDataObject,
	timeout = 60000,
	retries = 5,
	itemIndex?: number,
): Promise<IDataObject> {
	const credentials = await context.getCredentials('naceApi');
	const openRouter = credentials.backend === 'openrouter';
	const baseUrl = resolveBaseUrl(credentials, context.getNode(), itemIndex);
	const headers: Record<string, string> = { 'User-Agent': CLIENT, 'X-Nace-Client': CLIENT };
	if (openRouter)
		Object.assign(headers, {
			'HTTP-Referer': 'https://nace.ai',
			'X-OpenRouter-Title': 'Drex for n8n',
		});
	const apiKey = String(credentials.apiKey || '');
	let totalSleep = 0;
	for (let attempt = 0; ; attempt++) {
		let response: FullResponse;
		try {
			response = (await context.helpers.httpRequestWithAuthentication.call(context, 'naceApi', {
				method,
				url: `${baseUrl}/v1/${method === 'GET' ? 'models' : 'systemone'}`,
				...(method === 'GET' && openRouter ? { qs: { output_modalities: 'all' } } : {}),
				body,
				headers,
				timeout,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				sendCredentialsOnCrossOriginRedirect: false,
			})) as FullResponse;
		} catch (error) {
			throw new NodeApiError(context.getNode(), redact(error, apiKey) as JsonObject, { itemIndex });
		}
		const responseHeaders = Object.fromEntries(
			Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
		);
		if ([429, 529].includes(response.statusCode) && attempt < Math.min(10, Math.max(0, retries))) {
			const ms = responseHeaders['retry-after-ms'];
			const seconds = responseHeaders['retry-after'];
			const requestedDelay =
				ms !== undefined && Number.isFinite(Number(ms)) && Number(ms) >= 0
					? Number(ms)
					: seconds !== undefined && Number.isFinite(Number(seconds)) && Number(seconds) >= 0
						? Number(seconds) * 1000
						: Math.min(30000, 2000 * 2 ** attempt);
			if (totalSleep < 120000) {
				const delay = Math.min(requestedDelay, 60000, 120000 - totalSleep);
				await sleep(delay);
				totalSleep += delay;
				continue;
			}
		}
		const data = isPlainObject(response.body) ? { ...response.body } : undefined;
		const headerId = responseHeaders['x-request-id'];
		const requestId =
			scalarRequestId(data?.request_id) ??
			scalarRequestId(Array.isArray(headerId) ? headerId[0] : headerId) ??
			(openRouter ? scalarRequestId(data?.id) : undefined);
		if (response.statusCode >= 200 && response.statusCode < 300) {
			if (!data) {
				throw new NodeApiError(
					context.getNode(),
					{},
					{
						message: `Unexpected response from ${openRouter ? 'OpenRouter' : 'Nace'}`,
						description: 'Expected a JSON object in the response body.',
						httpCode: String(response.statusCode),
						itemIndex,
					},
				);
			}
			if (requestId !== undefined) data.request_id = requestId;
			else delete data.request_id;
			return data;
		}
		const safeData = redact(data || {}, apiKey) as JsonObject;
		const apiError = (safeData.error || {}) as IDataObject;
		const issues = Array.isArray(apiError.issues) ? (apiError.issues as IDataObject[]) : [];
		const details = issues.map(
			(issue) =>
				`${Array.isArray(issue.path) ? issue.path.join('.') : issue.path}: ${issue.message}`,
		);
		const safeRequestId = redact(requestId, apiKey);
		if (requestId !== undefined) details.push(`Request ID: ${safeRequestId}`);
		if (apiError.type) details.unshift(`Error type: ${apiError.type}`);
		if (response.statusCode === 402) details.push('Add funds in Billing: https://console.nace.ai');
		const message =
			response.statusCode === 401
				? 'Invalid API key. Check your Nace API credential.'
				: response.statusCode === 402
					? 'Insufficient funds. Add funds in Billing: https://console.nace.ai'
					: String(apiError.message || `Drex API returned status ${response.statusCode}`);
		throw new NodeApiError(context.getNode(), safeData, {
			message,
			description: details.join('\n'),
			httpCode: String(response.statusCode),
			itemIndex,
		});
	}
}

export async function getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await request(this, 'GET');
	const models = (data.models || data.data || []) as IDataObject[];
	const credentials = await this.getCredentials('naceApi');
	return models
		.filter(
			(model) =>
				credentials.backend !== 'openrouter' ||
				String(model.id || model.name).startsWith('nace-ai/'),
		)
		.filter(
			(model) =>
				!model.retired && !model.is_retired && !model.retired_at && model.status !== 'retired',
		)
		.map((model) => {
			const id = String(model.id || model.name);
			const name = credentials.backend === 'openrouter' ? String(model.name || id) : id;
			return {
				name: model.alias_for ? `${name} (alias of ${model.alias_for})` : name,
				value: id,
				description: String(model.description || ''),
			};
		});
}
