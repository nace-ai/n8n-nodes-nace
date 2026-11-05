import type { ICredentialDataDecryptedObject, INode } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

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
		throw new NodeOperationError(node, 'Base URL must be an absolute HTTP or HTTPS URL', {
			itemIndex,
		});
	}
	const host = url.hostname.toLowerCase().replace(/\.$/, '');
	if (openRouter && host !== 'openrouter.ai' && !host.endsWith('.openrouter.ai')) {
		throw new NodeOperationError(
			node,
			'OpenRouter Base URL must use openrouter.ai or a subdomain of openrouter.ai',
			{ itemIndex },
		);
	}
	if (!openRouter && host.endsWith('openrouter.ai')) {
		throw new NodeOperationError(
			node,
			'Nace Base URL must not use an openrouter.ai host. Select the OpenRouter backend or change Base URL.',
			{ itemIndex },
		);
	}
	return baseUrl;
}
