import { usePermissionPreferences } from '../../../hooks/usePermissionPreferences';
import { ComposerPermissionControl } from '../ComposerPermissionControl';
import { approveForMeRuntimeIds, chatPermissionChoiceForRuntime } from '../../../lib/chatPermissionModes';
import { chatPermissionChoiceParts } from 'michi-shared';
import React, { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, useStructuralSelector, shallowArrayEqual } from '../../../state/chatStore';
import { appendComposerLine } from '../../../state/composerDraft';
import { receiveHomeDraft } from '../../../state/homeDraft';
import { resetTemporaryChatDraft } from '../../../state/temporaryChatDraft';
import type { MentionEditorHandle } from '../../MentionEditor';
import LazyMentionEditor from '../../LazyMentionEditor';
import type { MentionRecord } from '../../../lib/mentions';
import { expandMentions } from '../../../lib/mentions';
import { draftToDoc } from '../../mentionDoc';
import { collectCrossTreeGroups, EMPTY_CROSS_TREE_GROUPS } from '../../crossTreeMentions';
import { getElectron } from '../../../lib/electronBridge';
import {
  copyWorkspaceFile,
  saveAgentOptions,
  bindPendingPrimaryAgent,
  fetchAgentStatusAfterFirstPaint,
  listPrimaryAgentDefinitions,
  type PrimaryAgentDefinitionOption,
  type AgentReasoning,
} from '../../../services/api';
import { useRuntimeCatalog } from '../../../hooks/useRuntimeCatalog';
import { resolveNodeBinding } from '../../../state/nodeBindingResolution';
import { appendAttachmentsSentinel } from '../../../lib/composerAttachments';
import { toast } from 'sonner';
import { ComposerShell } from '../ComposerShell';
import './ManageComposer.css';
import { PaneComposerToolbarLeft, type PaneMenuAnchor } from '../PaneComposerToolbarLeft';
import { ComposerModelTrigger } from '../ComposerModelTrigger';
import { resolveComposerReasoning } from '../composerReasoning';
import { PaneAgentMenus } from '../PaneAgentMenus';
import { PaneComposerActions } from '../PaneComposerActions';
import {
  activeBackendApiBase,
  backendConnectionIdForWorkspace,
  LOCAL_BACKEND_CONNECTION_ID,
  workspaceBackendApiBase,
} from '../../../config/backendConnections';
import {
  clearComposerAgentSelections,
  readComposerModeSelection,
  readComposerPrimaryAgentSelection,
  writeComposerModeSelection,
  writeComposerPrimaryAgentSelection,
} from './composerAgentSelection';
import UploadProgressBar from '../../UploadProgressBar';
import { PendingAttachmentRow, type PanePendingAttachment } from '../PaneComposerPreBlocks';
import { useComposerAttachments } from '../useComposerAttachments';
import { isFileDrag, useFileDropZone } from '../useFileDropZone';
import { focusIsTaken } from '../escapeLayers';

type ComposerDraft = { value: string; mentions: MentionRecord[] };

// In-memory draft survives unmount within a session, but successful sends
// reset it. Cleared on full reload.
const composerDrafts = new Map<string, ComposerDraft>();
const draftPermissionModes = new Map<string, import('michi-shared').ChatPermissionChoice>();
// Pre-picked agent, sticky across unmounts and app restarts. The session
// copy keeps the pick while agent status is still loading; once the runtime
// is known the pick is also stored per Backend + runtime (see
// composerAgentSelection.ts) so the next launch starts from it. A stale id is
// dropped at render time once the mode list is known.
type StickyModePick = { backendConnectionId: string; runtimeId: string | undefined; modeId: string | undefined };
let manageStickyModePick: StickyModePick | undefined;
const manageStickyPrimaryAgent = new Map<string, PrimaryAgentDefinitionOption>();
// The Home thread's Ultracode choice until it is sent; like the draft, it
// survives unmount within a session and a send resets it.
let homeDraftUltracode = false;

/** @testonly */
export function __resetManageComposerSessionStateForTests(options: { keepPersisted?: boolean } = {}) {
  composerDrafts.clear();
  draftPermissionModes.clear();
  homeDraftUltracode = false;
  manageStickyModePick = undefined;
  manageStickyPrimaryAgent.clear();
  if (!options.keepPersisted) clearComposerAgentSelections();
}

/**
 * Mode pick for this Backend/runtime: the session copy when it applies
 * (including one made before the runtime was known), else the stored pick.
 */
