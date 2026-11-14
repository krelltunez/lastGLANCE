import { action } from '@elgato/streamdeck';
import type { DeckState } from '../../../electron/deckProtocol';
import { dueKey, pinnedKey } from '../keys';
import { acknowledge, connection } from '../shared';
import { ListAction, type ListView } from './list-action';

export { HOLD_MS } from './list-action';

type ChoreTarget = Parameters<typeof acknowledge>[0];

/** Mark the shown chore done; with none shown, open the app where the list comes from. */
async function completeOr(target: ChoreTarget, choreId: string | null, otherwise: string | null): Promise<void> {
  if (!choreId) { await connection.openApp(otherwise); return; }
  await acknowledge(target, await connection.complete(choreId));
}

// The Due key: the chores that need doing, one at a time, most overdue first.
// A tap shows the next, a hold marks the shown one done; on a dial, turn to
// move and push or tap the strip to mark it done.
@action({ UUID: 'com.lastglance.streamdeck.due' })
export class DueAction extends ListAction<string | null> {
  protected readonly keyMode = 'cycle';
  protected show(state: DeckState | null, index: number, now: number): ListView<string | null> {
    const v = dueKey(state, index, now);
    return { ...v, item: v.choreId };
  }
  protected act(target: ChoreTarget, choreId: string | null): Promise<void> {
    return completeOr(target, choreId, 'filter:soon');
  }
}

// The Pinned key: the pinned chores, in the app's Pinned order, one at a time.
// The same hands as Due.
@action({ UUID: 'com.lastglance.streamdeck.pinned' })
export class PinnedAction extends ListAction<string | null> {
  protected readonly keyMode = 'cycle';
  protected show(state: DeckState | null, index: number, now: number): ListView<string | null> {
    const v = pinnedKey(state, index, now);
    return { ...v, item: v.choreId };
  }
  protected act(target: ChoreTarget, choreId: string | null): Promise<void> {
    return completeOr(target, choreId, null);
  }
}
