import type {
	ICredentialDataDecryptedObject,
	IHttpRequestOptions,
	ICredentialType,
	ICredentialTestRequest,
	INodeProperties,
} from 'n8n-workflow';
import { CLIENT } from '../nodes/Nace/constants';
import { resolveBaseUrl } from '../nodes/Nace/baseUrl';

// HTTP Request uses uri; the modern HTTP helper uses url.
type RequestOptions = Omit<IHttpRequestOptions, 'url'> & { url?: string; uri?: string };

export class NaceApi implements ICredentialType {
	name = 'naceApi';
	displayName = 'Nace API';
	documentationUrl = 'https://github.com/nace-ai/n8n-nodes-nace#credentials';
	icon = {
		light: 'file:../nodes/Nace/nace.svg',
		dark: 'file:../nodes/Nace/nace.dark.svg',
	} as const;
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Backend',
			name: 'backend',
			type: 'options',
			options: [
				{ name: 'Nace', value: 'nace' },
				{ name: 'OpenRouter', value: 'openrouter' },
			],
			default: 'nace',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://console.nace.ai',
			displayOptions: { show: { backend: ['nace'] } },
		},
		{
			displayName: 'OpenRouter Base URL',
			name: 'openRouterBaseUrl',
			type: 'string',
			default: 'https://openrouter.ai/api',
			displayOptions: { show: { backend: ['openrouter'] } },
		},
	];
	async authenticate<T extends RequestOptions>(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: T,
	): Promise<T> {
		const baseUrl = resolveBaseUrl(credentials);
		const parameter = credentials.backend === 'openrouter' ? 'OpenRouter Base URL' : 'Base URL';
		const targets = [requestOptions.uri, requestOptions.url].filter(
			(target) => target !== undefined,
		);
		let requestUrls: URL[];
		try {
			if (!targets.length) throw new Error('Missing request target');
			requestUrls = targets.map((target) => new URL(target, requestOptions.baseURL));
		} catch {
			throw new Error(
				`Nace API credentials require an absolute request URL. Set the request URL to an HTTP or HTTPS URL using the origin in the credential's '${parameter}' field.`,
			);
		}
		const origin = new URL(baseUrl).origin;
		if (requestUrls.some((url) => url.origin !== origin)) {
			throw new Error(
				`Nace API credentials can only be used for requests to the origin in '${parameter}'. Change the request URL to use that origin, or set the credential's '${parameter}' to the intended service URL.`,
			);
		}
		return {
			...requestOptions,
			...(requestOptions.baseURL === undefined ? {} : { baseURL: baseUrl }),
			headers: { ...requestOptions.headers, Authorization: `Bearer ${credentials.apiKey}` },
		};
	}
	test: ICredentialTestRequest = {
		request: {
			baseURL:
				"={{ ($credentials.backend === 'openrouter' ? ($credentials.openRouterBaseUrl || 'https://openrouter.ai/api') : ($credentials.baseUrl || 'https://console.nace.ai')).trim().replace(/\\/+$/, '') }}",
			url: '={{ $credentials.backend === "openrouter" ? "/v1/key" : "/v1/models" }}',
			method: 'GET',
			maxResponseBodyBytes: 16 * 1024 * 1024,
			disableFollowRedirect: true,
			headers: {
				'User-Agent': CLIENT,
				'X-Nace-Client': CLIENT,
				'HTTP-Referer':
					'={{ $credentials.backend === "openrouter" ? "https://nace.ai" : undefined }}',
				'X-OpenRouter-Title':
					'={{ $credentials.backend === "openrouter" ? "Drex for n8n" : undefined }}',
			},
		},
	};
}
