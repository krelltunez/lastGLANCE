import { SingletonAction, type WillAppearEvent, type WillDisappearEvent } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import type { DeckState } from '../../../electron/deckProtocol';
import { connection, guard } from '../shared';

// An action that redraws every visible key on each state from the app, and on
// a minute tick (the keys age: "3d" becomes "4d" with the app untouched). It
// listens only while at least one of its keys is visible.
export abstract class StateAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
  private unsubscribe: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private readonly visible = new Set<string>();
  protected state: DeckState | null = null;

  /** Draw every visible key of this action. */
  protected abstract renderAll(): Promise<void>;

  override onWillAppear(ev: WillAppearEvent<T>): void {
    this.visible.add(ev.action.id);
    if (!this.unsubscribe) {
      this.unsubscribe = connection.onState((s) => {
        this.state = s;
        guard('render', () => this.renderAll());
      });
      this.tick = setInterval(() => guard('render', () => this.renderAll()), 60_000);
    }
    guard('render', () => this.renderAll());
  }

  override onWillDisappear(ev: WillDisappearEvent<T>): void {
    this.visible.delete(ev.action.id);
    if (this.visible.size === 0) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      if (this.tick) clearInterval(this.tick);
      this.tick = null;
    }
  }
}
