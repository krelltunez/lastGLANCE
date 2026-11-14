import {
  type DialAction, type DialDownEvent, type DialRotateEvent, type KeyAction, type KeyDownEvent, type KeyUpEvent,
  type TouchTapEvent, type WillDisappearEvent,
} from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import type { DeckState } from '../../../electron/deckProtocol';
import type { KeyView } from '../keys';
import { draw } from '../shared';
import { StateAction } from './state-action';

/** How long a key must be held to act on the shown item rather than move on (a cycling key). */
export const HOLD_MS = 500;

/** What a list key shows at a place in its list: the view, where that is, how many there are, and the item there. */
export interface ListView<T> {
  view: KeyView;
  index: number;
  count: number;
  item: T;
}

type Target = KeyAction<JsonObject> | DialAction<JsonObject>;

// A key that shows a list one item at a time: Due and Pinned (chores), Reach
// out and Coming up (People). Each key and dial keeps its own place in its
// list. On a dial (Stream Deck +), turning moves through the list and pushing
// or tapping the strip acts on the shown item. On a key it depends on the
// action: `cycle` keys (Due, Pinned) move on with a tap and act with a hold;
// `press` keys (Reach out, Coming up) act with a press, on the shown item,
// the first one unless a dial moved it.
export abstract class ListAction<T> extends StateAction {
  private readonly index = new Map<string, number>();
  private readonly downAt = new Map<string, number>();

  /** How a key (not a dial) behaves: `cycle` taps move on and holds act; `press` presses act. */
  protected abstract readonly keyMode: 'cycle' | 'press';
  /** What the list shows at `index` (wrapped by the caller's list). */
  protected abstract show(state: DeckState | null, index: number, now: number): ListView<T>;
  /** Act on the shown item. */
  protected abstract act(target: Target, item: T): Promise<void>;

  private current(id: string): ListView<T> {
    const v = this.show(this.state, this.index.get(id) ?? 0, Date.now());
    this.index.set(id, v.index);
    return v;
  }

  protected async renderAll(): Promise<void> {
    for (const a of this.actions) await draw(a, this.current(a.id).view);
  }

  private async move(a: Target, by: number): Promise<void> {
    this.index.set(a.id, (this.index.get(a.id) ?? 0) + by);
    await draw(a, this.current(a.id).view);
  }

  private async actShown(a: Target): Promise<void> {
    await this.act(a, this.current(a.id).item);
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    if (this.keyMode === 'press') { await this.actShown(ev.action); return; }
    this.downAt.set(ev.action.id, Date.now());
  }

  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    if (this.keyMode === 'press') return;
    const held = Date.now() - (this.downAt.get(ev.action.id) ?? Date.now());
    this.downAt.delete(ev.action.id);
    if (held >= HOLD_MS) await this.actShown(ev.action);
    else await this.move(ev.action, 1);
  }

  override async onDialRotate(ev: DialRotateEvent): Promise<void> {
    await this.move(ev.action, ev.payload.ticks);
  }

  override async onDialDown(ev: DialDownEvent): Promise<void> {
    await this.actShown(ev.action);
  }

  override async onTouchTap(ev: TouchTapEvent): Promise<void> {
    await this.actShown(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent): void {
    this.index.delete(ev.action.id);
    this.downAt.delete(ev.action.id);
    super.onWillDisappear(ev);
  }
}
