import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { deleteFile, deleteJob, getWorkspaces, runJob, uploadBinary } from './ndi';
import { properties } from './properties';
import { cleanText, isObject, itemText, operationFailure } from '../Nace/safety';

function failParameter(context: IExecuteFunctions, index: number, message: string): never {
	throw new NodeOperationError(context.getNode(), itemText(message, index), { itemIndex: index });
}
function maxWaitParameter(context: IExecuteFunctions, index: number, options: IDataObject): number {
	const maxWait = Number(options.maxWait ?? 300);
	if (!Number.isFinite(maxWait) || maxWait <= 0)
		failParameter(context, index, "'Max Wait (Seconds)' must be a positive number of seconds");
	return maxWait;
}
function jsonObjectParameter(
	context: IExecuteFunctions,
	index: number,
	value: unknown,
	label: string,
): IDataObject {
	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			failParameter(context, index, `'${label}' must be valid JSON`);
		}
	}
	if (!isObject(parsed)) failParameter(context, index, `'${label}' must be a JSON object`);
	return parsed;
}
function hasExtension(name: string): boolean {
	const dot = name.lastIndexOf('.');
	return dot > 0 && dot < name.length - 1;
}
// Parse results larger than 1 MiB carry a preview plus job download links that serve the full
// content only while the job exists: content_url for the full payload and rows_url for spreadsheet
// rows. They can sit anywhere in the parse result — at the top level, in document, or nested in
// structures such as document.spreadsheet.sheets[] — so it is searched recursively. Only Parse
// results are searched: Extract data is user data, and a field named content_url there must not
// keep the job.
function jobDownloadLinkKey(
	value: unknown,
	seen = new WeakSet<object>(),
): 'content_url' | 'rows_url' | undefined {
	if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const entry of value) {
			const nested = jobDownloadLinkKey(entry, seen);
			if (nested !== undefined) return nested;
		}
		return undefined;
	}
	if (!isObject(value)) return undefined;
	for (const [key, entry] of Object.entries(value)) {
		if ((key === 'content_url' || key === 'rows_url') && typeof entry === 'string' && entry)
			return key;
		const nested = jobDownloadLinkKey(entry, seen);
		if (nested !== undefined) return nested;
	}
	return undefined;
}
function urlSource(context: IExecuteFunctions, index: number): IDataObject {
	const url = String(context.getNodeParameter('url', index, ''));
	const invalid = "'URL' must be a public HTTPS link, for example https://example.com/invoice.pdf";
	if (!url.startsWith('https://')) failParameter(context, index, invalid);
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		parsed = undefined;
	}
	if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname)
		failParameter(context, index, invalid);
	const explicit = String(context.getNodeParameter('fileName', index, '')).trim();
	const name = explicit || parsed.pathname.split('/').pop() || '';
	if (!hasExtension(name))
		failParameter(
			context,
			index,
			"'File Name': Provide a file name with an extension, for example invoice.pdf",
		);
	return { type: 'url', url, file_name: name };
}
async function runDocument(
	context: IExecuteFunctions,
	index: number,
	secret: string,
): Promise<IDataObject> {
	const operation = context.getNodeParameter('operation', index, 'parse') as string;
	const options = (context.getNodeParameter('options', index, {}) as IDataObject) ?? {};
	const maxWait = maxWaitParameter(context, index, options);
	const parseMode = String(options.parseMode ?? 'low');
	const keepJob = options.keepJob === true;
	const source = context.getNodeParameter('source', index, 'binary') as string;
	// Validate every parameter value before any request, so that a bad value does not upload a file.
	if (source !== 'binary' && source !== 'url')
		failParameter(context, index, "'Source' must be Binary File or URL");
	if (operation !== 'parse' && operation !== 'extract')
		failParameter(context, index, "'Operation' must be Parse or Extract");
	if (!['low', 'medium', 'high'].includes(parseMode))
		failParameter(context, index, "'Parse Mode' must be Low, Medium, or High");
	if (
		options.chunking !== undefined &&
		(typeof options.chunking !== 'string' ||
			!['none', 'page', 'section'].includes(options.chunking))
	)
		failParameter(context, index, "'Chunking' must be None, Page, or Section");
	if (
		options.tableFormat !== undefined &&
		(typeof options.tableFormat !== 'string' || !['html', 'markdown'].includes(options.tableFormat))
	)
		failParameter(context, index, "'Table Format' must be HTML or Markdown");
	const rawFormats: unknown =
		operation === 'parse'
			? context.getNodeParameter('outputFormats', index, ['markdown'])
			: undefined;
	if (
		rawFormats !== undefined &&
		(!Array.isArray(rawFormats) ||
			!rawFormats.length ||
			rawFormats.some(
				(format) => typeof format !== 'string' || !['blocks', 'markdown', 'text'].includes(format),
			))
	)
		failParameter(
			context,
			index,
			"'Output Formats' must contain at least one of Blocks, Markdown, or Text",
		);
	const formats = rawFormats as string[] | undefined;
	const schema =
		operation === 'parse'
			? undefined
			: jsonObjectParameter(
					context,
					index,
					context.getNodeParameter('schema', index, ''),
					'Schema (JSON)',
				);
	if (
		schema !== undefined &&
		(schema.type !== 'object' ||
			!isObject(schema.properties) ||
			!Object.keys(schema.properties).length)
	)
		failParameter(
			context,
			index,
			"'Schema (JSON)' must be an object schema with at least one property",
		);
	const urlBody = source === 'url' ? urlSource(context, index) : undefined;
	const tracked: { current?: string } = {};
	let uploaded: { workspaceId: string; fileId: string } | undefined;
	let jobDeleted: boolean | undefined;
	let jobKept: 'content_url' | 'rows_url' | undefined;
	let fileDeleted: boolean | undefined;
	let result: { job: IDataObject; requestId: string | number | undefined } | undefined;
	try {
		try {
			let sourceBody: IDataObject;
			if (urlBody !== undefined) {
				sourceBody = urlBody;
			} else {
				uploaded = await uploadBinary(
					context,
					index,
					String(context.getNodeParameter('binaryPropertyName', index, 'data')),
				);
				sourceBody = {
					type: 'workspace_file',
					workspace_id: uploaded.workspaceId,
					file_id: uploaded.fileId,
				};
			}
			const body: IDataObject = { source: sourceBody, parse_mode: parseMode };
			if (operation === 'parse') {
				const output: IDataObject = { formats: formats ?? ['markdown'] };
				if (options.tableFormat === 'markdown') output.table_format = 'markdown';
				body.output = output;
				if (typeof options.chunking === 'string' && options.chunking !== 'none')
					body.chunking = { strategy: options.chunking };
			} else {
				body.schema = schema;
				if (options.instructions) body.instructions = String(options.instructions);
			}
			result = await runJob(
				context,
				index,
				operation === 'parse' ? '/v1/documents/parse' : '/v1/documents/extract',
				body,
				maxWait,
				tracked,
			);
		} finally {
			// Deleting the job would break a Parse result's download links, so it is kept and reported
			// with the link that was found. Extract results are never searched: their data fields are
			// user data, not job links.
			const downloadLink =
				result === undefined || operation !== 'parse'
					? undefined
					: jobDownloadLinkKey(result.job.result);
			if (!keepJob && tracked.current !== undefined) {
				if (downloadLink === undefined) jobDeleted = await deleteJob(context, tracked.current);
				else jobKept = downloadLink;
			}
			if (uploaded) fileDeleted = await deleteFile(context, uploaded.workspaceId, uploaded.fileId);
		}
	} catch (error) {
		const notes: string[] = [];
		if (jobDeleted === false && tracked.current !== undefined)
			notes.push(
				`The job ${tracked.current} could not be deleted. Delete it in your Nace account.`,
			);
		if (uploaded && fileDeleted !== true)
			notes.push(
				`The uploaded file ${uploaded.fileId} in workspace ${uploaded.workspaceId} could not be confirmed as deleted. Delete it in your Nace account.`,
			);
		if (notes.length && error && typeof error === 'object') {
			const described = error as { description?: string };
			const note = notes.join('\n');
			described.description = described.description ? `${described.description}\n${note}` : note;
		}
		throw operationFailure(context.getNode(), secret, error, index);
	}
	const { job, requestId } = result;
	return {
		job_id: job.job_id,
		...(requestId === undefined
			? {}
			: { request_id: typeof requestId === 'string' ? cleanText(requestId, secret) : requestId }),
		...(job.result as IDataObject),
		// cost is always present: null when Nace does not report one.
		cost: job.cost ?? null,
		cleanup: {
			...(jobDeleted === undefined ? {} : { job_deleted: jobDeleted }),
			...(jobKept === undefined ? {} : { job_kept: jobKept }),
			...(uploaded
				? {
						file_deleted: fileDeleted ?? false,
						...(fileDeleted === true
							? {}
							: { workspace_id: uploaded.workspaceId, file_id: uploaded.fileId }),
					}
				: {}),
		},
	};
}
async function searchWorkspace(
	context: IExecuteFunctions,
	index: number,
	secret: string,
): Promise<IDataObject> {
	const workspaceId = String(context.getNodeParameter('workspaceId', index, ''));
	const query = String(context.getNodeParameter('query', index, ''));
	const mode = context.getNodeParameter('mode', index, 'auto') as string;
	const options = (context.getNodeParameter('searchOptions', index, {}) as IDataObject) ?? {};
	const maxWait = maxWaitParameter(context, index, options);
	const body: IDataObject = { query, mode };
	if (options.context) body.context = String(options.context);
	if (options.pathPrefix) body.path_prefix = String(options.pathPrefix);
	if (options.topK !== undefined) body.top_k = Number(options.topK);
	if (options.outputSchema)
		body.output_schema = jsonObjectParameter(
			context,
			index,
			options.outputSchema,
			'Output Schema (JSON)',
		);
	const { job, requestId } = await runJob(
		context,
		index,
		`/v1/workspaces/${encodeURIComponent(workspaceId)}/automatic-search`,
		body,
		maxWait,
	);
	const result = job.result as IDataObject;
	const output = isObject(result.output) ? result.output : {};
	const answer = isObject(output.answer) ? output.answer : output;
	return {
		job_id: job.job_id,
		...(requestId === undefined
			? {}
			: { request_id: typeof requestId === 'string' ? cleanText(requestId, secret) : requestId }),
		answer: answer.answer,
		confidence: answer.confidence,
		evidences: answer.evidences,
		structured_answer: answer.structured_answer,
		...result,
		// cost is always present: null when Nace does not report one.
		cost: job.cost ?? null,
	};
}

