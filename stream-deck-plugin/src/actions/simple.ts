import { action, type KeyDownEvent } from '@elgato/streamdeck';
import type { DeckState } from '../../../electron/deckProtocol';
import { addKey, comingUpKey, overviewKey, reachOutKey } from '../keys';
import { acknowledge, connection, draw } from '../shared';
import { ListAction, type ListView } from './list-action';
import { StateAction } from './state-action';

type Target = Parameters<typeof acknowledge>[0];

/**
 * The Soon key: how many chores are overdue, and due soon; opens the app's
 * Soon filter. (Its id is still "overview", the name it first had, so keys
 * already placed keep working.)
 */
@action({ UUID: 'com.lastglance.streamdeck.overview' })
export class SoonAction extends StateAction {
  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, overviewKey(this.state));
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await acknowledge(ev.action, await connection.openApp('filter:soon'));
  }
}

/**
 * The Reach out key: the people in Reach out, the first on a key. Pressing a
 * key, or pushing or tapping a dial, opens the app at logging a contact with
 * the person shown; turning a dial moves through them.
 */
@action({ UUID: 'com.lastglance.streamdeck.reach-out' })
export class ReachOutAction extends ListAction<string | null> {
  protected readonly keyMode = 'press';
  protected show(state: DeckState | null, index: number): ListView<string | null> {
    const v = reachOutKey(state, index);
    return { ...v, item: v.personId };
  }
  protected async act(target: Target, personId: string | null): Promise<void> {
    await acknowledge(target, await connection.openApp(personId ? `log:${personId}` : 'people'));
  }
}

/**
 * The Coming up key: the birthdays and dates ahead, soonest first, the first
 * on a key. Pressing a key, or pushing or tapping a dial, opens the person
 * shown; turning a dial moves through them.
 */
@action({ UUID: 'com.lastglance.streamdeck.coming-up' })
export class ComingUpAction extends ListAction<string | null> {
  protected readonly keyMode = 'press';
  protected show(state: DeckState | null, index: number, now: number): ListView<string | null> {
    const v = comingUpKey(state, now, index);
    return { ...v, item: v.personId };
  }
  protected async act(target: Target, personId: string | null): Promise<void> {
    await acknowledge(target, await connection.openApp(personId ? `person:${personId}` : 'people'));
  }
}

/** Opens the app at Add chore. */
@action({ UUID: 'com.lastglance.streamdeck.add-chore' })
export class AddChoreAction extends StateAction {
  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, addKey(this.state));
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await acknowledge(ev.action, await connection.openApp('action:add'));
  }
}
