export const VERSION = '0.1.0';
export const CLIENT = `n8n-nodes-nace/${VERSION}`;
export const BASE_URL_EXPRESSION =
	"={{ ($credentials.backend === 'openrouter' ? ($credentials.openRouterBaseUrl || 'https://openrouter.ai/api') : ($credentials.baseUrl || 'https://console.nace.ai')).trim().replace(/\\/+$/, '') }}";