function stickyModeFor(backendConnectionId: string, runtimeId: string | undefined): string | undefined {
  const session = manageStickyModePick;
  if (session && session.backendConnectionId === backendConnectionId
    && (session.runtimeId === undefined || session.runtimeId === runtimeId)) {
    return session.modeId;
  }
  return readComposerModeSelection(backendConnectionId, runtimeId);
}

function rememberModePick(backendConnectionId: string, runtimeId: string | undefined, modeId: string | undefined) {
  manageStickyModePick = { backendConnectionId, runtimeId, modeId };
  writeComposerModeSelection(backendConnectionId, runtimeId, modeId);
}

interface Props {
  /** Create a follow-up from this digest instead of a new root thread. */
  parentNodeId?: string;
  /** Fixed workspace target. Omit on Home where the user picks via the chip. */
  workspaceId?: string;
  /** Display name for fixed-workspace mode. Falls back to active project name. */
  workspaceName?: string;
  /**
   * Extra toolbar content rendered before the standard left toolbar (e.g.
   * workspace picker chip). Below `trayBelow` it leads the tray instead.
   */
  toolbarLeftPrefix?: React.ReactNode;
  /**
   * Toolbar width (border box, px) below which the toolbar keeps one row and
   * `toolbarLeftPrefix` and the permission chip move to a tray under the
   * composer. Without it they always stay in the toolbar.
   */
  trayBelow?: number;
  /**
   * Show the agent (⎇) chip so the user can pre-pick an agent before the
   * thread exists. The pick is applied to the new thread's session on send.
   * Off by default — entry points that create a conversation on submit
   * (Home or digest follow-ups) can enable it.
   */
  enableAgentSelect?: boolean;
  /**
   * Toolbar widths (border box, px) below which the toolbar compacts the way
   * a pane composer's does: the agent, permission and model chips drop their
   * text (the model chip keeps its name and drops the effort), then the agent
   * chip is hidden. They depend on the caller's chip scale and extra chips,
   * so there is no default; without them the toolbar never compacts.
   */
  toolbarCompaction?: { glyphsBelow: number; hideAgentBelow: number };
  /**
   * Home's temporary-chat switch is on: the new thread starts as a temporary
   * chat (memory off), its composer is dashed, and the send turns the switch
   * off. Ignored for a digest follow-up.
   */
  temporary?: boolean;
  onSubmitted: () => void;
}

/** Puts text in the composer for the user to edit and send; nothing here sends. */
export interface ManageComposerHandle {
  /**
   * Adds `text` to the draft: alone in an empty composer, otherwise on a new
   * line after what is there. Focuses the composer with the caret at the end.
   */
  insert: (text: string) => void;
  /** Types `@` at the end of the draft, which opens the mention picker. */
  startMention: () => void;
}

type ToolbarTier = 0 | 1 | 2;
interface ToolbarLayout { tier: ToolbarTier; tray: boolean }
const FULL_TOOLBAR: ToolbarLayout = { tier: 0, tray: false };

/** Pick the toolbar tier, and whether the tray is used, from the toolbar's
 *  measured width, following it as the window (or the page zoom) changes.
 *  Moving chips into the tray leaves the toolbar's width unchanged. Measured
 *  before paint, so a phone never shows the full toolbar first. */
