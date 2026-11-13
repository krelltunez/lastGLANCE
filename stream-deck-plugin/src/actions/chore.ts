import { action, type DidReceiveSettingsEvent, type KeyDownEvent, type SendToPluginEvent } from '@elgato/streamdeck';
import type { JsonValue } from '@elgato/utils';
import streamDeck from '@elgato/streamdeck';
import { choreKey } from '../keys';
import { acknowledge, connection, draw } from '../shared';
import { StateAction } from './state-action';

type Settings = { choreId?: string };

// The Chore key: one chosen chore, its icon in its cadence colour, how long
// since it was done, and the fill bar. A press marks it done; pressed again
// within the minute the app answers "already done", never a second completion.
// The chore is chosen in the property inspector (ui/chore.html), which gets
// the list from here over Stream Deck's own channel.
@action({ UUID: 'com.lastglance.streamdeck.chore' })
export class ChoreAction extends StateAction<Settings> {
  protected async renderAll(): Promise<void> {
    for (const a of this.actions) {
      const { choreId } = await a.getSettings();
      await draw(a, choreKey(this.state, choreId ?? null, Date.now()).view);
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
    await draw(ev.action, choreKey(this.state, ev.payload.settings.choreId ?? null, Date.now()).view);
  }

  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
    const { choreId } = choreKey(this.state, ev.payload.settings.choreId ?? null, Date.now());
    if (!choreId) { await connection.openApp(null); return; }
    await acknowledge(ev.action, await connection.complete(choreId));
  }

  // The inspector asks for the chores to choose from.
  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, Settings>): Promise<void> {
    const payload = ev.payload as { event?: string } | null;
    if (payload?.event !== 'lg-list-chores') return;
    const state = this.state;
    await streamDeck.ui.sendToPropertyInspector({
      event: 'lg-chores',
      connected: state !== null,
      chores: (state?.chores ?? []).map((c) => ({ id: c.id, name: c.name, category: c.category ?? '' })),
    });
  }
}
