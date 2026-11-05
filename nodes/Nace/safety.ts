import type { IDataObject, INode, JsonObject, JsonValue } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export function isObject(value: unknown): value is IDataObject {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
export function cleanText(value: unknown, secret: string, fallback = ''): string {
	const text =
		typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback;
	return secret ? text.split(secret).join('[REDACTED]') : text;
}
// Walk JSON responses only. Raw transport errors are handled by a fixed projection below.
export function cleanJson(value: unknown, secret: string, seen = new WeakSet<object>()): JsonValue {
	if (typeof value === 'string') return cleanText(value, secret);
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (!Array.isArray(value) && !isObject(value)) return null;
	if (seen.has(value)) return null;
	seen.add(value);
	return Array.isArray(value)
		? value.map((entry) => cleanJson(entry, secret, seen))
		: Object.fromEntries(
				Object.entries(value).map(([key, entry]) => [
					cleanText(key, secret),
					cleanJson(entry, secret, seen),
				]),
			);
}
function field(value: unknown, key: string): unknown {
	return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
export function scalarId(value: unknown): string | number | undefined {
	return (typeof value === 'string' && value !== '') ||
		(typeof value === 'number' && Number.isFinite(value))
		? (value as string | number)
		: undefined;
}
export function safeNode(node: INode, secret: string): INode {
	return cleanJson(node, secret) as unknown as INode;
}
export function itemText(message: string, itemIndex?: number): string {
	const marker = itemIndex === undefined ? '' : `[Item ${itemIndex + 1}]`;
	return message && marker && !message.includes(marker) ? `${message} ${marker}` : message;
}
export function apiFailure(
	node: INode,
	secret: string,
	raw: unknown,
	options: {
		status?: number;
		message?: string;
		description?: string;
		requestId?: string | number;
		itemIndex?: number;
	} = {},
): NodeApiError {
	const nested = field(raw, 'error');
	const message = itemText(
		cleanText(
			options.message ?? field(nested, 'message') ?? field(raw, 'message'),
			secret,
			'Drex request could not be completed',
		),
		options.itemIndex,
	);
	const type = cleanText(field(nested, 'type'), secret);
	const rawIssues = field(nested, 'issues');
	const issues = Array.isArray(rawIssues)
		? rawIssues.map((issue) => {
				const path = field(issue, 'path');
				return {
					path: Array.isArray(path)
						? path.map((part) => cleanText(part, secret)).join('.')
						: cleanText(path, secret, 'request'),
					message: cleanText(field(issue, 'message'), secret, 'Invalid request issue'),
				};
			})
		: [];
	const requestId =
		options.requestId === undefined ? undefined : cleanText(options.requestId, secret);
	const projection: JsonObject = {
		httpCode: options.status === undefined ? null : String(options.status),
		message,
		error: { type, message, issues },
		...(requestId === undefined ? {} : { request_id: requestId }),
	};
	const details = [
		options.description ? cleanText(options.description, secret) : '',
		type ? `Type: ${type}` : '',
		...issues.map((issue) => `${issue.path}: ${issue.message}`),
		...(requestId === undefined ? [] : [`Request ID: ${requestId}`]),
	].filter(Boolean);
	return new NodeApiError(safeNode(node, secret), projection, {
		message,
		description: itemText(details.join('\n'), options.itemIndex),
		httpCode: options.status === undefined ? undefined : String(options.status),
		itemIndex: options.itemIndex,
	});
}
export function operationFailure(
	node: INode,
	secret: string,
	error: unknown,
	itemIndex?: number,
): NodeApiError | NodeOperationError {
	if (error instanceof NodeApiError)
		return apiFailure(
			node,
			secret,
			{},
			{
				message: error.message,
				description: error.description ?? undefined,
				status: error.httpCode ? Number(error.httpCode) : undefined,
				itemIndex,
			},
		);
	return new NodeOperationError(
		safeNode(node, secret),
		itemText(
			cleanText(field(error, 'message'), secret, 'Drex operation could not be completed'),
			itemIndex,
		),
		{
			description: itemText(cleanText(field(error, 'description'), secret), itemIndex) || undefined,
			itemIndex,
		},
	);
}
export function unexpected(
	node: INode,
	secret: string,
	backend: string,
	description: string,
	itemIndex?: number,
): NodeApiError {
	return apiFailure(
		node,
		secret,
		{},
		{ message: `Unexpected response from ${backend}`, description, itemIndex },
	);
}
