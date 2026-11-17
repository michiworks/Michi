// ask_user's contract with the model: name, description, schema, validation
// and result text. The runtime's builtin, Michi's MCP server and Pi's tool
// all serve it, each with its own transport.
import { FORM_FIELD_JSON_SCHEMA, parseFormField, type FormFieldValue } from 'michi-shared';
import type { AskUserAnswers, AskUserOption, AskUserQuestion, JsonSchemaObject } from './types';

export const ASK_USER_TOOL = 'ask_user';

export const ASK_USER_DESCRIPTION = 'Ask the user one or more structured questions. '
  + 'Use when you need the user to make a choice or provide input before proceeding. '
  + 'A question either lists options, single-select or multi-select, and users can always type a custom answer; '
  + 'or it has a field instead of options: one control such as a number, slider, date, time, text box or checkbox, '
  + 'whose answer comes back as a typed value (a number, true/false, a list for multiselect, null when left empty).';

export const ASK_USER_NOT_ANSWERED = 'The user did not answer the questions (skipped or timed out).';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const ASK_USER_INPUT_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      description: 'Questions to ask (1-4).',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question to ask the user.' },
          header: { type: 'string', description: 'Short label (max 12 chars) displayed as a chip/tag.' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            description: 'Available choices (2-4 options). Leave out when the question has a field.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Display text for this option (1-5 words).' },
                description: { type: 'string', description: 'Explanation of what this option means.' },
              },
              required: ['label'],
            },
          },
          multiSelect: { type: 'boolean', default: false, description: 'Allow multiple selections.' },
          field: { ...FORM_FIELD_JSON_SCHEMA, description: 'Instead of options: one control whose typed value is the answer.' },
        },
        required: ['question'],
      },
    },
  },
  required: ['questions'],
};

/** Normalized questions, or an error message for the agent. */
export function parseAskUserQuestions(raw: unknown): AskUserQuestion[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) return 'questions must be an array of 1-4 questions.';
  const questions: AskUserQuestion[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry) || typeof entry.question !== 'string' || entry.question.trim() === '') {
      return `questions[${i}].question must be a non-empty string.`;
    }
    if (entry.field !== undefined) {
      // A field takes the place of the options: any sent alongside it are ignored.
      const field = parseFormField(entry.field, `questions[${i}].field`);
      if (typeof field === 'string') return `${field}.`;
      const question: AskUserQuestion = { question: entry.question, options: [], multiSelect: false, field };
      if (typeof entry.header === 'string') question.header = entry.header;
      questions.push(question);
      continue;
    }
    if (!Array.isArray(entry.options) || entry.options.length < 2 || entry.options.length > 4) {
      return `questions[${i}].options must list 2-4 options.`;
    }
    const options: AskUserOption[] = [];
    for (const [j, option] of entry.options.entries()) {
      if (!isRecord(option) || typeof option.label !== 'string' || option.label.trim() === '') {
        return `questions[${i}].options[${j}].label must be a non-empty string.`;
      }
      options.push(typeof option.description === 'string'
        ? { label: option.label, description: option.description }
        : { label: option.label });
    }
    const question: AskUserQuestion = { question: entry.question, options, multiSelect: entry.multiSelect === true };
    if (typeof entry.header === 'string') question.header = entry.header;
    questions.push(question);
  }
  return questions;
}

/**
 * The answers keyed by question, as the ask_user tool returns them: a field
 * question's typed value, any other question's answer text. A value sent for
 * a question without a field is not taken (approvals read text), and a field
 * question answered from a card that cannot draw fields keeps its text.
 */
export function askUserAnswers(
  questions: ReadonlyArray<{ question: string; field?: unknown }>,
  answers: ReadonlyArray<{ question: string; answer: string; value?: FormFieldValue }>,
): AskUserAnswers {
  const fields = new Set(questions.filter((q) => q.field !== undefined).map((q) => q.question));
  const byQuestion: AskUserAnswers = {};
  for (const a of answers) byQuestion[a.question] = a.value !== undefined && fields.has(a.question) ? a.value : a.answer;
  return byQuestion;
}
