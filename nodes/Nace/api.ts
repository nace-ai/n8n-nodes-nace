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
	body: IDataObject;
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
	retries = 3,
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
						: Math.min(30000, 1000 * 2 ** attempt);
			if (totalSleep < 120000) {
				const delay = Math.min(requestedDelay, 60000, 120000 - totalSleep);
				await sleep(delay);
				totalSleep += delay;
				continue;
			}
		}
		const data = response.body || {};
		if (response.statusCode >= 200 && response.statusCode < 300) {
			if (!data.request_id && responseHeaders['x-request-id'])
				data.request_id = String(responseHeaders['x-request-id']);
			return data;
		}
		const safeData = redact(data, apiKey) as JsonObject;
		const apiError = (safeData.error || {}) as IDataObject;
		const issues = Array.isArray(apiError.issues) ? (apiError.issues as IDataObject[]) : [];
		const details = issues.map(
			(issue) =>
				`${Array.isArray(issue.path) ? issue.path.join('.') : issue.path}: ${issue.message}`,
		);
		const requestId = redact(data.request_id || responseHeaders['x-request-id'], apiKey);
		if (requestId) details.push(`Request ID: ${requestId}`);
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
			return {
				name: model.alias_for ? `${id} (alias of ${model.alias_for})` : id,
				value: id,
				description: String(model.description || ''),
			};
		});
}
