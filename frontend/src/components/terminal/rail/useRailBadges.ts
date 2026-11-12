import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { attentionAllowed } from '../../../services/attention/policy';
import { useMetaAgentSettingsAlert } from '../../../state/metaAgent/useMetaAgentOverview';
import { firstRunActive, firstRunProgress, subscribeFirstRunFinished, useSpacesFirstRun } from '../../../state/metaAgent/spacesFirstRun';
import { companionNameNow } from '../../../state/companion/companionName';
import { useSpaceConversationBadges } from '../spaces/home/homeLinks';
import { pagesUpkeepTitle } from '../scheduled/metaAgent/metaAgentCopy';
import { NO_RAIL_BADGES, type RailBadges } from './AreaRail';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';

/**
 * The toast once every first read ends: how many workspace homes were
 * written, and that reading turns incremental; `name` is the agent's, whose
 * Pages upkeep did the reading ("<name> · Pages upkeep finished: …").
 */
export function firstRunFinishedNotice(written: number, failed: number, summaryWritten: boolean, name: string): string {
  const homes = `${written} workspace ${written === 1 ? 'home' : 'homes'}${summaryWritten ? ' + the Pages Home' : ''}`;
  return `${pagesUpkeepTitle(name)} finished: ${homes}${failed ? ` (${failed} not written)` : ''}; from now on it reads only new conversations`;
}

// The rail and the Spaces sidebar both read the badges; only one of them shows the toast.
let toastOwner: object | null = null;

/**
 * Pages reminder badges are temporarily hidden. Scheduled shows a yellow
 * dot while Pages upkeep's first run reads the history or a conversation
 * started from a Space runs, Conversations a green dot once such a
 * conversation finished unseen; Settings shows a red dot while a restriction
 * check of the agent's own runs failed.
 */
export function useRailBadges(): RailBadges {
  const settingsAlert = useMetaAgentSettingsAlert();
  const conversations = useSpaceConversationBadges();
  const firstRun = useSpacesFirstRun(LOCAL_BACKEND_CONNECTION_ID);
  const scheduledRunning = conversations.scheduledRunning || firstRunActive(firstRun.data);
  useEffect(() => {
    if (toastOwner) return undefined;
    const owner = {};
    toastOwner = owner;
    const stop = subscribeFirstRunFinished((_connectionId, status) => {
      if (!attentionAllowed('finished')) return;
      const progress = firstRunProgress(status);
      toast.success(firstRunFinishedNotice(progress.done, progress.failed.length, status.summary.state === 'done', companionNameNow()));
    });
    return () => {
      stop();
      if (toastOwner === owner) toastOwner = null;
    };
  }, []);
  return useMemo(
    () => ({ ...NO_RAIL_BADGES, ...conversations, spacesWaiting: 0, scheduledRunning, settingsAlert }),
    [conversations, scheduledRunning, settingsAlert],
  );
}
