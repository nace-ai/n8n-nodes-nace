import type { ICredentialDataDecryptedObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { itemText } from './safety';

// Authentication also runs during credential tests, where there is no workflow node.
const credentialContext: INode = {
	id: 'nace-api-credential',
	name: 'Nace API',
	type: 'n8n-nodes-nace.nace',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

export function resolveBaseUrl(
	credentials: ICredentialDataDecryptedObject,
	node: INode = credentialContext,
	itemIndex?: number,
): string {
	const openRouter = credentials.backend === 'openrouter';
	const parameter = openRouter ? 'OpenRouter Base URL' : 'Base URL';
	const baseUrl = String(
		openRouter
			? credentials.openRouterBaseUrl || 'https://openrouter.ai/api'
			: credentials.baseUrl || 'https://console.nace.ai',
	)
		.trim()
		.replace(/\/+$/, '');
	let url: URL;
	try {
		url = new URL(baseUrl);
		if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
	} catch {
		throw new NodeOperationError(
			node,
			itemText(`${parameter} must be an absolute HTTP or HTTPS URL`, itemIndex),
			{
				itemIndex,
			},
		);
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	const local = !openRouter && ['localhost', '127.0.0.1', '[::1]'].includes(host);
	if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
		throw new NodeOperationError(
			node,
			itemText(
				`${parameter} must use HTTPS. Only Nace on localhost, 127.0.0.1, or [::1] may use HTTP.`,
				itemIndex,
			),
			{ itemIndex },
		);
	if (
		baseUrl.split('://')[1]?.split('/')[0].includes('@') ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		baseUrl.includes('?') ||
		baseUrl.includes('#')
	)
		throw new NodeOperationError(
			node,
			itemText(`${parameter} must not include userinfo, a query, or a fragment`, itemIndex),
			{ itemIndex },
		);
	if (openRouter && host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) {
		throw new NodeOperationError(
			node,
			itemText(
				'OpenRouter Base URL must use openrouter.ai or a subdomain of openrouter.ai',
				itemIndex,
			),
			{ itemIndex },
		);
	}
	if (!openRouter && host.endsWith('openrouter.ai')) {
		throw new NodeOperationError(
			node,
			itemText(
				'Nace Base URL must not use an openrouter.ai host. Select the OpenRouter backend or change Base URL.',
				itemIndex,
			),
			{ itemIndex },
		);
	}
	return (url.origin + url.pathname).replace(/\/+$/, '');
}
