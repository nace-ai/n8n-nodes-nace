import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { getModels, request } from './api';
import { properties } from './properties';
import { attachImages } from './images';
import { validateAnswers } from './response';
import { cleanInput, cleanJson, operationFailure, unexpected } from './safety';
import { buildQuestions, choices, fail, parse } from './questions';
import type { Choice, Questions } from './questions';

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
			let secret = '';
			try {
				const credentials = await this.getCredentials('naceApi');
				secret = String(credentials.apiKey || '');
				const openRouter = credentials.backend === 'openrouter';
				const operation = this.getNodeParameter('operation', index, 'evaluate') as string;
				options = this.getNodeParameter('options', index, {}) as IDataObject;
				const labels = isRoute
					? (this.getNodeParameter('labels.label', index, []) as Choice[])
					: [];
				if (isRoute) {
					if (!configuredLabels.length)
						fail(this, index, 'Labels: Route requires at least one label');
					if (configuredLabels.some((entry) => String(entry.label).startsWith('=')))
						fail(this, index, 'Labels: Route label names must be fixed values, not expressions');
					if (
						labels.length !== configuredLabels.length ||
						labels.some((entry, i) => entry.label !== configuredLabels[i].label)
					)
						fail(this, index, 'Labels: Route label names must stay fixed across input items');
					if (labels.some((entry) => entry.label.trim().toLowerCase() === 'unsure'))
						fail(this, index, 'Labels: Route label Unsure is reserved for the final Unsure output');
					choices(this, index, labels);
				}
				const model = this.getNodeParameter('model', index, 'drex-v2.0') as string;
				if (openRouter && !model.startsWith('nace-ai/'))
					fail(
						this,
						index,
						`Model Name or ID: OpenRouter models must start with nace-ai/. Try nace-ai/${model}.`,
					);
				const format = this.getNodeParameter('stateFormat', index, 'text');
				const state =
					format === 'inputItem'
						? item.json
						: format === 'json'
							? parse(this, index, this.getNodeParameter('stateJson', index, '{}'), 'State (JSON)')
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
				if (
					imageNames.length &&
					(!model.includes('drex-max') || (openRouter && !model.startsWith('nace-ai/drex-max')))
				)
					fail(
						this,
						index,
						'Image Binary Properties: Images require a drex-max model (nace-ai/drex-max on OpenRouter). Select a Max model or remove the image properties.',
					);
				await attachImages(this, index, body, imageNames, openRouter);
				const timeout = Number(options.timeout ?? 60000);
				const retries = Number(options.maxRetries ?? 5);
				if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(retries))
					fail(this, index, 'Timeout must be positive and Max Retries must be a finite number');
				const response = await request(
					this,
					'POST',
					body,
					timeout,
					Math.min(10, Math.max(0, Math.floor(retries))),
					index,
				);
				const answers = validateAnswers(
					this.getNode(),
					secret,
					openRouter ? 'OpenRouter' : 'Nace',
					body.questions as unknown as Questions,
					response,
					index,
				);
				let target = 0;
				if (operation === 'route') {
					const answer = answers.route;
					if (!answer || typeof answer.confidence !== 'number')
						throw unexpected(
							this.getNode(),
							secret,
							openRouter ? 'OpenRouter' : 'Nace',
							'Questions: Question route: confidence is required for routing',
							index,
						);
					const threshold = Number(this.getNodeParameter('confidenceThreshold', index, 0.5));
					if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)
						fail(this, index, 'Confidence Threshold must be between 0 and 1');
					target =
						answer.confidence < threshold
							? labels.length
							: labels.findIndex((label) => label.label.trim() === answer.choice);
					if (target < 0)
						fail(
							this,
							index,
							`Labels: Drex returned an unconfigured route label: ${answer.choice}`,
						);
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
					json: {
						...(options.includeOtherFields ? cleanInput(item.json, secret) : {}),
						...(cleanJson(fields, secret) as IDataObject),
					},
					...(options.includeOtherFields && item.binary ? { binary: item.binary } : {}),
					pairedItem: { item: index },
				});
			} catch (error) {
				const failure = operationFailure(this.getNode(), secret, error, index);
				if (!this.continueOnFail()) throw failure;
				outputs[!isTool && isRoute ? configuredLabels.length : 0].push({
					json: {
						...(options.includeOtherFields ? cleanInput(item.json, secret) : {}),
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
