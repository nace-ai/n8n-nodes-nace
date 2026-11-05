import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	INodePropertyOptions,
} from 'n8n-workflow';
import { sleep } from 'n8n-workflow';
import { CLIENT } from './constants';
import { resolveBaseUrl } from './baseUrl';
import {
	apiFailure,
	cleanJson,
	cleanText,
	isObject,
	scalarId,
	unexpected,
	operationFailure,
} from './safety';

export interface RequestContext {
	getNode(): INode;
	getCredentials(name: string): Promise<ICredentialDataDecryptedObject>;
	helpers: {
		httpRequestWithAuthentication: (
			credentialsType: string,
			options: IHttpRequestOptions,
		) => Promise<unknown>;
	};
}
interface FullResponse {
	statusCode: number;
	headers?: Record<string, unknown>;
	body?: unknown;
}
function first(value: unknown): unknown {
	return Array.isArray(value) ? value[0] : value;
}
function retryDelay(headers: Record<string, unknown>, attempt: number): number {
	const ms = first(headers['retry-after-ms']);
	if (ms !== undefined && Number.isFinite(Number(ms)) && Number(ms) >= 0) return Number(ms);
	const retryAfter = first(headers['retry-after']);
	if (retryAfter !== undefined) {
		if (Number.isFinite(Number(retryAfter)) && Number(retryAfter) >= 0)
			return Number(retryAfter) * 1000;
		if (typeof retryAfter === 'string') {
			const date = Date.parse(retryAfter);
			if (Number.isFinite(date)) return Math.max(0, date - Date.now());
		}
	}
	return Math.min(30000, 2000 * 2 ** attempt);
}
export async function request(
	context: RequestContext,
	method: 'GET' | 'POST',
	body?: IDataObject,
	timeout = 60000,
	retries = 5,
	itemIndex?: number,
): Promise<IDataObject> {
	const resource = method === 'GET' ? 'models' : 'systemone';
	const credentials = await context.getCredentials('naceApi');
	const secret = String(credentials.apiKey || '');
	const openRouter = credentials.backend === 'openrouter';
	const backend = openRouter ? 'OpenRouter' : 'Nace';
	let baseUrl: string;
	try {
		baseUrl = resolveBaseUrl(credentials, context.getNode(), itemIndex);
	} catch (error) {
		throw operationFailure(context.getNode(), secret, error, itemIndex);
	}
	const headers: Record<string, string> = { 'User-Agent': CLIENT, 'X-Nace-Client': CLIENT };
	if (openRouter)
		Object.assign(headers, {
			'HTTP-Referer': 'https://nace.ai',
			'X-OpenRouter-Title': 'Drex for n8n',
		});
	let totalSleep = 0;
	for (let attempt = 0; ; attempt++) {
		let response: FullResponse;
		try {
			response = (await context.helpers.httpRequestWithAuthentication.call(context, 'naceApi', {
				method,
				url: `${baseUrl}/v1/${resource}`,
				...(resource === 'models' && openRouter ? { qs: { output_modalities: 'all' } } : {}),
				body,
				headers,
				timeout,
				maxResponseBodyBytes: (resource === 'models' ? 16 : 8) * 1024 * 1024,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				sendCredentialsOnCrossOriginRedirect: false,
			})) as FullResponse;
		} catch (error) {
			throw apiFailure(context.getNode(), secret, error, { itemIndex });
		}
		const responseHeaders = Object.fromEntries(
			Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]),
		);
		if (
			[429, 529].includes(response.statusCode) &&
			attempt < Math.min(10, Math.max(0, retries)) &&
			totalSleep < 120000
		) {
			const delay = Math.min(retryDelay(responseHeaders, attempt), 60000, 120000 - totalSleep);
			await sleep(delay);
			totalSleep += delay;
			continue;
		}
		const data = isObject(response.body) ? response.body : undefined;
		const requestId =
			scalarId(data?.request_id) ??
			scalarId(first(responseHeaders['x-request-id'])) ??
			(openRouter ? scalarId(data?.id) : undefined);
		if (response.statusCode >= 200 && response.statusCode < 300) {
			if (!data)
				throw unexpected(
					context.getNode(),
					secret,
					backend,
					'Expected a JSON object in the response body.',
					itemIndex,
				);
			const result = cleanJson(data, secret) as IDataObject;
			if (requestId !== undefined)
				result.request_id =
					typeof requestId === 'string' ? cleanText(requestId, secret) : requestId;
			else delete result.request_id;
			return result;
		}
		const billing = openRouter
			? 'https://openrouter.ai/settings/credits'
			: 'https://console.nace.ai';
		const error = isObject(data?.error) ? data.error : {};
		const message =
			response.statusCode === 401
				? 'API Key: Check your Nace API credential.'
				: response.statusCode === 402
					? `Insufficient funds. Add funds in Billing: ${billing}`
					: cleanText(error.message, secret, `Drex API returned status ${response.statusCode}`);
		throw apiFailure(context.getNode(), secret, data, {
			status: response.statusCode,
			message,
			requestId,
			itemIndex,
		});
	}
}
export async function getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const data = await request(this, 'GET', undefined, 60000, 1);
	const credentials = await this.getCredentials('naceApi');
	const models = data.models ?? data.data;
	if (!Array.isArray(models))
		throw unexpected(
			this.getNode(),
			String(credentials.apiKey || ''),
			credentials.backend === 'openrouter' ? 'OpenRouter' : 'Nace',
			'Expected a models array.',
		);
	return models
		.filter(isObject)
		.filter((model) => {
			const id = model.id || model.name;
			return (
				typeof id === 'string' &&
				id !== '' &&
				(credentials.backend !== 'openrouter' || id.startsWith('nace-ai/')) &&
				!model.retired &&
				!model.is_retired &&
				!model.retired_at &&
				model.status !== 'retired'
			);
		})
		.map((model) => {
			const id = String(model.id || model.name);
			const name = credentials.backend === 'openrouter' ? cleanText(model.name, '', id) : id;
			return {
				name: typeof model.alias_for === 'string' ? `${name} (alias of ${model.alias_for})` : name,
				value: id,
				description: cleanText(model.description, ''),
			};
		});
}
