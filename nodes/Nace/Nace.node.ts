import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { getModels, request } from './api';
import { properties } from './properties';
import { buildQuestions, choices, fail, parse } from './questions';
import type { Choice } from './questions';

export class Nace implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Drex by Nace',
		name: 'nace',
		icon: { light: 'file:nace.svg', dark: 'file:nace.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Evaluate, classify, score, and route content with Drex',
		defaults: { name: 'Drex by Nace' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs:
			'={{ $parameter.operation === "route" ? (($parameter.labels?.label || []).map(l => ({type: "main", displayName: l.label})).concat([{type: "main", displayName: "Unsure"}])) : ["main"] }}',
		credentials: [{ name: 'naceApi', required: true }],
		properties,
	};
	methods = { loadOptions: { getModels } };

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		if (!items.length) return [[]];
		const node = this.getNode();
		const isTool = node.type.endsWith('Tool');
		// Output topology comes from fixed configuration, not item expressions.
		const isRoute = node.parameters.operation === 'route';
		const rawLabels = (node.parameters.labels as IDataObject)?.label;
		const configuredLabels = Array.isArray(rawLabels) ? (rawLabels as unknown as Choice[]) : [];
		const outputs: INodeExecutionData[][] = Array.from(
			{ length: isRoute && !isTool ? configuredLabels.length + 1 : 1 },
			() => [],
		);
		for (let index = 0; index < items.length; index++) {
			const item = items[index];
			let options: IDataObject = {
				includeOtherFields: (node.parameters.options as IDataObject)?.includeOtherFields === true,
			};
			try {
				const operation = this.getNodeParameter('operation', index, 'evaluate') as string;
				options = this.getNodeParameter('options', index, {}) as IDataObject;
				const labels = isRoute
					? (this.getNodeParameter('labels.label', index, []) as Choice[])
					: [];
				if (isRoute) {
					if (!configuredLabels.length) fail(this, index, 'Route requires at least one label');
					if (configuredLabels.some((entry) => String(entry.label).startsWith('=')))
						fail(this, index, 'Route label names must be fixed values, not expressions');
					if (
						labels.length !== configuredLabels.length ||
						labels.some((entry, i) => entry.label !== configuredLabels[i].label)
					)
						fail(this, index, 'Route label names must stay fixed across input items');
					choices(this, index, labels);
				}
				const model = this.getNodeParameter('model', index, 'drex-v2.0') as string;
				const format = this.getNodeParameter('stateFormat', index, 'text');
				const state =
					format === 'inputItem'
						? item.json
						: format === 'json'
							? parse(this, index, this.getNodeParameter('stateJson', index, '{}'), 'State')
							: this.getNodeParameter('stateText', index, '');
				const body: IDataObject = {
					model,
					state: state as IDataObject,
					questions: buildQuestions(
						this,
						index,
						operation,
						isRoute ? labels : undefined,
					) as unknown as IDataObject,
				};
				const imageNames = String(this.getNodeParameter('imageProperties', index, ''))
					.split(',')
					.map((name) => name.trim())
					.filter(Boolean);
				const credentials = await this.getCredentials('naceApi');
				const openRouter = credentials.backend === 'openrouter';
				if (
					imageNames.length &&
					(!model.includes('drex-max') || (openRouter && !model.startsWith('nace-ai/drex-max')))
				)
					fail(
						this,
						index,
						'Images require a drex-max model (nace-ai/drex-max on OpenRouter). Select a Max model or remove the image properties.',
					);
				const imageLimit = openRouter ? 4 : 8;
				if (imageNames.length > imageLimit)
					fail(
						this,
						index,
						`${openRouter ? 'OpenRouter' : 'Nace'}: At most ${imageLimit} images are allowed per request`,
					);
				const images: string[] = [];
				let total = 0;
				for (const name of imageNames) {
					const binary = this.helpers.assertBinaryData(index, name);
					if (!['image/png', 'image/jpeg', 'image/webp'].includes(binary.mimeType))
						fail(this, index, `Image ${name}: only PNG, JPEG, or WebP is supported`);
					const buffer = await this.helpers.getBinaryDataBuffer(index, name);
					if (buffer.length > 16 * 1024 * 1024)
						fail(this, index, `Image ${name} exceeds the 16 MiB limit`);
					total += buffer.length;
					if (total > 32 * 1024 * 1024) fail(this, index, 'Images exceed the 32 MiB total limit');
					images.push(`data:${binary.mimeType};base64,${buffer.toString('base64')}`);
				}
				if (images.length) {
					if (openRouter)
						body.state = [
							{ type: 'text', text: typeof state === 'string' ? state : JSON.stringify(state) },
							...images.map((url) => ({ type: 'image_url', image_url: { url } })),
						];
					else body.images = images;
				}
				if (Buffer.byteLength(JSON.stringify(body), 'utf8') >= 4 * 1024 * 1024)
					fail(
						this,
						index,
						'JSON request body must be smaller than 4 MiB, including base64 images. Resize images or shorten the state.',
					);
				const timeout = Number(options.timeout ?? 60000);
				const retries = Number(options.maxRetries ?? 5);
				if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(retries))
					fail(this, index, 'Timeout must be positive and max retries must be a finite number');
				const response = await request(
					this,
					'POST',
					body,
					timeout,
					Math.min(10, Math.max(0, Math.floor(retries))),
					index,
				);
				const answers = response.answers as Record<string, IDataObject> | undefined;
				if (!answers || typeof answers !== 'object' || Array.isArray(answers))
					fail(this, index, 'Drex returned no answers');
				let target = 0;
				if (operation === 'route') {
					const answer = answers.route;
					if (!answer || typeof answer.confidence !== 'number')
						fail(this, index, 'Drex returned no valid route answer');
					const threshold = Number(this.getNodeParameter('confidenceThreshold', index, 0.5));
					if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
						fail(this, index, 'Confidence threshold must be between 0 and 1');
					target =
						answer.confidence < threshold
							? labels.length
							: labels.findIndex((label) => label.label.trim() === answer.choice);
					if (target < 0)
						fail(this, index, `Drex returned an unconfigured route label: ${answer.choice}`);
				}
				const fields: IDataObject = { ...response };
				if (isRoute)
					fields.routeLabel = target === labels.length ? 'Unsure' : labels[target].label.trim();
				if (options.simplify)
					fields.answers = Object.fromEntries(
						Object.entries(answers).map(([id, answer]) => [
							id,
							{
								value: answer.choice ?? answer.score ?? answer.noul,
								confidence: answer.confidence,
							},
						]),
					);
				outputs[isTool ? 0 : target].push({
					json: { ...(options.includeOtherFields ? item.json : {}), ...fields },
					...(options.includeOtherFields && item.binary ? { binary: item.binary } : {}),
					pairedItem: { item: index },
				});
			} catch (error) {
				const failure =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: index });
				if (!this.continueOnFail()) throw failure;
				outputs[!isTool && isRoute ? configuredLabels.length : 0].push({
					json: {
						...(options.includeOtherFields ? item.json : {}),
						error: failure.message,
						description: 'description' in failure ? failure.description : undefined,
					},
					...(options.includeOtherFields && item.binary ? { binary: item.binary } : {}),
					error: failure,
					pairedItem: { item: index },
				});
			}
		}
		return outputs;
	}
}