function useToolbarLayout(
  toolbarRef: React.RefObject<HTMLDivElement | null>,
  compaction: Props['toolbarCompaction'],
  trayBelow: number | undefined,
): ToolbarLayout {
  const [layout, setLayout] = useState<ToolbarLayout>(FULL_TOOLBAR);
  const glyphsBelow = compaction?.glyphsBelow;
  const hideAgentBelow = compaction?.hideAgentBelow;
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if ((glyphsBelow === undefined || hideAgentBelow === undefined) && trayBelow === undefined) {
      setLayout(FULL_TOOLBAR);
      return;
    }
    if (!el || typeof ResizeObserver === 'undefined') return;
    const apply = (width: number) => {
      const tier: ToolbarTier = glyphsBelow === undefined || hideAgentBelow === undefined ? 0
        : width < hideAgentBelow ? 2 : width < glyphsBelow ? 1 : 0;
      const tray = trayBelow !== undefined && width < trayBelow;
      setLayout((prev) => (prev.tier === tier && prev.tray === tray ? prev : { tier, tray }));
    };
    apply(el.offsetWidth);
    const observer = new ResizeObserver((entries) => {
      apply(entries[0]?.borderBoxSize?.[0]?.inlineSize ?? el.offsetWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [toolbarRef, glyphsBelow, hideAgentBelow, trayBelow]);
  return layout;
}

const ManageComposer = React.forwardRef<ManageComposerHandle, Props>(function ManageComposer(props, ref) {
  const scope = props.parentNodeId ? `${props.workspaceId ?? ''}:${props.parentNodeId}` : '__manage__';
  return <ScopedManageComposer key={scope} {...props} handleRef={ref} />;
});
export default ManageComposer;

function ScopedManageComposer({
  parentNodeId,
  workspaceId: fixedWorkspaceId,
  toolbarLeftPrefix,
  trayBelow,
  enableAgentSelect = false,
  toolbarCompaction,
  temporary: temporaryProp = false,
  onSubmitted,
  handleRef,
}: Props & { handleRef: React.ForwardedRef<ManageComposerHandle> }) {
  const temporary = temporaryProp && !parentNodeId;
  const toolbarRef = useRef<HTMLDivElement>(null);
  const { tier: toolbarTier, tray } = useToolbarLayout(toolbarRef, toolbarCompaction, trayBelow);
  const {
    activeProject,
    selectProject,
    createThread,
    createChildChat,
    sendMessage,
    setChatUltracode,
    agentStatus,
    refreshAgentStatus,
    availableModes,
    defaultModeId,
    agentModesLoading,
    agentModesError,
    retryAgentModes,
    projects,
  } = useChatStore();

  const workspaceId = fixedWorkspaceId ?? activeProject?.id ?? '';
  const permissionPreferences = usePermissionPreferences(workspaceBackendApiBase(workspaceId));
  const project = projects.find((p) => p.id === workspaceId);
  const usesActiveBackend = workspaceBackendApiBase(workspaceId) === activeBackendApiBase();
  const customAgentsEnabled = agentStatus?.customAgentsEnabled === true;

  const draftKey = parentNodeId ? `${workspaceId}:${parentNodeId}` : '__manage__';
  const [draft, setDraftState] = useState<ComposerDraft>(
    () => composerDrafts.get(draftKey) ?? { value: '', mentions: [] },
  );
  const draftRef = useRef<ComposerDraft>(draft);
  const setDraft = useCallback(
    (nextOrUpdater: ComposerDraft | ((prev: ComposerDraft) => ComposerDraft)) => {
      const next = typeof nextOrUpdater === 'function'
        ? (nextOrUpdater as (prev: ComposerDraft) => ComposerDraft)(draftRef.current)
        : nextOrUpdater;
      draftRef.current = next;
      composerDrafts.set(draftKey, next);
      setDraftState(next);
    },
    [draftKey],
  );
  const inputRef = useRef<MentionEditorHandle>(null);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  const [agentMenu, setAgentMenu] = useState<PaneMenuAnchor | null>(null);
  const [modelMenu, setModelMenu] = useState<PaneMenuAnchor | null>(null);
  const permissionDraftKey = `${workspaceId}:${parentNodeId ?? '__new__'}`;
  const [, setPermissionModeRevision] = useState(0);
  const permissionMode = draftPermissionModes.get(permissionDraftKey) ?? 'ask';
  const setPermissionMode = (mode: import('michi-shared').ChatPermissionChoice) => {
    draftPermissionModes.set(permissionDraftKey, mode);
    setPermissionModeRevision((revision) => revision + 1);
  };
  // Pre-session agent pick. Only meaningful when enableAgentSelect is on; the
  // chosen mode is stamped onto the new thread in submit() and applied to its
  // session at ensure-session time so the first message runs under it. Mode
  // ids belong to the catalog of the active Backend's runtime (the same
  // source as availableModes), so the pick is remembered per Backend + runtime.
  const modeBackendConnectionId = activeProject?.backendConnectionId || LOCAL_BACKEND_CONNECTION_ID;
  const modeRuntimeId = agentStatus?.runtime;
  const [, setModePickRevision] = useState(0);
  const pendingModeId = stickyModeFor(modeBackendConnectionId, modeRuntimeId);
  const setPendingModeId = useCallback((id: string | undefined) => {
    rememberModePick(modeBackendConnectionId, modeRuntimeId, id);
    setModePickRevision((revision) => revision + 1);
  }, [modeBackendConnectionId, modeRuntimeId]);
  const [primaryAgents, setPrimaryAgents] = useState<PrimaryAgentDefinitionOption[]>([]);
  const [primaryAgentsLoading, setPrimaryAgentsLoading] = useState(false);
  const [primaryAgentsError, setPrimaryAgentsError] = useState<string | null>(null);
  const [pendingPrimaryAgent, setPendingPrimaryAgentState] = useState<PrimaryAgentDefinitionOption | undefined>(
    () => workspaceId ? manageStickyPrimaryAgent.get(workspaceId) : undefined,
  );
  const setPendingPrimaryAgent = useCallback((agent: PrimaryAgentDefinitionOption | undefined) => {
    if (workspaceId) {
      if (agent) manageStickyPrimaryAgent.set(workspaceId, agent);
      else manageStickyPrimaryAgent.delete(workspaceId);
      writeComposerPrimaryAgentSelection(workspaceId, agent
        ? { backendConnectionId: agent.backendConnectionId, definitionId: agent.definition.id }
        : undefined);
    }
    setPendingPrimaryAgentState(agent);
  }, [workspaceId]);
  // Ultracode is the new chat's, which Home does not have yet: the switch
  // holds the choice and submit() saves it to the chat before its first
  // message. Only an ordinary Home thread runs it, not a custom agent; the
  // picker offers it only where the runtime has it (capabilities.ultracode).
  const [ultracodeDraft, setUltracodeDraftState] = useState(() => homeDraftUltracode);
  const setUltracodeDraft = (enabled: boolean) => {
    homeDraftUltracode = enabled;
    setUltracodeDraftState(enabled);
  };
  const ultracode = !parentNodeId && !pendingPrimaryAgent ? { enabled: ultracodeDraft } : undefined;

  useEffect(() => {
    setPendingPrimaryAgentState(workspaceId ? manageStickyPrimaryAgent.get(workspaceId) : undefined);
    if (!enableAgentSelect || !workspaceId || (usesActiveBackend && !customAgentsEnabled)) {
      setPrimaryAgents([]);
      setPrimaryAgentsLoading(false);
      setPrimaryAgentsError(null);
      return;
    }
    const controller = new AbortController();
    setPrimaryAgentsLoading(true);
    setPrimaryAgentsError(null);
    const load = async () => {
      if (!usesActiveBackend) {
        const status = await fetchAgentStatusAfterFirstPaint(backendConnectionIdForWorkspace(workspaceId), controller.signal);
        if (!status.customAgentsEnabled) return [];
      }
      return listPrimaryAgentDefinitions(workspaceId, controller.signal);
    };
    void load()
      .then((definitions) => {
        if (controller.signal.aborted) return;
        setPrimaryAgents(definitions);
        // The session copy wins; after a restart only the stored ids remain,
        // and they are restored only if that Definition is listed again.
        const sticky = manageStickyPrimaryAgent.get(workspaceId);
        const wanted = sticky
          ? { backendConnectionId: sticky.backendConnectionId, definitionId: sticky.definition.id }
          : readComposerPrimaryAgentSelection(workspaceId);
        if (!wanted) return;
        const match = definitions.find((candidate) =>
          candidate.definition.id === wanted.definitionId && candidate.backendConnectionId === wanted.backendConnectionId);
        if (match) {
          manageStickyPrimaryAgent.set(workspaceId, match);
          setPendingPrimaryAgentState(match);
        } else {
          manageStickyPrimaryAgent.delete(workspaceId);
          writeComposerPrimaryAgentSelection(workspaceId, undefined);
          setPendingPrimaryAgentState(undefined);
        }
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') setPrimaryAgentsError((error as Error).message);
      })
      .finally(() => { if (!controller.signal.aborted) setPrimaryAgentsLoading(false); });
    return () => controller.abort();
  }, [enableAgentSelect, workspaceId, usesActiveBackend, customAgentsEnabled]);
  const shouldLoadModels = (!!modelMenu || agentStatus?.runtime === 'claude') && !!(
    agentStatus?.capabilities.providerModels || agentStatus?.capabilities.models === true
  );
  const {
    models: providerModels,
    loading: modelsLoading,
    error: modelsError,
    retry: retryModels,
  } = useRuntimeCatalog({
    enabled: shouldLoadModels,
    connectionId: backendConnectionIdForWorkspace(workspaceId),
    runtime: agentStatus?.runtime,
    provider: agentStatus?.provider,
  });

  // ManageComposer creates new threads — use global agentStatus as the binding
  // (no node exists yet). resolveNodeBinding(null, agentStatus) returns source: 'global'.
  const manageResolvedBinding = resolveNodeBinding(null, agentStatus);
  // Provider, model and effort picks are the global defaults of the runtime
  // this picker shows. The backend refuses them if its active runtime has
  // changed since; reload status either way so the picker shows what is saved.
  const saveHomeDefault = async (patch: { provider?: string; model?: string; reasoning?: AgentReasoning }) => {
    const result = await saveAgentOptions({ ...patch, expectedRuntime: agentStatus?.runtime });
    refreshAgentStatus();
    if (!result.ok) throw new Error(result.error);
  };
  const permissionRuntime = pendingPrimaryAgent?.definition.runtimeProfile.runtimeId ?? manageResolvedBinding.runtime;
  const approveRuntimeIds = approveForMeRuntimeIds(agentStatus);
  const effectivePermissionMode = chatPermissionChoiceForRuntime(permissionMode, permissionRuntime, approveRuntimeIds.includes(permissionRuntime));
  const composerEffort = resolveComposerReasoning(manageResolvedBinding, agentStatus, null, providerModels, agentStatus?.providers);

  const {
    pending: pendingAttachments,
    setPending: setPendingAttachments,
    removePending: removePendingAttachment,
    uploadProgress,
    attachFiles,
    handlePaste,
    pickFiles: onPickFile,
    resolveCwd: resolveAttachCwd,
  } = useComposerAttachments(project);
  // Stops propagation so WorkspaceManage's own drop zone (artifact import)
  // does not also take a file dropped on this composer.
  const {
    visible: dragHover,
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    endDrag,
  } = useFileDropZone({ stopPropagation: true });

  useEffect(() => {
    if (focusIsTaken(toolbarRef.current)) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const insertMentionTrigger = useCallback(() => inputRef.current?.startMention(), []);

  const insert = useCallback((text: string) => {
    const editor = inputRef.current?.editor;
    const live = editor && !editor.isDestroyed ? editor : null;
    if (text.trim()) {
      const next = appendComposerLine(draftRef.current, text);
      // Through the editor, so its change path updates the draft and the
      // caret can be placed after the new text at once.
      if (live) live.commands.setContent(draftToDoc(next.value, next.mentions));
      else setDraft(next);
    }
    if (live) live.commands.focus('end');
    else inputRef.current?.focus();
  }, [setDraft]);

  useImperativeHandle(handleRef, () => ({
    insert,
    startMention: () => inputRef.current?.startMention('end'),
  }), [insert]);

  // The new-thread composer also takes words sent from elsewhere (the
  // palette's "New thread: …"), as a card's prompt arrives.
  useEffect(() => (draftKey === '__manage__' ? receiveHomeDraft(insert) : undefined), [draftKey, insert]);

  const openModelMenu = useCallback(
    (anchor: PaneMenuAnchor) => {
      setAgentMenu(null);
      setModelMenu((current) => current ? null : anchor);
    },
    [],
  );
  // Same toggle contract as the model trigger: a second press closes.
  const openAgentMenu = useCallback(
    (anchor: PaneMenuAnchor) => {
      setModelMenu(null);
      setAgentMenu((current) => current ? null : anchor);
    },
    [],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      await attachFiles(Array.from(e.dataTransfer.files));
    },
    [attachFiles, endDrag],
  );

  // This composer outlives a workspace switch, so an attachment can still sit
  // in the workspace it was added in. Copy it into the workspace the thread
  // starts in: its agent reads it there, and its thumbnail is served from there.
  const isFromOtherWorkspace = (p: PanePendingAttachment) => !!p.workspaceId && p.workspaceId !== workspaceId;
  const copyAttachmentsHere = async (items: PanePendingAttachment[]): Promise<PanePendingAttachment[] | null> => {
    try {
      const cwd = await resolveAttachCwd();
      if (!cwd) throw new Error('No workspace folder');
      const copied = await Promise.all(items.map(async (p) => {
        if (!isFromOtherWorkspace(p)) return p;
        const result = await copyWorkspaceFile(workspaceId, cwd, p.absPath, { subdir: '.attachments' });
        const absPath = result.filePath.startsWith('/')
          ? result.filePath
          : `${cwd.replace(/\/$/, '')}/${result.filePath}`;
        return { ...p, absPath, relPath: result.filePath, workspaceId };
      }));
      // A failed send then retries with the copies.
      setPendingAttachments((current) => current.map((p) => copied.find((c) => c.id === p.id) ?? p));
      return copied;
    } catch (error) {
      toast.error(`Could not copy attachments into ${project?.name ?? 'this workspace'}`, {
        description: `${(error as Error).message}. Remove them and attach them again.`,
      });
      return null;
    }
  };

  const submit = async () => {
    if (submittingRef.current || uploadProgress) return;
    const submitDraft = draftRef.current;
    const raw = expandMentions(submitDraft.value, submitDraft.mentions).trim();
    if (!raw && pendingAttachments.length === 0) return;
    if (!workspaceId) return;

    submittingRef.current = true;
    setSubmitting(true);
    const attachments = pendingAttachments.some(isFromOtherWorkspace)
      ? await copyAttachmentsHere(pendingAttachments)
      : pendingAttachments;
    if (!attachments) {
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }

    selectProject(workspaceId);
    const attachmentsForSend = attachments.map((p) => ({
      name: p.name,
      absPath: p.absPath,
      relPath: p.relPath,
    }));
    // Attachments stay scoped to the thread we're about to create (the agent
    // reads them via the [Attached files: …] sentinel). We intentionally do
    // NOT promote them to workspace artifacts: that registered each upload as a
    // workspace-level context row which the first-turn manifest then advertised
    // to every other conversation, so sibling threads kept reading unrelated
    // screenshots.

    const finalText = appendAttachmentsSentinel(raw, attachmentsForSend);
    const mentionsForMeta = submitDraft.mentions.length > 0
      ? submitDraft.mentions.map(m => ({ kind: m.kind, refId: m.refId, label: m.label }))
      : undefined;
    // A digest follow-up has a parent session. Make the visible selection
    // explicit so that session's runtime/model cannot override the chips.
    const bindingMeta = parentNodeId && !pendingPrimaryAgent && agentStatus ? {
      runtimeId: manageResolvedBinding.runtime,
      providerId: manageResolvedBinding.provider,
      modelId: manageResolvedBinding.model,
      reasoning: composerEffort.value ?? null,
    } : undefined;
    const meta =
      attachmentsForSend.length > 0 || mentionsForMeta || bindingMeta
        ? {
            ...bindingMeta,
            ...(attachmentsForSend.length > 0 ? { attachments: attachmentsForSend.map((a) => ({ ...a })) } : {}),
            displayText: raw,
            mentions: mentionsForMeta,
          }
        : undefined;
    try {
      const permissionParts = chatPermissionChoiceParts(effectivePermissionMode);
      const overrides = permissionPreferences.global || effectivePermissionMode === 'ask' ? {}
        : { permissionMode: permissionParts.mode, ...(permissionParts.approveForMe ? { approveForMe: true } : {}) };
      const permissionMeta = Object.keys(overrides).length ? { ...meta, ...overrides } : meta;
      const modeId = pendingPrimaryAgent ? undefined : currentModeId;
      const primaryAgent = pendingPrimaryAgent ? {
        backendConnectionId: pendingPrimaryAgent.backendConnectionId,
        definitionId: pendingPrimaryAgent.definition.id,
      } : undefined;
      if (parentNodeId) {
        await createChildChat(parentNodeId, finalText, permissionMeta, { modeId, primaryAgent });
      } else {
        // A temporary chat is marked at once, so the pane opens with its marks.
        const nodeId = await (temporary ? createThread(modeId, { temporary: true }) : createThread(modeId));
        if (!nodeId) return;
        if (primaryAgent) {
          bindPendingPrimaryAgent(nodeId, { workspaceId, ...primaryAgent });
        }
        // Saved before the first message, whose spawn reads it. Not sent
        // when the runtime changed since the switch was turned on.
        if (ultracode?.enabled && agentStatus?.capabilities.ultracode === true) {
          try {
            await setChatUltracode(nodeId, true);
          } catch (error) {
            toast.error('Could not turn on Ultracode', {
              description: `${(error as Error).message}. The chat starts without it; its model picker can turn it on.`,
            });
          }
        }
        // Its first session is created as a temporary chat (ensure-session).
        sendMessage(nodeId, finalText, temporary ? { ...permissionMeta, temporary: true } : permissionMeta);
      }
      setDraft({ value: '', mentions: [] });
      setPermissionMode('ask');
      // The switch was for this chat only.
      if (temporary) resetTemporaryChatDraft();
      setUltracodeDraft(false);
      setPendingAttachments([]);
      onSubmitted();
    } catch (error) {
      toast.error(parentNodeId ? 'Could not start digest follow-up' : 'Could not start thread', {
        description: (error as Error).message,
      });
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  // No active thread here. When agent pre-selection is enabled, the chip
  // reflects the user's pending pick (applied to the new thread on send);
  // otherwise it stays unset so the chip reads "agent" rather than asserting
  // a selection that has no target. A sticky pick that no longer exists in the
  // loaded mode list is dropped so the chip never shows a dangling raw id.
  const selectedModeId = enableAgentSelect ? pendingModeId : undefined;
  const currentModeId =
    selectedModeId && availableModes.length > 0 && !availableModes.some((m) => m.id === selectedModeId)
      ? undefined
      : selectedModeId;
  const currentMode = currentModeId
    ? availableModes.find((m) => m.id === currentModeId)
    : undefined;
  const defaultMode = defaultModeId
    ? availableModes.find((mode) => mode.id === defaultModeId)
    : undefined;
  const selectedAgentLabel = pendingPrimaryAgent?.definition.name;
  const displayedMode = selectedAgentLabel
    ? { id: pendingPrimaryAgent!.definition.id, name: selectedAgentLabel }
    : currentMode ?? defaultMode;
  const displayedModeId = selectedAgentLabel
    ? pendingPrimaryAgent!.definition.id
    : currentModeId ?? defaultMode?.id;

  const canAttach = !!getElectron()?.chooseFiles || !!project;
  const sendDisabled =
    (!draft.value.trim() && pendingAttachments.length === 0) || !workspaceId || submitting || !!uploadProgress;

  // Same-tree mentions don't apply on the manage page (no active thread).
  // Pass the project's artifacts so @<contextName> still works.
  const artifacts = useMemo(() => project?.artifacts ?? [], [project?.artifacts]);

  // Every conversation in the target workspace is @-mentionable from here.
  // There is no "current thread" on Home or for a digest follow-up root, so
  // nothing is excluded and all nodes flow through the cross-tree path
  // (grouped by thread, most recently active thread first).
  const crossTreeNodes = useStructuralSelector(useCallback((nodesMap) => {
    if (!project) return EMPTY_CROSS_TREE_GROUPS;
    return collectCrossTreeGroups(nodesMap, project, null);
  }, [project]), shallowArrayEqual);

  // The tray names the chip in full; the toolbar shortens it as it narrows.
  const permissionControl = permissionPreferences.global ? null : (
    <ComposerPermissionControl apiBase={workspaceBackendApiBase(workspaceId)} mode={permissionMode}
      runtimeIds={[permissionRuntime]} approveForMeRuntimeIds={approveRuntimeIds} compact={!tray && toolbarTier > 0}
      disabled={submitting || permissionPreferences.loading} onChange={setPermissionMode} />
  );
  const showTray = tray && (!!toolbarLeftPrefix || !!permissionControl);

  return (
    <div style={{ marginBottom: parentNodeId ? 0 : 18, flexShrink: 0, minWidth: 0 }} data-composer-tray={showTray || undefined}
      data-temporary-chat={temporary || undefined}>
      <ComposerShell
        position="static"
        toolbarRef={toolbarRef}
        dragHover={dragHover}
        // Never collapses on a phone: a new thread's workspace, permission and
        // model are chosen here, so they stay in view.
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => { void handleDrop(e); }}
        preBlocks={
          <>
            <UploadProgressBar progress={uploadProgress} />
            <PendingAttachmentRow items={pendingAttachments} workspaceId={workspaceId} onRemove={removePendingAttachment} />
          </>
        }
        input={
          <LazyMentionEditor
            ref={inputRef}
            value={draft.value}
            mentions={draft.mentions}
            onChange={setDraft}
            disabled={submitting}
            placeholder={temporary ? 'Ask in a temporary chat' : 'What would you like to explore?'}
            className="hide-sb"
            artifacts={artifacts}
            sameTreeNodes={[]}
            crossTreeNodes={crossTreeNodes}
            currentNodeId={parentNodeId ?? '__manage__'}
            enableSlash={false}
            onSubmit={() => submit()}
            onPaste={(e) => { void handlePaste(e as unknown as React.ClipboardEvent<HTMLTextAreaElement>); }}
          />
        }
        toolbarLeft={<div className="manage-composer-toolbar-left">
          {!showTray && toolbarLeftPrefix}
          <PaneComposerToolbarLeft
            canAttach={canAttach}
            toolbarTier={toolbarTier}
            enableAgentChip={enableAgentSelect}
            currentMode={displayedMode}
            currentModeId={displayedModeId}
            availableModesCount={enableAgentSelect ? availableModes.length + primaryAgents.length + 1 : 0}
            agentStatus={agentStatus}
            onPickFile={() => void onPickFile()}
            onInsertMentionTrigger={insertMentionTrigger}
            onOpenAgentMenu={openAgentMenu}
            agentMenuOpen={!!agentMenu}
          />
        </div>}
        toolbarRight={
          <>
          {!showTray && permissionControl}
          <ComposerModelTrigger
            toolbarTier={toolbarTier}
            agentStatus={agentStatus}
            resolvedBinding={manageResolvedBinding}
            catalogCapabilities={null}
            providerModels={providerModels}
            providers={agentStatus?.providers}
            isStreaming={submitting}
            modelMenuOpen={!!modelMenu}
            onOpenModelMenu={openModelMenu}
            ultracode={ultracode}
          />
          <PaneComposerActions
            draftHasText={false}
            sendMode="send"
            streaming={false}
            sendDisabled={sendDisabled}
            onBranch={() => { /* manage page has no thread to branch from */ }}
            onSend={submit}
            onStop={() => { /* never reached: streaming=false */ }}
            onRetry={() => { /* never reached: sendMode='send' */ }}
          />
          </>
        }
      />
      {showTray && (
        // Where the new thread starts and what it may do, set once before
        // sending; the toolbar above keeps what can change per message.
        <div className="composer-tray">
          <div className="composer-tray__start">{toolbarLeftPrefix}</div>
          {permissionControl && <div className="composer-tray__end">{permissionControl}</div>}
        </div>
      )}

      <PaneAgentMenus
        agentMenu={agentMenu}
        modelMenu={modelMenu}
        disabled={submitting}
        availableModes={availableModes}
        agentModesLoading={agentModesLoading}
        agentModesError={agentModesError}
        onRetryAgentModes={retryAgentModes}
        currentModeId={currentModeId}
        agentStatus={agentStatus}
        resolvedBinding={manageResolvedBinding}
        catalogCapabilities={null}
        providerModels={providerModels}
        providers={agentStatus?.providers}
        modelsLoading={modelsLoading}
        modelsError={modelsError}
        defaultModeId={defaultModeId}
        runtimeId={agentStatus?.runtime}
        onSwitchAgent={(modeId) => {
          // No thread yet — record the pick locally. submit() stamps it onto
          // the new thread, which applies it to the session on send. When
          // enableAgentSelect is off the chip is hidden, so this never fires.
          setPendingModeId(modeId);
          setPendingPrimaryAgent(undefined);
          setAgentMenu(null);
        }}
        primaryAgents={primaryAgents.map(({ definition }) => ({
          id: definition.id,
          name: definition.name,
          scope: definition.scope,
          runtimeSummary: [definition.runtimeProfile.runtimeId, definition.runtimeProfile.providerId, definition.runtimeProfile.modelId].filter(Boolean).join(' · '),
        }))}
        selectedPrimaryAgentId={pendingPrimaryAgent?.definition.id}
        primaryAgentsLoading={primaryAgentsLoading}
        primaryAgentsError={primaryAgentsError}
        onSelectPrimaryAgent={(id) => {
          const selected = primaryAgents.find((agent) => agent.definition.id === id);
          if (!selected) return;
          setPendingPrimaryAgent(selected);
          setPendingModeId(undefined);
          setAgentMenu(null);
        }}
        onSelectDefaultAgent={() => {
          setPendingPrimaryAgent(undefined);
          setPendingModeId(undefined);
          setAgentMenu(null);
        }}
        onSwitchRuntime={async (runtimeId) => {
          const result = await saveAgentOptions({ runtime: runtimeId });
          if (!result.ok) throw new Error(result.error);
          refreshAgentStatus();
        }}
        onSaveProvider={(provider) => saveHomeDefault({ provider })}
        onSaveModel={(model) => saveHomeDefault({ model })}
        onSaveReasoning={(reasoning) => saveHomeDefault({ reasoning: reasoning as AgentReasoning })}
        ultracode={ultracode}
        onSaveUltracode={ultracode ? setUltracodeDraft : undefined}
        onRetryModels={retryModels}
        onCloseAgentMenu={() => setAgentMenu(null)}
        onCloseModelMenu={() => setModelMenu(null)}
      />
    </div>
  );
}
