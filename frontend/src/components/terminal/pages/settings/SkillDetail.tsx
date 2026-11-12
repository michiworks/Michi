import React, { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { BookOpen, Code, Copy, Eye, Pencil, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { parseSkillFile, withSkillFileName, type SkillDetail, type SkillSummary } from 'michi-shared';
import MarkdownContent from '../../../MarkdownContent';
import { UNTRUSTED_MARKDOWN } from '../../../markdownProse';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { ModalShell } from '../../../ui/ModalShell';
import { Button, Switch } from '../../../ui/controls';
import { deleteLibrarySkill, fetchSkillDetail, notifySkillsChanged, setBuiltinSkillEnabled, SkillsApiError, updateLibrarySkill } from '../../../../services/api/skills';
import { TrashIconButton } from '../TrashControls';
import { HistoryDetail } from './HistoryList';
import { SettingsRow } from './SettingsSection';
import { BUILTIN, errorText, LIBRARY, nameProblem, scopeLabel } from './skillsModel';
import { copyText } from '../../../../lib/clipboard';

/** Where the open skill lives: its backend and, for a runtime's skill, the workspace it was listed for. */
export interface SkillPlace {
  workspaceId?: string;
  backendConnectionId: string;
  /** The remote machine's name; null on this machine. */
  machine: string | null;
  /** The library's folder, when known. */
  root: string | null;
}

function enabledText(skill: SkillSummary): string {
  if (!skill.userInvocable && !skill.modelInvocable) return 'Agents don’t load it on their own, and it isn’t in the / menu.';
  if (!skill.userInvocable) return 'Agents on every runtime can load it. It isn’t in the / menu.';
  if (!skill.modelInvocable) return 'It’s in the / menu. Agents don’t load it on their own.';
  return 'Agents on every runtime can load it, and it’s in the / menu.';
}

/**
 * One skill, a level inside Settings › Skills: what it is, where it lives
 * and its instructions. A library skill is turned on or off, edited,
 * renamed and deleted here; a built-in one is only turned on or off; a
 * runtime's own skill is read only.
 */
export function SkillDetailLevel({ skill, place, runtimeLabel, revision, taken, onBack, onChanged, onRenamed, onDeleted, onEdit }: {
  skill: SkillSummary;
  place: SkillPlace;
  /** The label of the runtime that reported it. */
  runtimeLabel: string;
  /** Changes with each listing, so the file is read again. */
  revision: number;
  /** The library's names, for Rename. */
  taken: ReadonlySet<string>;
  onBack: () => void;
  onChanged: (skill: SkillSummary) => void;
  onRenamed: (skill: SkillSummary, previousId: string) => void;
  onDeleted: (skill: SkillSummary) => void;
  onEdit: (content: string) => void;
}) {
  const library = skill.origin === LIBRARY;
  const builtin = skill.origin === BUILTIN;
  // Built-in and library skills are switched here; a runtime's own are not.
  const switchable = library || builtin;
  const [file, setFile] = useState<{ detail: SkillDetail | null; error: string | null }>({ detail: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const busy = useRef(false);
  const instructionsId = useId();
  const { workspaceId, backendConnectionId, machine, root } = place;

  useEffect(() => {
    const controller = new AbortController();
    fetchSkillDetail(skill.id, { workspaceId, backendConnectionId, signal: controller.signal })
      .then((detail) => { if (!controller.signal.aborted) setFile({ detail, error: null }); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setFile((current) => ({ ...current, error: errorText(reason) })); });
    return () => controller.abort();
  }, [skill.id, workspaceId, backendConnectionId, revision, attempt]);

  const content = file.detail?.content;
  const fileName = library || builtin ? 'SKILL.md' : skill.path?.split(/[\\/]/).pop() || 'SKILL.md';
  const backend = { backendConnectionId };

  /** One write at a time; the controls stay where they are, so focus does too. */
  const write = async <T,>(what: string, action: () => Promise<T>, done: (value: T) => void) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      done(await action());
      notifySkillsChanged();
    } catch (reason) {
      setError(`Couldn’t ${what}: ${errorText(reason)}.`);
    } finally {
      busy.current = false;
    }
  };

  const remove = async () => {
    if (busy.current) return;
    const where = root ? ` from ${root}${machine ? ` on ${machine}` : ''}` : '';
    const confirmed = await confirmDialog({
      title: 'Delete skill?',
      message: skill.linkTarget
        ? `“${skill.name}” is a link to ${skill.linkTarget}. Only the link is removed; that folder stays.`
        : `“${skill.name}” and its folder will be deleted${where}. This can’t be undone.`,
      confirmLabel: 'Delete skill',
      danger: true,
    });
    if (confirmed) void write('delete the skill', () => deleteLibrarySkill(skill.name, backend), () => onDeleted(skill));
  };

  const copyPath = (path: string) => {
    void copyText(path).then((ok) => { if (ok) toast.success('Path copied'); else setError('Couldn’t copy the path.'); });
  };

  const command = skill.origin === 'runtime' ? skill.nativeName ?? skill.name : skill.name;
  const details = [
    {
      label: 'Command',
      value: skill.userInvocable
        ? <><code>/{command}</code>{skill.argumentHint && <> <span className="skills-hint">{skill.argumentHint}</span></>}</>
        : skill.modelInvocable ? 'None. Agents load it when a task fits.' : 'None.',
    },
    { label: 'Description', value: skill.description || 'No description.' },
    {
      label: 'Location',
      value: skill.path ? <>
        <span className="skills-location"><code>{skill.path}</code>
          <TrashIconButton icon={Copy} tooltip="Copy path" aria-label="Copy path" onClick={() => copyPath(skill.path!)} /></span>
        {machine && <span className="skills-sub">on {machine}</span>}
        {skill.linkTarget && <span className="skills-sub">Links to {skill.linkTarget}</span>}
      </> : builtin ? 'Ships with Michi' : 'Not reported',
    },
    ...(file.detail ? [{
      label: 'Files',
      value: <span className="skills-files">{[fileName, ...file.detail.files].map((name) => <code key={name}>{name}</code>)}</span>,
    }] : []),
  ];

  let instructions: React.ReactNode;
  if (content === undefined) {
    instructions = file.error
      ? <div className="skills-file-error" role="alert"><span>Couldn’t read {fileName}: {file.error}.</span>
        <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>Try again</Button></div>
      : <p className="settings-history__preview-empty" role="status">Loading {fileName}…</p>;
  } else if (source) {
    instructions = <pre className="skills-raw">{content}</pre>;
  } else {
    const body = parseSkillFile(content).body;
    instructions = body.trim()
      ? <div className="skills-rendered"><MarkdownContent text={body} size="sm" className="prose prose-sm max-w-none wrap-break-word" features={UNTRUSTED_MARKDOWN} /></div>
      : <p className="settings-history__preview-empty">No instructions after the frontmatter.</p>;
  }

  return <>
    <HistoryDetail backLabel="Skills" onBack={onBack} icon={BookOpen} title={skill.name} details={details} pageTitle
      kind={switchable ? `${library ? 'Library' : 'Built-in'} skill${skill.enabled ? '' : ' · Off'}` : [runtimeLabel, scopeLabel(skill)].filter(Boolean).join(' · ')}
      readOnly={!library}
      lead={<>
        {error && <div className="settings-history__error" role="alert"><span>{error}</span>
          <TrashIconButton icon={X} tooltip="Dismiss error" aria-label="Dismiss error" onClick={() => setError(null)} /></div>}
        {switchable && <div className="settings-section skills-enabled"><div className="settings-section__body">
          <SettingsRow label="Enabled" description={enabledText(skill)}
            control={<Switch on={skill.enabled} aria-label="Enabled"
              onChange={(enabled) => void write(enabled ? 'turn it on' : 'turn it off', () => builtin
                ? setBuiltinSkillEnabled(skill.name, enabled, backend)
                : updateLibrarySkill(skill.name, { enabled }, backend), (saved) => {
                onChanged(saved);
                toast.success(saved.enabled ? `${saved.name} is on` : `${saved.name} is off${saved.userInvocable ? ' · it’s out of the / menu' : ''}`);
              })} />} />
        </div></div>}
      </>}
      actions={library ? <>
        <Button variant="primary" disabled={content === undefined} onClick={() => { if (content !== undefined) onEdit(content); }}><Pencil size={14} aria-hidden="true" />Edit</Button>
        <Button disabled={content === undefined} onClick={() => setRenaming(true)}>Rename…</Button>
        <Button danger onClick={() => { void remove(); }}><Trash2 size={14} aria-hidden="true" />Delete…</Button>
      </> : undefined}>
      <section className="settings-section skills-instructions" aria-labelledby={instructionsId}>
        <div className="settings-section__head">
          <h3 id={instructionsId} className="settings-section__title">Instructions</h3>
          {content !== undefined && <Button size="sm" variant="ghost" onClick={() => setSource((value) => !value)}>
            {source ? <Eye size={13} aria-hidden="true" /> : <Code size={13} aria-hidden="true" />}{source ? 'Rendered' : 'View source'}
          </Button>}
        </div>
        <div className="settings-section__body">{instructions}</div>
      </section>
    </HistoryDetail>
    <AnimatePresence>{renaming && content !== undefined && <RenameDialog key="rename" skill={skill} content={content} taken={taken} place={place}
      onClose={() => setRenaming(false)}
      onRenamed={(saved) => { setRenaming(false); onRenamed(saved, skill.id); notifySkillsChanged(); }} />}</AnimatePresence>
  </>;
}

function RenameDialog({ skill, content, taken, place, onClose, onRenamed }: {
  skill: SkillSummary;
  content: string;
  taken: ReadonlySet<string>;
  place: SkillPlace;
  onClose: () => void;
  onRenamed: (skill: SkillSummary) => void;
}) {
  const [value, setValue] = useState(skill.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const others = new Set([...taken].filter((name) => name !== skill.name));
  const folder = place.root ? ` in ${place.root}` : '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const name = value.trim();
    if (name === skill.name) { onClose(); return; }
    const invalid = nameProblem(name, others);
    if (invalid) { setProblem(invalid); return; }
    setBusy(true);
    try {
      onRenamed(await updateLibrarySkill(skill.name, { newName: name, content: withSkillFileName(content, name) }, { backendConnectionId: place.backendConnectionId }));
    } catch (reason) {
      setProblem(reason instanceof SkillsApiError && reason.code === 'name_taken'
        ? `A skill named ${name} is already in your library.`
        : `Couldn’t rename the skill: ${errorText(reason)}.`);
      setBusy(false);
    }
  };

  return <ModalShell open onClose={onClose} title="Rename skill" width={420} dismissible={!busy} captureEscape>
    <form className="skills-dialog" noValidate onSubmit={(event) => void submit(event)}>
      <p id={hintId}>You’ll run it as /new-name. Its folder{folder} is renamed too.</p>
      <input className="ui-input" aria-label="New name" aria-describedby={hintId} value={value} autoFocus spellCheck={false} autoComplete="off"
        aria-invalid={!!problem} onFocus={(event) => event.target.select()}
        onChange={(event) => { setValue(event.target.value); setProblem(null); }} />
      {problem && <p className="skills-field__error" role="alert">{problem}</p>}
      <footer>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary">{busy ? 'Renaming…' : 'Rename'}</Button>
      </footer>
    </form>
  </ModalShell>;
}
