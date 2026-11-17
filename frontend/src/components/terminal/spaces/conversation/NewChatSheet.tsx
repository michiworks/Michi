import React from 'react';
import { AnimatePresence } from 'motion/react';
import { BranchIcon, ChatIcon, ChevronDownIcon, CloseIcon, FolderIcon } from '../../icons';
import { useChatProjects } from '../../../../state/chatStore';
import { isSystemWorkspace } from '../../../../state/assistant/systemWorkspace';
import { backendConnectionIdForWorkspace } from '../../../../config/backendConnections';
import {
  closeNewChatSheet,
  requestSpaceConversation,
  setNewChatSheetWorkspace,
  type NewChatSheetState,
  type SpaceConversationScope,
} from '../../../../state/spaceConversations/store';
import { ActionMenu } from '../../../ui/ActionMenu';
import { Button } from '../../../ui/controls';
import { ComposerShell } from '../../ComposerShell';
import { escapeTakenBefore } from '../../../composerEscape';
import { isImeComposing } from '../../../../lib/ime';
import type { MentionEditorHandle } from '../../../MentionEditor';
import LazyMentionEditor from '../../../LazyMentionEditor';
import type { MentionRecord } from '../../../../lib/mentions';
import './conversation.css';

const NONE: never[] = [];

/**
 * The sheet "Start a task in [workspace]": one message starts an ordinary
 * conversation on the user's global settings; its progress shows on the page.
 */
export function NewChatSheet({ sheet, scope }: { sheet: NewChatSheetState; scope: SpaceConversationScope }) {
  const { projects, activeProjectId, agentStatus } = useChatProjects();
  const workspaces = React.useMemo(() => projects.filter((project) =>
    backendConnectionIdForWorkspace(project.id) === scope.backendConnectionId
    && !project.archivedAt && !project.deletedAt && !isSystemWorkspace(project)), [projects, scope.backendConnectionId]);
  const chosen = workspaces.find((workspace) => workspace.id === sheet.workspaceId)
    ?? workspaces.find((workspace) => workspace.id === activeProjectId)
    ?? workspaces[0]
    ?? null;
  const [draft, setDraft] = React.useState<{ value: string; mentions: MentionRecord[] }>({ value: sheet.text, mentions: [] });
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLButtonElement | null>(null);
  const editorRef = React.useRef<MentionEditorHandle>(null);
  const sectionRef = React.useRef<HTMLElement>(null);
  const seededSeq = React.useRef(sheet.seq);

  React.useEffect(() => {
    if (seededSeq.current === sheet.seq) return;
    seededSeq.current = sheet.seq;
    setDraft({ value: sheet.text, mentions: [] });
  }, [sheet.seq, sheet.text]);

  React.useEffect(() => {
    // A next step far down the page opens the sheet at the page's top.
    sectionRef.current?.scrollIntoView?.({ block: 'nearest' });
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      if (editorRef.current) { editorRef.current.focus(); return; }
      if (tries++ < 60) timer = window.setTimeout(attempt, 50);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [sheet.seq]);

  // Closing gives focus back to what opened the sheet, which stays (ST-10).
  const [opener] = React.useState(() => document.activeElement);
  const returnFocus = () => {
    if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus({ preventScroll: true });
  };
  const close = () => { returnFocus(); closeNewChatSheet(); };

  const text = draft.value.trim();
  const canStart = Boolean(chosen && text && scope.pageId);
  const start = () => {
    if (!chosen || !text || !scope.pageId) return;
    returnFocus();
    requestSpaceConversation({
      text,
      workspaceId: chosen.id,
      workspaceName: chosen.name,
      backendConnectionId: scope.backendConnectionId,
      startedFromPageId: scope.pageId,
    });
  };

  return (
    <section
      ref={sectionRef}
      className="space-new-chat"
      aria-label="Start a task"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || isImeComposing(event) || menuAnchor || escapeTakenBefore(event.nativeEvent)) return;
        event.preventDefault();
        close();
      }}
    >
      <ComposerShell
        position="static"
        preBlocks={(
          <div className="space-new-chat__head">
            <ChatIcon aria-hidden="true" />
            <b>Start a task</b>
            <span>in</span>
            <button
              type="button"
              className="space-new-chat__ws"
              aria-haspopup="menu"
              aria-expanded={Boolean(menuAnchor)}
              aria-label={`Workspace: ${chosen?.name ?? 'none'}`}
              disabled={workspaces.length === 0}
              onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}
            >
              <FolderIcon size="sm" aria-hidden="true" />
              <span>{chosen?.name ?? 'No workspace'}</span>
              <ChevronDownIcon size="sm" aria-hidden="true" />
            </button>
            <span className="space-new-chat__spacer" />
            <button type="button" className="t-icon-btn" aria-label="Close" title="Close (Esc)" onClick={close}>
              <CloseIcon aria-hidden="true" />
            </button>
          </div>
        )}
        input={(
          <LazyMentionEditor
            ref={editorRef}
            value={draft.value}
            mentions={draft.mentions}
            onChange={setDraft}
            className="hide-sb space-new-chat__input"
            data-testid="space-new-chat-input"
            artifacts={NONE}
            currentNodeId="__space_new_chat__"
            enableSlash={false}
            onSubmit={start}
          />
        )}
        toolbarLeft={(
          <span className="space-new-chat__runtime">
            <BranchIcon size="sm" aria-hidden="true" />
            {agentStatus?.label ?? 'Default runtime'} · your global settings
          </span>
        )}
        toolbarRight={(
          <>
            <span className="space-new-chat__hint">Follow progress here; the full chat and replies are on the chat page</span>
            <Button variant="primary" size="sm" disabled={!canStart} onClick={start}>Start</Button>
          </>
        )}
      />
      {workspaces.length === 0 && <p className="space-new-chat__error" role="alert">There is no workspace on this backend to start a chat in.</p>}
      <AnimatePresence>{menuAnchor && (
        <ActionMenu
          key="workspaces"
          anchor={menuAnchor}
          label="Start the chat in"
          onClose={() => setMenuAnchor(null)}
          items={workspaces.map((workspace) => ({
            id: workspace.id,
            label: workspace.name,
            icon: <FolderIcon size="sm" aria-hidden="true" />,
            onSelect: () => { setNewChatSheetWorkspace(workspace.id); editorRef.current?.focus(); },
          }))}
        />
      )}</AnimatePresence>
    </section>
  );
}
