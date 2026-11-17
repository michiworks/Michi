import type { KeyboardEvent } from 'react';
import { Checkbox, Input, MultiSelect, NumberInput, Select, Slider, TextInput, Textarea } from '@mantine/core';
import { DatePickerInput, DatesProvider, TimePicker } from '@mantine/dates';
import 'dayjs/locale/zh-cn';
import { formFieldValueText, type FormField } from 'michi-shared';
import type { FieldRaw } from './fieldValues';
import { isImeComposing } from '../../../../../../../../../../lib/ime';
import { L } from '../../../../../shared/i18n';
import './FieldControl.css';

export { answerOf, blankValue, isMissing, type FieldRaw } from './fieldValues';

export interface FieldControlProps {
  field: FormField;
  value: FieldRaw;
  onChange: (value: FieldRaw) => void;
  /** Said under the control, which is then marked invalid. */
  error?: string;
  disabled?: boolean;
  /**
   * The label is read aloud but not drawn, for a host that already shows it
   * (the ask card's question). A slider still shows its value.
   */
  hideLabel?: boolean;
  /** Enter in a one-line box (text, number, time); a textarea takes Mod+Enter. */
  onEnter?: () => void;
  autoFocus?: boolean;
  /** Mantine's size of the boxes; MichiMantine's default (sm) when left out. The ask card draws xs. A slider keeps its own: at xs its thumb is all border. */
  size?: 'xs' | 'sm';
}

/** Help sits under the control, before the error. */
const WRAPPER_ORDER: ('label' | 'input' | 'description' | 'error')[] = ['label', 'input', 'description', 'error'];

/**
 * One Mantine control for a form field (FormBlock, the ask card). It needs a
 * MichiMantine above it.
 */
export function FieldControl({ field, value, onChange, error, disabled, hideLabel, onEnter, autoFocus, size }: FieldControlProps) {
  const common = {
    size,
    label: hideLabel ? undefined : field.label,
    'aria-label': hideLabel ? field.label : undefined,
    required: field.required,
    description: field.help,
    inputWrapperOrder: WRAPPER_ORDER,
    error,
    disabled,
    autoFocus,
  };
  const enter = (multiline: boolean) => (event: KeyboardEvent) => {
    if (!onEnter || event.key !== 'Enter' || event.shiftKey || isImeComposing(event)) return;
    if (multiline && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    onEnter();
  };
  switch (field.type) {
    case 'number':
      return (
        <NumberInput
          {...common}
          value={value as string | number}
          onChange={(v) => onChange(v)}
          onKeyDown={enter(false)}
          min={field.min}
          max={field.max}
          step={field.step}
          // Whole steps from a whole start take whole numbers (an integer elicitation asks with step 1).
          allowDecimal={field.step === undefined || !Number.isInteger(field.step) || (field.min !== undefined && !Number.isInteger(field.min))}
          suffix={field.unit ? ` ${field.unit}` : undefined}
          thousandSeparator=","
          hideControls
        />
      );
    case 'slider': {
      const current = typeof value === 'number' ? value : field.min ?? 0;
      const shown = formFieldValueText(field, current);
      return (
        <Input.Wrapper
          label={hideLabel ? undefined : field.label}
          required={field.required}
          description={field.help}
          inputWrapperOrder={WRAPPER_ORDER}
          error={error}
          classNames={{ root: 'michi-field-slider' }}
        >
          <div className="michi-field-slider-row">
            <Slider
              className="michi-field-slider-track"
              value={current}
              onChange={(v) => onChange(v)}
              min={field.min}
              max={field.max}
              step={field.step}
              label={(v) => formFieldValueText(field, v)}
              thumbLabel={field.label}
              disabled={disabled}
            />
            <output className="michi-field-slider-value" aria-hidden>{shown}</output>
          </div>
        </Input.Wrapper>
      );
    }
    case 'select':
      return (
        <Select
          {...common}
          data={field.options ?? []}
          value={value as string | null}
          onChange={(v) => onChange(v)}
          placeholder={L('请选择', 'Choose')}
          allowDeselect={!field.required}
        />
      );
    case 'multiselect':
      return (
        <MultiSelect
          {...common}
          data={field.options ?? []}
          value={Array.isArray(value) ? value : []}
          onChange={(v) => onChange(v)}
          placeholder={Array.isArray(value) && value.length ? undefined : L('请选择', 'Choose any')}
          clearable={!field.required}
        />
      );
    case 'date':
      return (
        <DatesProvider settings={{ locale: L('zh-cn', 'en'), firstDayOfWeek: 1 }}>
          <DatePickerInput
            {...common}
            value={value as string | null}
            onChange={(v) => onChange(v)}
            valueFormat={L('YYYY年M月D日', 'MMM D, YYYY')}
            placeholder={L('选择日期', 'Pick a date')}
            clearable={!field.required}
          />
        </DatesProvider>
      );
    case 'time':
      return (
        // Hours and minutes on a 24-hour clock whatever the browser's locale: what shows is what is sent (HH:mm).
        <TimePicker
          {...common}
          format="24h"
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next || null)}
          onKeyDown={enter(false)}
          clearable={!field.required}
          hoursInputLabel={`${field.label}, hours`}
          minutesInputLabel={`${field.label}, minutes`}
        />
      );
    case 'checkbox':
      return (
        // A checkbox always draws its label: it is what the box is beside.
        <Checkbox
          label={field.label}
          required={field.required}
          description={field.help}
          error={error}
          disabled={disabled}
          autoFocus={autoFocus}
          size={size}
          checked={value === true}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      );
    case 'textarea':
      return (
        <Textarea
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={enter(true)}
          autosize
          minRows={2}
          maxRows={8}
        />
      );
    default:
      return (
        <TextInput
          {...common}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={enter(false)}
        />
      );
  }
}
