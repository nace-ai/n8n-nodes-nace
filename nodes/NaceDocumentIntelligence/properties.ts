import type { INodeProperties } from 'n8n-workflow';

const documentOperation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: {
		show: {
			resource: ['document'],
		},
	},
	options: [
		{
			name: 'Extract',
			value: 'extract',
			action: 'Extract data from a document',
			description: 'Fill a JSON schema with typed fields and citations',
		},
		{
			name: 'Parse',
			value: 'parse',
			action: 'Parse a document',
			description: 'Turn a document into Markdown, text, or blocks',
		},
	],
	default: 'parse',
};
const workspaceOperation: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: {
		show: {
			resource: ['workspace'],
		},
	},
	options: [
		{
			name: 'Search',
			value: 'search',
			action: 'Search a workspace',
			description: 'Answer a question about the workspace files',
		},
	],
	default: 'search',
};
const documentOptions: INodeProperties[] = [
	{
		displayName: 'Chunking',
		name: 'chunking',
		type: 'options',
		displayOptions: {
			show: {
				'/operation': ['parse'],
			},
		},
		options: [
			{ name: 'None', value: 'none' },
			{ name: 'Page', value: 'page' },
			{ name: 'Section', value: 'section' },
		],
		default: 'none',
		description: 'How the document is split into chunks in the result',
	},
	{
		displayName: 'Instructions',
		name: 'instructions',
		type: 'string',
		typeOptions: { rows: 3 },
		displayOptions: {
			show: {
				'/operation': ['extract'],
			},
		},
		default: '',
		description: 'Extra guidance for the fields to extract',
	},
	{
		displayName: 'Keep Job',
		name: 'keepJob',
		type: 'boolean',
		default: false,
		description:
			'Whether to keep the job in your Nace account. The node deletes the job after reading the result by default.',
	},
	{
		displayName: 'Max Wait (Seconds)',
		name: 'maxWait',
		type: 'number',
		default: 300,
		typeOptions: { minValue: 1, numberPrecision: 0 },
		description: 'How long to wait for the job to finish before failing the item',
	},
	{
		displayName: 'Parse Mode',
		name: 'parseMode',
		type: 'options',
		options: [
			{ name: 'Low', value: 'low' },
			{ name: 'Medium', value: 'medium' },
			{ name: 'High', value: 'high' },
		],
		default: 'low',
		description: 'How much effort the parser spends on the document',
	},
	{
		displayName: 'Table Format',
		name: 'tableFormat',
		type: 'options',
		displayOptions: {
			show: {
				'/operation': ['parse'],
			},
		},
		options: [
			{ name: 'HTML', value: 'html' },
			{ name: 'Markdown', value: 'markdown' },
		],
		default: 'html',
		description: 'The format of tables in the parsed document',
	},
];
export const properties: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Document',
				value: 'document',
				description: 'Parse a file or extract structured data from it',
			},
			{
				name: 'Workspace',
				value: 'workspace',
				description: 'Search the ingested files of a workspace',
			},
		],
		default: 'document',
		description: 'Whether to run a document job or a workspace search',
	},
	documentOperation,
	workspaceOperation,
	{
		displayName: 'Source',
		name: 'source',
		type: 'options',
		displayOptions: {
			show: {
				resource: ['document'],
			},
		},
		options: [
			{
				name: 'Binary File',
				value: 'binary',
				description: 'A binary field from an earlier node',
			},
			{
				name: 'URL',
				value: 'url',
				description: 'A public HTTPS link',
			},
		],
		default: 'binary',
		description: 'Where the document comes from',
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		placeholder: 'e.g. data',
		displayOptions: {
			show: {
				resource: ['document'],
				source: ['binary'],
			},
		},
		description: 'The name of the input binary field that holds the file',
	},
	{
		displayName: 'URL',
		name: 'url',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. https://example.com/invoice.pdf',
		displayOptions: {
			show: {
				resource: ['document'],
				source: ['url'],
			},
		},
		description: 'A public HTTPS link to the document',
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. invoice.pdf',
		displayOptions: {
			show: {
				resource: ['document'],
				source: ['url'],
			},
		},
		description:
			'The file name with an extension. When empty, the last segment of the URL path is used.',
	},
	{
		displayName: 'Output Formats',
		name: 'outputFormats',
		type: 'multiOptions',
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['parse'],
			},
		},
		options: [
			{ name: 'Blocks', value: 'blocks' },
			{ name: 'Markdown', value: 'markdown' },
			{ name: 'Text', value: 'text' },
		],
		default: ['markdown'],
		description: 'The formats to return for the parsed document',
	},
	{
		displayName: 'Schema (JSON)',
		name: 'schema',
		type: 'json',
		required: true,
		default:
			'{"type":"object","properties":{"invoice_number":{"type":"string","description":"Invoice number"},"total":{"type":"number","description":"Invoice total"}}}',
		displayOptions: {
			show: {
				resource: ['document'],
				operation: ['extract'],
			},
		},
		description: 'The JSON Schema object that names the fields to extract',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		default: {},
		placeholder: 'Add Option',
		displayOptions: {
			show: {
				resource: ['document'],
			},
		},
		options: documentOptions,
	},
	{
		displayName: 'Workspace Name or ID',
		name: 'workspaceId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getWorkspaces' },
		default: '',
		required: true,
		displayOptions: {
			show: {
				resource: ['workspace'],
			},
		},
		description:
			'The workspace that holds the ingested files. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Question',
		name: 'query',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. What is the total of invoice 42?',
		displayOptions: {
			show: {
				resource: ['workspace'],
			},
		},
		description: 'The question to answer from the workspace files',
	},
	{
		displayName: 'Mode',
		name: 'mode',
		type: 'options',
		displayOptions: {
			show: {
				resource: ['workspace'],
			},
		},
		options: [
			{ name: 'Agent', value: 'agent', description: 'A multi-step answer' },
			{ name: 'Auto', value: 'auto', description: 'Let Nace choose the answer style' },
			{ name: 'Fast', value: 'fact', description: 'A fast fact answer with citations' },
		],
		default: 'auto',
		description: 'How Nace answers the question',
	},
	{
		displayName: 'Search Options',
		name: 'searchOptions',
		type: 'collection',
		default: {},
		placeholder: 'Add Option',
		displayOptions: {
			show: {
				resource: ['workspace'],
			},
		},
		options: [
			{
				displayName: 'Context',
				name: 'context',
				type: 'string',
				default: '',
				description: 'Extra context for the question',
			},
			{
				displayName: 'Evidence Limit',
				name: 'topK',
				type: 'number',
				default: 6,
				typeOptions: { minValue: 1, maxValue: 50, numberPrecision: 0 },
				description: 'The maximum number of evidence passages to return',
			},
			{
				displayName: 'Folder',
				name: 'pathPrefix',
				type: 'string',
				default: '',
				placeholder: 'e.g. invoices/2026',
				description: 'Only search files under this folder path',
			},
			{
				displayName: 'Max Wait (Seconds)',
				name: 'maxWait',
				type: 'number',
				default: 300,
				typeOptions: { minValue: 1, numberPrecision: 0 },
				description: 'How long to wait for the search job before failing the item',
			},
			{
				displayName: 'Output Schema (JSON)',
				name: 'outputSchema',
				type: 'json',
				default: '',
				description: 'A JSON Schema object for the structured answer',
			},
		],
	},
];
