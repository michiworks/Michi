import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FORM_FIELD_JSON_SCHEMA, FORM_FIELD_RULES, formFieldInitialValue, formFieldValueText, isFormFieldValueMissing, parseFormField, type FormField,
} from '../src/formField';
import { PAGE_BLOCK_CATALOG, formFieldSchema, pageBlockProblem, parsePageBlockInput } from '../src/pages';
import { richBlockJsonSchema } from '../src/pages/richBlocks';

const form = (...fields: unknown[]) => ({ type: 'form', title: 'Trip', prompt: 'Plan it', fields });

/** Fields both checks accept, and fields both refuse, with the rule or property the refusal names. */
const GOOD: FormField[] = [
  { key: 'city', label: 'City', type: 'text', required: true, default: 'Kyoto', help: 'Where you land' },
  { key: 'notes', label: 'Notes', type: 'textarea' },
  { key: 'n', label: 'Nights', type: 'number', min: 1, max: 30, step: 1, unit: 'nights', default: 3 },
  { key: 'b', label: 'Budget', type: 'slider', min: 0, max: 5000, step: 100, unit: 'USD', default: 1500 },
  { key: 's', label: 'Seat', type: 'select', options: ['Aisle', 'Window'], default: 'Aisle' },
  { key: 'm', label: 'Meals', type: 'multiselect', options: ['Breakfast', 'Dinner'], default: ['Dinner'] },
  { key: 'd', label: 'Day', type: 'date', default: '2026-11-20' },
  { key: 't', label: 'Time', type: 'time', default: '09:30' },
  { key: 'c', label: 'Insurance', type: 'checkbox', default: false },
  // Options on a text field were always allowed and are ignored.
  { key: 'x', label: 'X', type: 'text', options: ['a'] },
];
const BAD: Array<[unknown, RegExp]> = [
  [{ key: 's', label: 'S', type: 'select' }, /options breaks the rule "a select or multiselect field needs options"/],
  [{ key: 'm', label: 'M', type: 'multiselect' }, /options breaks the rule "a select or multiselect/],
  [{ key: 't', label: 'T', type: 'text', unit: 'kg' }, /unit breaks the rule "min, max, step and unit are only for number and slider fields"/],
  [{ key: 'd', label: 'D', type: 'date', min: 1 }, /min breaks the rule "min, max, step and unit/],
  [{ key: 'b', label: 'B', type: 'slider', min: 0 }, /max breaks the rule "a slider needs min and max"/],
  [{ key: 'b', label: 'B', type: 'slider', min: 5, max: 5 }, /max breaks the rule "max is greater than min"/],
  [{ key: 'n', label: 'N', type: 'number', min: 9, max: 1 }, /max breaks the rule "max is greater than min"/],
  [{ key: 'n', label: 'N', type: 'number', max: 10, default: 11 }, /default breaks the rule "default fits the field/],
  [{ key: 'n', label: 'N', type: 'number', default: '3' }, /default breaks the rule/],
  [{ key: 's', label: 'S', type: 'select', options: ['a'], default: 'b' }, /default breaks the rule/],
  [{ key: 'm', label: 'M', type: 'multiselect', options: ['a', 'b'], default: ['a', 'a'] }, /default breaks the rule/],
  [{ key: 'd', label: 'D', type: 'date', default: '2026-02-30' }, /default breaks the rule/],
  [{ key: 't', label: 'T', type: 'time', default: '24:00' }, /default breaks the rule/],
  [{ key: 'c', label: 'C', type: 'checkbox', default: 'yes' }, /default breaks the rule/],
  [{ key: 'n', label: 'N', type: 'number', step: 0 }, /step/],
  [{ key: 'x', label: 'X', type: 'color' }, /type/],
  [{ key: ' x', label: 'X', type: 'text' }, /key/],
  [{ key: 'x', label: ' ', type: 'text' }, /label/],
  [{ key: 'x', label: 'X', type: 'text', placeholder: 'p' }, /placeholder/],
];

test('the write schema and the zod-free parser agree on every field', () => {
  for (const field of GOOD) {
    assert.deepEqual(parseFormField(field), field, JSON.stringify(field));
    assert.ok(formFieldSchema.safeParse(field).success, JSON.stringify(field));
  }
  for (const [field, reason] of BAD) {
    const parsed = parseFormField(field);
    assert.equal(typeof parsed, 'string', JSON.stringify(field));
    assert.match(parsed as string, reason);
    assert.equal(formFieldSchema.safeParse(field).success, false, JSON.stringify(field));
  }
});

test('the hand-written JSON Schema names what the write schema does', () => {
  const written = richBlockJsonSchema(formFieldSchema) as { properties: Record<string, { type?: unknown; enum?: unknown }>; required: string[] };
  assert.deepEqual(Object.keys(FORM_FIELD_JSON_SCHEMA.properties), Object.keys(written.properties));
  assert.deepEqual(FORM_FIELD_JSON_SCHEMA.required, written.required);
  for (const [key, property] of Object.entries(written.properties)) {
    assert.deepEqual((FORM_FIELD_JSON_SCHEMA.properties as Record<string, { type?: unknown }>)[key].type, property.type, key);
  }
  assert.deepEqual(FORM_FIELD_JSON_SCHEMA.properties.type.enum, written.properties.type.enum);
});

test('a form block takes every field type and names the field a rule refuses', () => {
  assert.ok(parsePageBlockInput(form(...GOOD)));
  assert.equal(parsePageBlockInput(form({ key: 'b', label: 'B', type: 'slider', min: 0 })), null);
  assert.match(pageBlockProblem(form(GOOD[0], { key: 'b', label: 'B', type: 'slider', min: 0 })),
    /fields\[1\]\.max breaks the rule "a slider needs min and max"/);
  // A select without options was refused before the field rules too; keys stay unique.
  assert.match(pageBlockProblem(form({ key: 's', label: 'S', type: 'select' })), /fields\[0\]\.options breaks the rule/);
  assert.match(pageBlockProblem(form(GOOD[0], GOOD[0])), /field keys are unique/);
});

test('the form tool description lists the new types and the field rules', () => {
  const { fields } = PAGE_BLOCK_CATALOG.form;
  assert.match(fields, /text\|textarea\|number\|slider\|select\|multiselect\|date\|time\|checkbox/);
  for (const rule of Object.values(FORM_FIELD_RULES)) assert.ok(fields.includes(rule), rule);
});

test('a field starts at its default, else empty, and says when a required one is missing', () => {
  assert.equal(formFieldInitialValue(GOOD[2]), 3);
  assert.deepEqual(formFieldInitialValue(GOOD[5]), ['Dinner']);
  assert.equal(formFieldInitialValue({ key: 'b', label: 'B', type: 'slider', min: 10, max: 20 }), 10);
  assert.deepEqual(formFieldInitialValue({ key: 'm', label: 'M', type: 'multiselect', options: ['a'] }), []);
  assert.equal(formFieldInitialValue({ key: 'n', label: 'N', type: 'number' }), null);
  assert.equal(formFieldInitialValue({ key: 'c', label: 'C', type: 'checkbox' }), false);
  const required = (type: FormField['type']): FormField => ({ key: 'k', label: 'L', type, required: true, options: ['a'] });
  assert.equal(isFormFieldValueMissing(required('number'), 0), false);
  assert.equal(isFormFieldValueMissing(required('number'), null), true);
  assert.equal(isFormFieldValueMissing(required('multiselect'), []), true);
  assert.equal(isFormFieldValueMissing(required('checkbox'), false), true);
  assert.equal(isFormFieldValueMissing({ ...required('text'), required: false }, ''), false);
});

test('a value reads with its unit, Yes/No and comma-joined options', () => {
  assert.equal(formFieldValueText(GOOD[2], 3), '3 nights');
  assert.equal(formFieldValueText(GOOD[8], true), 'Yes');
  assert.equal(formFieldValueText(GOOD[5], ['Breakfast', 'Dinner']), 'Breakfast, Dinner');
  assert.equal(formFieldValueText(GOOD[7], null), '');
});
