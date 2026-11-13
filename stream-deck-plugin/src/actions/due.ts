import {
  action, type DialAction, type DialDownEvent, type DialRotateEvent, type KeyAction, type KeyDownEvent, type KeyUpEvent,
  type TouchTapEvent, type WillDisappearEvent,
} from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { dueKey } from '../keys';
import { acknowledge, connection, draw } from '../shared';
import { StateAction } from './state-action';

/** How long a key must be held to mark the shown chore done rather than move on. */
export const HOLD_MS = 500;

// The Due key: the chores that need doing, one at a time, most overdue first.
// On a key: a tap shows the next, a hold marks the shown one done. On a dial
// (Stream Deck +): turning moves through them, pushing or tapping the strip
// marks the shown one done. Each key keeps its own place in the list.
@action({ UUID: 'com.lastglance.streamdeck.due' })
export class DueAction extends StateAction {
  private readonly index = new Map<string, number>();
  private readonly downAt = new Map<string, number>();

  private view(id: string) {
    const v = dueKey(this.state, this.index.get(id) ?? 0, Date.now());
    this.index.set(id, v.index);
    return v;
  }

  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, this.view(a.id).view);
  }

  private async move(a: KeyAction<JsonObject> | DialAction<JsonObject>, by: number): Promise<void> {
    this.index.set(a.id, (this.index.get(a.id) ?? 0) + by);
    await draw(a, this.view(a.id).view);
  }

  private async completeShown(a: KeyAction<JsonObject> | DialAction<JsonObject>): Promise<void> {
    const { choreId } = this.view(a.id);
    if (!choreId) { await connection.openApp('filter:soon'); return; }
    await acknowledge(a, await connection.complete(choreId));
  }

  override onKeyDown(ev: KeyDownEvent): void {
    this.downAt.set(ev.action.id, Date.now());
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const held = Date.now() - (this.downAt.get(ev.action.id) ?? Date.now());
    this.downAt.delete(ev.action.id);
    if (held >= HOLD_MS) await this.completeShown(ev.action);
    else await this.move(ev.action, 1);
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    await this.move(ev.action, ev.payload.ticks);
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    await this.completeShown(ev.action);
  }

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    await this.completeShown(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.index.delete(ev.action.id);
    super.onWillDisappear(ev);
  }
}
