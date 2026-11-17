import { createContext, memo, useContext, useMemo } from 'react';
import type { BlockAnswerSource, BlockSubmissionHost, MichiPageBlock } from 'michi-shared';
import type { AssistantBlock } from '../../state/chatTypes';
import { blockSubmissionCtx, useBlockSubmissions, type BlockSubmissions } from '../../state/pages/useBlockSubmissions';
import { MichiBlock } from './content/page/MichiBlock';
import type { MichiBlockCtx } from './content/page/blockTypes';
import './ChatBlocksView.css';

/**
 * What a chat pane gives the blocks its replies show (show_blocks): where an
 * answer goes, and where the thread's block submissions live. TPane provides
 * it around its transcript; without it, or with no `send` (a read-only or
 * archived thread), the blocks draw disabled and record nothing.
 */
export interface ChatBlocksHost {
  nodeId: string;
  /** The thread's workspace and the backend it is on; without them submissions are neither shown nor stored. */
  workspaceId?: string;
  connectionId?: string;
  /**
   * Sends `text` as the user's message in this thread, through the pane's
   * own send path (queued while the thread answers), marked as the answer
   * to `answer`'s block so the transcript draws it as one line. False when it
   * did not go.
   */
  send?: (text: string, answer?: BlockAnswerSource) => boolean;
}

export const ChatBlocksHostContext = createContext<ChatBlocksHost | null>(null);

type ShownBlocks = Extract<AssistantBlock, { kind: 'blocks' }>;

const isBlock = (value: unknown): value is MichiPageBlock =>
  !!value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string';

/** One show_blocks call: its title and blocks, drawn by the page renderers. */
const ShownBlockSet = memo(function ShownBlockSet({ shown, messageId, send, submissions }: {
  shown: ShownBlocks;
  /** The reply the blocks are in, which an answer names (BlockAnswerSource). */
  messageId?: string;
  send: ChatBlocksHost['send'];
  /** Null where the reply has no host to keep submissions under: its blocks send unrecorded. */
  submissions: BlockSubmissions | null;
}) {
  const ctx = useMemo<MichiBlockCtx>(() => ({
    depth: 0,
    // A reply's block always sends its answer at once, as the user's next message; nothing waits in a composer.
    sendsAlways: true,
    ...(send ? { requestAssistant: (block: MichiPageBlock, prompt: string, title: string) => !!prompt.trim()
      && send(prompt, messageId && typeof block.id === 'string' ? { messageId, blockId: block.id, title: title.trim() } : undefined) } : {}),
    // A form, poll or choice stores what it sends first (contract C3), then shows it read-only, after a reload too.
    ...(submissions ? blockSubmissionCtx(submissions, !!send) : {}),
  }), [messageId, send, submissions]);
  const blocks = shown.blocks.filter(isBlock);
  if (blocks.length === 0) return null;
  const title = shown.title?.trim();
  return (
    <section className="t-chat-blocks" data-chat-blocks={shown.id} data-disabled={send ? undefined : 'true'} aria-label={title || 'Blocks'}>
      {title && <h3 className="t-chat-blocks__title">{title}</h3>}
      {blocks.map((block, index) => (
        <div key={typeof block.id === 'string' ? block.id : index} className="t-chat-blocks__item" data-block-id={typeof block.id === 'string' ? block.id : undefined}>
          <MichiBlock block={block} ctx={ctx} />
        </div>
      ))}
    </section>
  );
});

/** A run of `blocks` entries in the reply `messageId`, in order. */
export function ChatBlocksView({ blocks, messageId }: { blocks: readonly AssistantBlock[]; messageId?: string }) {
  const host = useContext(ChatBlocksHostContext);
  const submissionHost = useMemo<BlockSubmissionHost | null>(
    () => (host?.workspaceId && host.connectionId && messageId ? { kind: 'chat', nodeId: host.nodeId, messageId } : null),
    [host?.workspaceId, host?.connectionId, host?.nodeId, messageId],
  );
  const submissions = useBlockSubmissions(host?.connectionId ?? '', host?.workspaceId ?? '', submissionHost);
  return (
    <>
      {blocks.filter((b): b is ShownBlocks => b.kind === 'blocks').map((shown) => (
        <ShownBlockSet key={shown.id} shown={shown} messageId={messageId} send={host?.send} submissions={submissionHost ? submissions : null} />
      ))}
    </>
  );
}
