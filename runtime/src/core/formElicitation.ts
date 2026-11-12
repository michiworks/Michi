/**
 * MCP/ACP form elicitation (a message and a `requestedSchema` of flat
 * properties) as Michi's user-input card, and the card's answers back as the
 * form's typed content.
 */
import type { UserInputAnswer, UserInputQuestion } from '../contract/events';

/** One question of a form elicitation: a schema property, and its `<key>_other` free-text companion. */
export interface FormElicitationField {
    key: string;
    otherKey?: string;
    type: 'string' | 'array' | 'boolean' | 'number' | 'integer';
    choices: Array<{ value: string | boolean; label: string }>;
    question: UserInputQuestion;
}

function schemaChoices(schema: Record<string, any>): Array<{ value: string; label: string }> {
    const listed = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
    if (listed) {
        return listed.filter((choice: any) => typeof choice?.const === 'string')
            .map((choice: any) => ({ value: choice.const, label: typeof choice.title === 'string' && choice.title ? choice.title : choice.const }));
    }
    if (!Array.isArray(schema.enum)) return [];
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.filter((value: unknown): value is string => typeof value === 'string')
        .map((value: string, index: number) => ({ value, label: typeof names[index] === 'string' && names[index] ? names[index] : value }));
}

export function formElicitationFields(params: Record<string, any>): FormElicitationField[] {
    const properties = params.requestedSchema?.properties;
    if (!properties || typeof properties !== 'object') return [];
    const keys = Object.keys(properties);
    const others = new Set(keys.filter((key) => key.endsWith('_other') && keys.includes(key.slice(0, -'_other'.length))));
    const fields: FormElicitationField[] = [];
    for (const key of keys) {
        if (others.has(key)) continue;
        const schema = properties[key] ?? {};
        const type = ['array', 'boolean', 'number', 'integer'].includes(schema.type) ? schema.type : 'string';
        const choices: FormElicitationField['choices'] = type === 'array' ? schemaChoices(schema.items ?? {})
            : type === 'boolean' ? [{ value: true, label: 'Yes' }, { value: false, label: 'No' }]
                : type === 'string' ? schemaChoices(schema) : [];
        const title = typeof schema.title === 'string' && schema.title ? schema.title
            : typeof schema.description === 'string' && schema.description ? schema.description : undefined;
        fields.push({
            key,
            ...(others.has(`${key}_other`) ? { otherKey: `${key}_other` } : {}),
            type,
            choices,
            question: {
                question: title ?? (typeof params.message === 'string' && params.message ? params.message : key),
                options: choices.map((choice) => ({ label: choice.label })),
                multiSelect: type === 'array',
            },
        });
    }
    return fields;
}

/**
 * Michi's card answers with the chosen labels and any typed text joined by
 * ", "; a label may itself contain ", ", so the longest run that names one wins.
 */
function splitAnswer(answer: string, labels: string[]): { chosen: string[]; rest: string } {
    const parts = answer.split(', ');
    const chosen: string[] = [];
    const rest: string[] = [];
    for (let i = 0; i < parts.length;) {
        let end = parts.length;
        while (end > i && !labels.includes(parts.slice(i, end).join(', '))) end--;
        if (end > i) {
            chosen.push(parts.slice(i, end).join(', '));
            i = end;
        } else rest.push(parts[i++]);
    }
    return { chosen, rest: rest.join(', ').trim() };
}

export function formElicitationContent(fields: FormElicitationField[], answers: UserInputAnswer[]): Record<string, unknown> {
    const content: Record<string, unknown> = {};
    fields.forEach((field, index) => {
        const entry = answers[index]?.question === field.question.question ? answers[index]
            : answers.find((candidate) => candidate.question === field.question.question) ?? answers[index];
        const answer = typeof entry?.answer === 'string' ? entry.answer.trim() : '';
        if (!answer) return;
        if (field.type === 'number' || field.type === 'integer') {
            const value = Number(answer);
            content[field.key] = Number.isFinite(value) ? value : answer;
            return;
        }
        const { chosen, rest } = splitAnswer(answer, field.choices.map((choice) => choice.label));
        const values = chosen.map((label) => field.choices.find((choice) => choice.label === label)!.value);
        if (field.type === 'array') content[field.key] = values;
        else if (values.length) content[field.key] = values[0];
        const text = [...(field.type === 'array' ? [] : chosen.slice(1)), ...(rest ? [rest] : [])].join(', ');
        if (!text) return;
        if (field.otherKey) content[field.otherKey] = text;
        else if (!values.length && field.type === 'string') content[field.key] = text;
    });
    return content;
}
