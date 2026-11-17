/**
 * A form field: one control of a Pages form block or of an ask_user question,
 * and the value it sends. Free of zod, because the runtime package ships this
 * module; the Pages write schema (pages/richBlocks.ts, formFieldSchema) checks
 * the same shape and applies FORM_FIELD_RULES through formFieldRuleBreaks.
 */
import { isCalendarDay } from './calendarDay';

// A union of its own (not derived from FORM_FIELD_TYPES), so the runtime package's declarations name no value for it.
export type FormFieldType = 'text' | 'textarea' | 'number' | 'slider' | 'select' | 'multiselect' | 'date' | 'time' | 'checkbox';
export const FORM_FIELD_TYPES = ['text', 'textarea', 'number', 'slider', 'select', 'multiselect', 'date', 'time', 'checkbox'] as const satisfies readonly FormFieldType[];
/** Fails to compile when FORM_FIELD_TYPES leaves a type out. */
type MissingFieldType = Exclude<FormFieldType, (typeof FORM_FIELD_TYPES)[number]>;
const everyFieldType: [MissingFieldType] extends [never] ? true : MissingFieldType = true;
void everyFieldType;

export interface FormField {
  key: string;
  label: string;
  type: FormFieldType;
  required?: boolean;
  /** select and multiselect; required for them. */
  options?: string[];
  /** number and slider; a slider needs both, with max > min. */
  min?: number;
  max?: number;
  step?: number;
  /** number and slider, shown after the value. */
  unit?: string;
  /** Must fit the type (and the options, min and max). */
  default?: string | number | boolean | string[];
  /** One short line under the control. */
  help?: string;
}

/**
 * What a field sends: text and textarea a trimmed string; number and slider a
 * number or null; select an option or null; multiselect options in their
 * listed order; date `YYYY-MM-DD` or null; time `HH:mm` or null; checkbox a boolean.
 */
export type FormFieldValue = string | number | boolean | string[] | null;

export const FORM_FIELD_LIMITS = { key: 100, label: 2_000, options: 50, unit: 20, help: 200, number: 1e15 } as const;

/** Rules across a field's properties that a JSON Schema cannot say; each is also the message of the check that enforces it. */
export const FORM_FIELD_RULES = {
  options: 'a select or multiselect field needs options',
  numeric: 'min, max, step and unit are only for number and slider fields',
  slider: 'a slider needs min and max',
  range: 'max is greater than min',
  default: 'default fits the field: its type, options and range',
} as const;

/**
 * A field as JSON Schema, for tool schemas built without zod (ask_user). It
 * names the same properties, types and limits as formFieldSchema; the rules
 * across properties are FORM_FIELD_RULES, checked by parseFormField.
 */
export const FORM_FIELD_JSON_SCHEMA = {
  type: 'object' as const,
  properties: {
    key: { type: 'string', minLength: 1, maxLength: FORM_FIELD_LIMITS.key, description: 'A short id for the value.' },
    label: { type: 'string', minLength: 1, maxLength: FORM_FIELD_LIMITS.label, description: 'The control\'s label.' },
    type: {
      type: 'string', enum: [...FORM_FIELD_TYPES],
      description: 'select and multiselect pick from options; date is YYYY-MM-DD, time is HH:mm; slider needs min and max.',
    },
    required: { type: 'boolean' },
    options: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: FORM_FIELD_LIMITS.options, description: 'The choices of a select or multiselect.' },
    min: { type: 'number', description: 'number and slider only.' },
    max: { type: 'number', description: 'number and slider only; greater than min.' },
    step: { type: 'number', exclusiveMinimum: 0, description: 'number and slider only.' },
    unit: { type: 'string', minLength: 1, maxLength: FORM_FIELD_LIMITS.unit, description: 'Shown after a number or slider value, such as kg.' },
    default: {
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: { type: 'string' } }],
      description: 'The starting value; it must fit the type, the options and the range.',
    },
    help: { type: 'string', minLength: 1, maxLength: FORM_FIELD_LIMITS.help, description: 'One short line shown under the control.' },
  } as Record<keyof FormField, Record<string, unknown>>,
  required: ['key', 'label', 'type'],
  additionalProperties: false,
};

const NUMERIC = new Set<FormFieldType>(['number', 'slider']);
const CHOICE = new Set<FormFieldType>(['select', 'multiselect']);
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/** `HH:mm` on a 24-hour clock. */
export function isTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && TIME.test(value);
}

function defaultFits(field: FormField, value: NonNullable<FormField['default']>): boolean {
  const inRange = (n: number) => (field.min === undefined || n >= field.min) && (field.max === undefined || n <= field.max);
  switch (field.type) {
    case 'text':
    case 'textarea': return typeof value === 'string';
    case 'number':
    case 'slider': return typeof value === 'number' && Number.isFinite(value) && inRange(value);
    case 'select': return typeof value === 'string' && !!field.options?.includes(value);
    case 'multiselect': return Array.isArray(value) && value.every((v) => field.options?.includes(v)) && new Set(value).size === value.length;
    case 'date': return isCalendarDay(value);
    case 'time': return isTimeOfDay(value);
    case 'checkbox': return typeof value === 'boolean';
  }
}