export class NaceDocumentIntelligence implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Nace Document Intelligence',
		name: 'naceDocumentIntelligence',
		icon: { light: 'file:../Nace/nace.svg', dark: 'file:../Nace/nace.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Parse documents, extract structured data, and search workspace files',
		defaults: { name: 'Nace Document Intelligence' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'naceApi', required: true }],
		properties,
	};
	methods = { loadOptions: { getWorkspaces } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		if (!items.length) return [[]];
		const node = this.getNode();
		const returnData: INodeExecutionData[] = [];
		for (let index = 0; index < items.length; index++) {
			let secret = '';
			try {
				const credentials = await this.getCredentials('naceApi');
				secret = String(credentials.apiKey || '');
				const resource = this.getNodeParameter('resource', index, 'document') as string;
				if (resource !== 'document' && resource !== 'workspace')
					failParameter(this, index, "'Resource' must be Document or Workspace");
				let json: IDataObject;
				if (resource === 'workspace') {
					const operation = this.getNodeParameter('operation', index, 'search') as string;
					if (operation !== 'search')
						failParameter(this, index, "'Operation' must be Search for the Workspace resource");
					json = await searchWorkspace(this, index, secret);
				} else {
					json = await runDocument(this, index, secret);
				}
				returnData.push({ json, pairedItem: { item: index } });
			} catch (error) {
				const failure = operationFailure(node, secret, error, index);
				if (!this.continueOnFail()) throw failure;
				returnData.push({
					json: {
						error: failure.message,
						...(failure.description ? { description: failure.description } : {}),
					},
					...(node.onError === 'continueErrorOutput' ? { error: failure } : {}),
					pairedItem: { item: index },
				});
			}
		}
		return [returnData];
	}
}
