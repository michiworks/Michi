import { createContext, useContext, type ReactNode } from 'react';
import type { ChatMessage, ToolCallState } from '../chatTypes';

/**
 * How one message's links render: the shape of components/markdownLinkRenderer
 * MarkdownLinkRenderer, restated here because state sits below components
 * (dependencyRules state-to-components); a renderer of that type is one.
 */
export interface MessageLinkPolicy {
  protocols: readonly string[];
  matches(href: string): boolean;
  render(href: string, children: ReactNode): ReactNode;
  remoteMedia?: false;
}

/**
 * How the Spaces Meta agent window dresses the assistant conversation it
 * shows through the shared message list. Every field is optional and the
 * message components behave as before without a provider.
 */
export interface MetaChatDecorations {
  /** Replaces the "> michi" speaker line above an assistant reply. */
  assistantLabel?: ReactNode;
  /**
   * The speaker line of one assistant message, over `assistantLabel`
   * ("<name> · check-in" on a posted check-in, DESIGN-v2 §3.3); undefined
   * keeps `assistantLabel`.
   */
  assistantLabelFor?: (message: ChatMessage) => ReactNode | undefined;
  /**
   * The link policy of one assistant message (DESIGN-v2 §2.8 "linkPolicyFor"):
   * a posted check-in gets the agent's allow-list, a reply to the user the
   * assistant's links. Undefined keeps the surrounding renderer.
   */
  linkRendererFor?: (message: ChatMessage) => MessageLinkPolicy | undefined;
  /** A one-line label per tool call; tool groups then list every call as one row. */
  toolLine?: (tool: ToolCallState) => string | null;
  /**
   * What a finished activity block did, in the window's words; the block's
   * header then shows it in place of the generic summary (raw tool names)
   * and leaves out the block's duration, which spans the reasoning around
   * the calls, not the calls. null keeps the generic header. The Companion
   * only.
   */
  workLine?: (tools: readonly ToolCallState[]) => string | null;
  /** Replaces a reply's page-write receipts with the window's cards (page changes, started conversations). */
  toolCards?: (tools: readonly ToolCallState[]) => ReactNode;
  /** Rendered after a message, e.g. a "From here on: Kiro" divider. */
  afterMessage?: (message: ChatMessage) => ReactNode;
  /**
   * Leaves a message out of the list. A hidden last message takes its live
   * activity row along. (The agent's conversation hides nothing since
   * DESIGN-v2 §3.8.)
   */
  hideMessage?: (message: ChatMessage, index: number, messages: readonly ChatMessage[]) => boolean;
}

export const MetaChatDecorationsContext = createContext<MetaChatDecorations | null>(null);

export function useMetaChatDecorations(): MetaChatDecorations | null {
  return useContext(MetaChatDecorationsContext);
}
