import { action, type KeyDownEvent } from '@elgato/streamdeck';
import { addKey, comingUpKey, overviewKey, reachOutKey } from '../keys';
import { acknowledge, connection, draw } from '../shared';
import { StateAction } from './state-action';

// The keys that show one thing and open the app at it.

/** Overdue and soon counts; opens the app's Soon filter. */
@action({ UUID: 'com.lastglance.streamdeck.overview' })
export class OverviewAction extends StateAction {
  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, overviewKey(this.state));
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    await acknowledge(ev.action, await connection.openApp('filter:soon'));
  }
}

/** The person at the top of Reach out; opens the app at logging a contact with them. */
@action({ UUID: 'com.lastglance.streamdeck.reach-out' })
export class ReachOutAction extends StateAction {
  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, reachOutKey(this.state).view);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const { personId } = reachOutKey(this.state);
    await acknowledge(ev.action, await connection.openApp(personId ? `log:${personId}` : 'people'));
  }
}

/** The next birthday or date; opens the person. */
@action({ UUID: 'com.lastglance.streamdeck.coming-up' })
export class ComingUpAction extends StateAction {
  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, comingUpKey(this.state, Date.now()).view);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    const { personId } = comingUpKey(this.state, Date.now());
    await acknowledge(ev.action, await connection.openApp(personId ? `person:${personId}` : 'people'));
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
