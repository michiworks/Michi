import {
  formFieldInitialValue, isCalendarDay, isFormFieldValueMissing, isTimeOfDay, type FormField, type FormFieldValue,
} from 'michi-shared';

// What a field's control holds and sends, without Mantine: the ask card reads these before it loads the controls.

/**
 * What a control holds while it is being filled in. A number box keeps what
 * was typed (`'1.'`, `'-'`) until it is read; answerOf turns it into the value
 * the field sends.
 */
export type FieldRaw = string | number | boolean | string[] | null;

/** What a control starts with: the field's default, else empty (a slider at its min). */
export function blankValue(field: FormField): FieldRaw {
  const value = formFieldInitialValue(field);
  return field.type === 'number' && value === null ? '' : value;
}

/**
 * What goes out for a field (formField.ts, FormFieldValue): text trimmed, a
 * number as a number (empty or half-typed is null), a date as YYYY-MM-DD, a
 * time as HH:mm, a select as the option, a multiselect as its options in the
 * order they are listed.
 */
export function answerOf(field: FormField, raw: FieldRaw): FormFieldValue {
  switch (field.type) {
    case 'text':
    case 'textarea': return typeof raw === 'string' ? raw.trim() : '';
    case 'number':
    case 'slider': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox': return raw === true;
    case 'multiselect': return (field.options ?? []).filter((option) => Array.isArray(raw) && raw.includes(option));
    case 'select': return typeof raw === 'string' && field.options?.includes(raw) ? raw : null;
    case 'date': return isCalendarDay(raw) ? raw : null;
    case 'time': return isTimeOfDay(raw) ? raw : null;
  }
}

/** Zero and an unticked optional box are answers; only nothing at all, an empty list, or a required box left unticked are not. */
export function isMissing(field: FormField, answer: FormFieldValue): boolean {
  return isFormFieldValueMissing(field, answer);
}
