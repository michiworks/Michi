import React, { useId, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import {
  formatSkillFile, readSkillFileInfo, SKILL_NAME_MAX, validateLibrarySkill, withSkillFileFields, type SkillSummary,
} from 'michi-shared';
import { Button } from '../../../ui/controls';
import { createLibrarySkill, notifySkillsChanged, SkillsApiError, updateLibrarySkill } from '../../../../services/api/skills';
import { useSettingsBack, useSettingsPageTitle, useSettingsPhone } from './settingsPhone';
import { draftProblems, errorText, type DraftField, type SkillDraft } from './skillsModel';
import { isImeComposing } from '../../../../lib/ime';

const FIELDS: readonly DraftField[] = ['name', 'description', 'argumentHint', 'body'];

/**
 * New skill and Edit, one form: the name (new skills only), description,
 * argument hint and instructions. Edit writes them into the skill's
 * SKILL.md and keeps its other frontmatter keys. ⌘/Ctrl+Enter saves,
 * Escape cancels, except while an input method is composing.
 */
export function SkillForm({ editing, taken, backendConnectionId, root, machine, onSaved, onCancel }: {
  /** The skill being edited and its SKILL.md; absent for a new skill. */
  editing?: { skill: SkillSummary; content: string };
  /** The library's names. */
  taken: ReadonlySet<string>;
  backendConnectionId: string;
  root: string | null;
  machine: string | null;
  onSaved: (skill: SkillSummary) => void;
  onCancel: () => void;
}) {
  const phone = useSettingsPhone();
  const [draft, setDraft] = useState<SkillDraft>(() => {
    if (!editing) return { name: '', description: '', argumentHint: '', body: '' };
    const info = readSkillFileInfo(editing.content, editing.skill.name);
    return { name: editing.skill.name, description: info.description, argumentHint: info.argumentHint ?? '', body: info.body };
  });
  // Field problems show once a save was tried, then follow every edit.
  const [tried, setTried] = useState(false);
  const [takenHere, setTakenHere] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const base = useId();
  useSettingsBack(onCancel);
  useSettingsPageTitle(true);

  const names = takenHere ? new Set([...taken, takenHere]) : taken;
  const problems = tried ? draftProblems(draft, editing ? null : names) : {};
  const set = (field: DraftField, value: string) => { setDraft((current) => ({ ...current, [field]: value })); setRefused([]); };
  const fieldId = (field: DraftField) => `${base}-${field}`;

  const submit = async () => {
    if (busy.current) return;
    setTried(true);
    const found = draftProblems(draft, editing ? null : names);
    const first = FIELDS.find((field) => found[field]);
    if (first) { document.getElementById(fieldId(first))?.focus(); return; }
    const name = editing?.skill.name ?? draft.name.trim();
    const fields = { description: draft.description, argumentHint: draft.argumentHint, body: draft.body };
    const content = editing ? withSkillFileFields(editing.content, fields) : formatSkillFile({ name, ...fields });
    const invalid = validateLibrarySkill({ name, content });
    if (invalid.length > 0) { setRefused(invalid); return; }
    busy.current = true;
    setSaving(true);
    try {
      const target = { backendConnectionId };
      onSaved(editing ? await updateLibrarySkill(name, { content }, target) : await createLibrarySkill(name, { content }, target));
      notifySkillsChanged();
    } catch (reason) {
      if (reason instanceof SkillsApiError && reason.code === 'name_taken') setTakenHere(name);
      else if (reason instanceof SkillsApiError && reason.code === 'invalid_skill') setRefused(reason.problems.length > 0 ? reason.problems : [reason.message]);
      else setRefused([`Couldn’t ${editing ? 'save' : 'create'} the skill: ${errorText(reason)}.`]);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const field = (name: DraftField, label: string, help: string, control: (props: {
    id: string; value: string; 'aria-invalid': boolean; 'aria-describedby': string; onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  }) => React.ReactNode) => {
    const id = fieldId(name);
    const problem = problems[name];
    return <div className="skills-field">
      <label className="settings-row__label" htmlFor={id}>{label}</label>
      <p className="settings-row__desc" id={`${id}-help`}>{help}</p>
      {control({ id, value: draft[name], 'aria-invalid': !!problem, 'aria-describedby': problem ? `${id}-help ${id}-problem` : `${id}-help`, onChange: (event) => set(name, event.target.value) })}
      {problem && <p className="skills-field__error" id={`${id}-problem`}>{problem}</p>}
    </div>;
  };

  const title = editing ? `Edit ${editing.skill.name}` : 'New skill';
  return <form className="settings-history__detail skills-form" aria-label={title} noValidate
    onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => {
      // A key an input method composes with is its own: it neither leaves the form nor closes Settings.
      if (isImeComposing(event)) { event.stopPropagation(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
    }}>
    {!phone && <button type="button" className="settings-history__back" onClick={onCancel}>
      <ChevronLeft size={15} aria-hidden="true" />{editing ? editing.skill.name : 'Skills'}</button>}
    <h1 className="terminal-settings-heading">{title}</h1>
    <p className="settings-history__detail-kind">{editing
      ? 'Other frontmatter keys in SKILL.md are kept as they are.'
      : `Saved to ${root ?? 'your library'}${machine ? ` on ${machine}` : ''}. Every runtime can use it.`}</p>
    <div className="settings-section"><div className="settings-section__body">
      {!editing && field('name', 'Name', 'Lowercase letters, digits and hyphens. You run it as /name.', (props) =>
        <input {...props} className="ui-input" maxLength={SKILL_NAME_MAX} autoFocus spellCheck={false} autoComplete="off" placeholder="release-notes" />)}
      {field('description', 'Description', 'When should an agent use it? Agents decide from this line.', (props) =>
        <textarea {...props} className="ui-input" rows={2} autoFocus={!!editing}
          placeholder="Writes release notes from the merged commits. Use when asked for a changelog." />)}
      {field('argumentHint', 'Argument hint', 'Optional. Shown after the name in the / menu.', (props) =>
        <input {...props} className="ui-input" spellCheck={false} autoComplete="off" placeholder="[since-tag]" />)}
      {field('body', 'Instructions', 'Markdown. $ARGUMENTS is what you type after the command.', (props) =>
        <textarea {...props} className="ui-input skills-mono" rows={12} spellCheck={false} />)}
    </div></div>
    {refused.length > 0 && <div className="settings-history__error" role="alert"><ul>{[...new Set(refused)].map((text) => <li key={text}>{text}</li>)}</ul></div>}
    <div className="settings-history__detail-actions">
      <Button type="submit" variant="primary">{saving ? (editing ? 'Saving…' : 'Creating…') : editing ? 'Save' : 'Create skill'}</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  </form>;
}
