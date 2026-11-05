import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { itemText } from './safety';

export interface Choice {
	label: string;
	description?: string | null;
}
export interface Question {
	type: 'noul' | 'choice' | 'score';
	instructions: string;
	criteria: IDataObject | string[];
}
export type Questions = Record<string, Question>;
export function fail(context: IExecuteFunctions, index: number, message: string): never {
	throw new NodeOperationError(context.getNode(), itemText(message, index), { itemIndex: index });
}
export function parse(
	context: IExecuteFunctions,
	index: number,
	value: unknown,
	label: string,
): unknown {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value);
	} catch {
		return fail(context, index, `${label} must be valid JSON`);
	}
}
export function choices(context: IExecuteFunctions, index: number, entries: Choice[]): IDataObject {
	if (!entries.length) fail(context, index, 'Labels / Choices: Add at least one choice label');
	const labels = entries.map((entry) => String(entry.label || '').trim());
	if (labels.some((label) => !label) || new Set(labels).size !== labels.length)
		fail(context, index, 'Labels / Choices: Choice labels must be nonempty and unique');
	return Object.fromEntries(entries.map((entry, i) => [labels[i], entry.description || null]));
}
export function buildQuestions(
	context: IExecuteFunctions,
	index: number,
	operation: string,
	labels?: Choice[],
): Questions {
	const param = (name: string, fallback: unknown = '') =>
		context.getNodeParameter(name, index, fallback as string);
	let raw: unknown;
	if (operation === 'evaluate' && param('questionsMode', 'ui') === 'json') {
		raw = parse(context, index, param('questionsJson', '{}'), 'Questions (JSON)');
	} else if (operation === 'evaluate') {
		const entries = param('questions.question', []) as IDataObject[];
		const ids = entries.map((entry) => String(entry.id || '').trim());
		if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
			fail(context, index, 'Questions: Question IDs must be nonempty and unique');
		raw = Object.fromEntries(
			entries.map((entry, i) => [
				ids[i],
				{
					type: entry.type,
					instructions: entry.instructions ?? '',
					criteria:
						entry.type === 'noul'
							? {
									...(entry.trueMeaning ? { true: entry.trueMeaning } : {}),
									...(entry.falseMeaning ? { false: entry.falseMeaning } : {}),
								}
							: entry.type === 'choice'
								? choices(
										context,
										index,
										((entry.choices as IDataObject)?.choice || []) as unknown as Choice[],
									)
								: (((entry.levels as IDataObject)?.level as IDataObject[]) || []).map(
										(level) => level.description,
									),
				},
			]),
		);
	} else {
		raw = {
			[operation === 'route' ? 'route' : operation]: {
				type: operation === 'score' ? 'score' : 'choice',
				instructions: param('instructions'),
				criteria:
					operation === 'score'
						? (param('levels.level', []) as IDataObject[]).map((level) => level.description)
						: choices(context, index, labels ?? (param('labels.label', []) as Choice[])),
			},
		};
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		fail(context, index, 'Questions must be an object keyed by question ID');
	const entries = Object.entries(raw);
	if (entries.length < 1 || entries.length > 512)
		fail(context, index, 'Questions: Provide between 1 and 512 questions');
	return Object.fromEntries(
		entries.map(([id, value]) => {
			if (!id.trim() || !value || typeof value !== 'object' || Array.isArray(value))
				fail(context, index, `Questions: Invalid question: ${id}`);
			const question = value as Question;
			if (!['noul', 'choice', 'score'].includes(question.type))
				fail(context, index, `Questions: Question ${id}: type must be noul, choice, or score`);
			if (question.instructions != null && typeof question.instructions !== 'string')
				fail(context, index, `Questions: Question ${id}: instructions must be a string`);
			let criteria = question.criteria ?? (question.type === 'noul' ? {} : undefined);
			if (question.type === 'score') {
				if (
					!Array.isArray(criteria) ||
					!criteria.length ||
					criteria.some((level) => typeof level !== 'string' || !level.trim())
				)
					fail(
						context,
						index,
						`Questions: Question ${id}: score criteria must be a nonempty array of level descriptions ordered low to high`,
					);
			} else {
				if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria))
					fail(context, index, `Questions: Question ${id}: criteria must be an object`);
				const values = Object.entries(criteria);
				if (
					question.type === 'choice' &&
					(!values.length ||
						values.some(
							([label, description]) =>
								!label.trim() || (description != null && typeof description !== 'string'),
						))
				)
					fail(
						context,
						index,
						`Questions: Question ${id}: choice criteria must map labels to descriptions or null`,
					);
				if (
					question.type === 'noul' &&
					values.some(
						([key, meaning]) => !['true', 'false'].includes(key) || typeof meaning !== 'string',
					)
				)
					fail(
						context,
						index,
						`Questions: Question ${id}: noul criteria may contain true and false meanings as strings`,
					);
				if (question.type === 'choice')
					criteria = Object.fromEntries(
						values.map(([key, description]) => [key, description || null]),
					);
			}
			return [
				id,
				{ type: question.type, instructions: question.instructions ?? '', criteria } as Question,
			];
		}),
	);
}
