/**
 * Whether a user's message to the agent starts with check-in or collector
 * material (DESIGN-v2 §1.3, §2.8 T4), decided by routes/michi.ts before the
 * turn starts (or before a steer reaches it), so the turn runs in Ask on
 * every runtime: its block target is a block a check-in wrote; a reference
 * (metaAgentContext.refs) names such a block or page, a database a check-in
 * changed or made, a Today item, or a posted check-in the message replies
 * to. A reply to a post is that `post` ref alone, however the user replied
 * (a post chip, a quote, a comment or a branch on a selection in it, a
 * brief's action: w2-fix D8, D9); a quote's own provenance names no post.
 * 'checkin' when any of it is check-in material, else 'collector'. The pages
 * and databases are judged by services/pages/checkinSources.ts, as a read of
 * them would be.
 */

import type { CompanionTaintDetail, CompanionTurnRef, MetaAgentChatTurnContext } from 'michi-shared';
import { PageWriteError } from '../services/pages/core';
import { getPage } from '../services/pages/repository';
import { databaseCheckinTaint, pageCheckinTaint } from '../services/pages/checkinSources';

function pageTaint(pageId: string, blockId: string | undefined, ownerUserId: string): CompanionTaintDetail | null {
  try {
    return pageCheckinTaint(getPage(pageId, ownerUserId), blockId ? [blockId] : undefined);
  } catch (error) {
    // A page the user cannot read is no material for the turn: its tools cannot read it either.
    if (error instanceof PageWriteError) return null;
    throw error;
  }
}

function refTaint(ref: CompanionTurnRef, ownerUserId: string): CompanionTaintDetail | null {
  switch (ref.kind) {
    case 'page': return pageTaint(ref.pageId, ref.blockId, ownerUserId);
    case 'rows': return databaseCheckinTaint(ref.databaseId, ownerUserId);
    case 'companion_item': return 'collector';
    // A reply to a post carries its text: check-in material, whatever the id says.
    case 'post': return 'checkin';
  }
}

export function companionStartTaint(input: {
  context?: MetaAgentChatTurnContext;
  ownerUserId: string;
}): CompanionTaintDetail | null {
  const found: Array<CompanionTaintDetail | null> = [];
  const context = input.context;
  if (context?.pageId && context.blockId) found.push(pageTaint(context.pageId, context.blockId, input.ownerUserId));
  for (const ref of context?.refs ?? []) found.push(refTaint(ref, input.ownerUserId));
  if (found.includes('checkin')) return 'checkin';
  return found.includes('collector') ? 'collector' : null;
}
