import type { IDataObject, INode } from 'n8n-workflow';
import type { Questions } from './questions';
import { isObject, unexpected } from './safety';

const unit = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
export function validateAnswers(
	node: INode,
	secret: string,
	backend: string,
	questions: Questions,
	response: IDataObject,
	itemIndex: number,
): Record<string, IDataObject> {
	const reject = (id: string, reason: string): never => {
		throw unexpected(node, secret, backend, `Questions: Question ${id}: ${reason}`, itemIndex);
	};
	const answers = response.answers;
	if (!isObject(answers)) reject(Object.keys(questions)[0], 'expected an answers object');
	for (const id of Object.keys(questions))
		if (!Object.prototype.hasOwnProperty.call(answers, id)) reject(id, 'answer is missing');
	for (const [id, value] of Object.entries(answers as IDataObject)) {
		if (!isObject(value)) reject(id, 'expected an answer object');
		const answer = value as IDataObject;
		const question = questions[id];
		if (
			typeof answer.type !== 'string' ||
			!['noul', 'choice', 'score'].includes(answer.type) ||
			(question && answer.type !== question.type)
		)
			reject(id, 'answer type does not match the question');
		if (answer.confidence !== undefined && !unit(answer.confidence))
			reject(id, 'confidence must be a number between 0 and 1');
		if (answer.type === 'noul' && !unit(answer.noul))
			reject(id, 'noul must be a number between 0 and 1');
		if (
			answer.type === 'score' &&
			(typeof answer.score !== 'number' || !Number.isFinite(answer.score))
		)
			reject(id, 'score must be a number');
		if (
			answer.type === 'choice' &&
			(typeof answer.choice !== 'string' ||
				(question && !Object.prototype.hasOwnProperty.call(question.criteria, answer.choice)))
		)
			reject(id, 'choice must be one of the requested labels');
		if (
			answer.probabilities !== undefined &&
			(!isObject(answer.probabilities) ||
				Object.values(answer.probabilities).some((probability) => !unit(probability)))
		)
			reject(id, 'probabilities must be numbers between 0 and 1');
	}
	return answers as Record<string, IDataObject>;
}