/** The FORM_FIELD_RULES a well-typed field breaks, each with the property it is about. */
export function formFieldRuleBreaks(field: FormField): Array<{ rule: string; property: keyof FormField }> {
  const breaks: Array<{ rule: string; property: keyof FormField }> = [];
  if (CHOICE.has(field.type) && !field.options?.length) breaks.push({ rule: FORM_FIELD_RULES.options, property: 'options' });
  if (!NUMERIC.has(field.type)) {
    const extra = (['min', 'max', 'step', 'unit'] as const).find((key) => field[key] !== undefined);
    if (extra) breaks.push({ rule: FORM_FIELD_RULES.numeric, property: extra });
  } else if (field.type === 'slider' && (field.min === undefined || field.max === undefined)) {
    breaks.push({ rule: FORM_FIELD_RULES.slider, property: field.min === undefined ? 'min' : 'max' });
  }
  if (field.min !== undefined && field.max !== undefined && !(field.max > field.min)) breaks.push({ rule: FORM_FIELD_RULES.range, property: 'max' });
  if (field.default !== undefined && !defaultFits(field, field.default)) breaks.push({ rule: FORM_FIELD_RULES.default, property: 'default' });
  return breaks;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const filledText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= FORM_FIELD_LIMITS.number;
const KEYS = new Set<string>(['key', 'label', 'type', 'required', 'options', 'min', 'max', 'step', 'unit', 'default', 'help']);

/**
 * A field as the agent sent it, or the first reason it is not one
 * (`field.min must be a number`). The same checks as formFieldSchema, for
 * code that cannot use zod.
 */
export function parseFormField(value: unknown, path = 'field'): FormField | string {
  if (!isRecord(value)) return `${path} must be an object`;
  const unknown = Object.keys(value).find((key) => !KEYS.has(key));
  if (unknown !== undefined) return `${path}.${unknown} is not a field property`;
  const { key, label, type } = value;
  if (typeof key !== 'string' || !key || key.length > FORM_FIELD_LIMITS.key || key.trim() !== key) {
    return `${path}.key must be 1-${FORM_FIELD_LIMITS.key} characters, not starting or ending with spaces`;
  }
  if (!filledText(label, FORM_FIELD_LIMITS.label)) return `${path}.label must contain text`;
  if (typeof type !== 'string' || !(FORM_FIELD_TYPES as readonly string[]).includes(type)) return `${path}.type must be one of ${FORM_FIELD_TYPES.join('|')}`;
  const field: FormField = { key, label, type: type as FormFieldType };
  if (value.required !== undefined) {
    if (typeof value.required !== 'boolean') return `${path}.required must be a boolean`;
    field.required = value.required;
  }
  if (value.options !== undefined) {
    const { options } = value;
    if (!Array.isArray(options) || options.length < 1 || options.length > FORM_FIELD_LIMITS.options
      || !options.every((option) => filledText(option, FORM_FIELD_LIMITS.label))) {
      return `${path}.options must list 1-${FORM_FIELD_LIMITS.options} options, each with text`;
    }
    field.options = options as string[];
  }
  for (const name of ['min', 'max', 'step'] as const) {
    if (value[name] === undefined) continue;
    if (!finite(value[name])) return `${path}.${name} must be a number`;
    if (name === 'step' && !((value[name] as number) > 0)) return `${path}.step must be greater than 0`;
    field[name] = value[name] as number;
  }
  if (value.unit !== undefined) {
    if (!filledText(value.unit, FORM_FIELD_LIMITS.unit)) return `${path}.unit must be 1-${FORM_FIELD_LIMITS.unit} characters`;
    field.unit = value.unit;
  }
  if (value.default !== undefined) {
    const d = value.default;
    const ok = typeof d === 'string' ? d.length <= FORM_FIELD_LIMITS.label : typeof d === 'boolean' || finite(d)
      || (Array.isArray(d) && d.length <= FORM_FIELD_LIMITS.options && d.every((v) => typeof v === 'string'));
    if (!ok) return `${path}.default must be text, a number, a boolean or a list of options`;
    field.default = d as FormField['default'];
  }
  if (value.help !== undefined) {
    if (!filledText(value.help, FORM_FIELD_LIMITS.help)) return `${path}.help must be 1-${FORM_FIELD_LIMITS.help} characters`;
    field.help = value.help;
  }
  const broken = formFieldRuleBreaks(field)[0];
  return broken ? `${path}.${broken.property} breaks the rule "${broken.rule}"` : field;
}

/** The value a field starts with: its default, else empty (a slider starts at its min). */
export function formFieldInitialValue(field: FormField): FormFieldValue {
  if (field.default !== undefined) return Array.isArray(field.default) ? [...field.default] : field.default;
  switch (field.type) {
    case 'text':
    case 'textarea': return '';
    case 'multiselect': return [];
    case 'checkbox': return false;
    case 'slider': return field.min ?? 0;
    default: return null;
  }
}

/** Nothing at all, an empty list, or a required box left unticked; zero and an unticked optional box are answers. */
export function isFormFieldValueMissing(field: FormField, value: FormFieldValue): boolean {
  if (!field.required) return false;
  if (field.type === 'checkbox') return value !== true;
  return value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * A value as a person reads it, for receipts and an answer's display text:
 * `3 kg`, `Yes`, `Red, Blue`. Empty for no value. Multiselect joins with ", ",
 * as the ask card always has.
 */
export function formFieldValueText(field: FormField, value: FormFieldValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') return field.unit ? `${value} ${field.unit}` : String(value);
  return value;
}

/** A value of the shape some field can send. */
export function isFormFieldValue(value: unknown): value is FormFieldValue {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || finite(value)
    || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
}
