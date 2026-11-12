// ask_user's contract with the model: name, description, schema, validation
// and result text. The runtime's builtin, Michi's MCP server and Pi's tool
// all serve it, each with its own transport.
import type { AskUserOption, AskUserQuestion, JsonSchemaObject } from './types';

export const ASK_USER_TOOL = 'ask_user';

export const ASK_USER_DESCRIPTION = 'Ask the user one or more structured questions with selectable options. '
  + 'Use when you need the user to make a choice or provide input before proceeding. '
  + 'Each question can be single-select or multi-select, and users can always type a custom answer.';

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
            description: 'Available choices (2-4 options).',
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
        },
        required: ['question', 'options'],
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
