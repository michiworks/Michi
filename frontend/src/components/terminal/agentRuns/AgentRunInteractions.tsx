import type React from 'react';
import type { AgentRunInteractionDtoV1, JsonValue } from 'michi-shared';
import { useFocusAfterAction } from '../../../hooks/useFocusAfterAction';
import { Button } from '../../ui/controls';

export function AgentRunInteractions({ interactions, busy = false, onRespond }: {
  interactions: readonly AgentRunInteractionDtoV1[];
  /** A response is in flight: Allow and Deny stay, aria-disabled. */
  busy?: boolean;
  onRespond?: (interaction: AgentRunInteractionDtoV1, response: JsonValue) => void;
}) {
  // An answered interaction drops Allow and Deny: focus goes to its box.
  const focusAfter = useFocusAfterAction(busy);
  if (interactions.length === 0) return null;
  const respond = (event: React.MouseEvent<HTMLButtonElement>, interaction: AgentRunInteractionDtoV1, response: JsonValue) => {
    if (busy || !onRespond) return;
    const box = event.currentTarget.closest<HTMLElement>('[data-interaction]');
    focusAfter(() => box);
    onRespond(interaction, response);
  };
  return (
    <section aria-label="Run interactions" style={{ display: 'grid', gap: 6 }}>
      {interactions.map((interaction) => {
        const pending = interaction.status === 'pending';
        return (
          <div key={interaction.id} data-interaction="" tabIndex={-1} className="t-row-focus" style={{ border: `1px solid ${pending ? 'var(--term-select)' : 'var(--term-line)'}`, background: pending ? 'var(--term-select-f)' : 'var(--term-surface)', padding: '10px 12px' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <strong style={{ color: 'var(--term-fg)', fontSize: 'var(--fs-sm)' }}>{interaction.kind.replace('_', ' ')}</strong>
              <span style={{ color: pending ? 'var(--term-waiting-text)' : 'var(--term-muted)', fontSize: 'var(--fs-xs)', marginLeft: 'auto', textTransform: 'uppercase' }}>{interaction.status}</span>
            </div>
            <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: 'var(--term-mid)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>
              {typeof interaction.request === 'string' ? interaction.request : JSON.stringify(interaction.request, null, 2)}
            </pre>
            {pending && onRespond && (
              <div data-testid="pending-interaction-actions" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
                <Button size="sm" danger aria-disabled={busy || undefined} onClick={(event) => respond(event, interaction, { decision: 'deny' })}>Deny</Button>
                <Button variant="primary" size="sm" aria-disabled={busy || undefined} onClick={(event) => respond(event, interaction, { decision: 'allow' })}>Allow</Button>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
