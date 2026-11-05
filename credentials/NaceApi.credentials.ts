import type {
	ICredentialDataDecryptedObject,
	IHttpRequestOptions,
	ICredentialType,
	ICredentialTestRequest,
	INodeProperties,
} from 'n8n-workflow';
import { CLIENT } from '../nodes/Nace/constants';
import { resolveBaseUrl } from '../nodes/Nace/baseUrl';

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
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const baseUrl = resolveBaseUrl(credentials);
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
