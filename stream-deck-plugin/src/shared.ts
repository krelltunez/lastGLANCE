// What every action shares: the one connection to the app, the icon table,
// and drawing a key or a touch strip. The Stream Deck glue lives here and in
// actions/; what the keys show is keys.ts, how they look is render.ts.
import WebSocket from 'ws';
import streamDeck, { type DialAction, type KeyAction } from '@elgato/streamdeck';
import type { JsonObject } from '@elgato/utils';
import { createConnection, type CommandOutcome } from './connection';
import { iconMarkup, type IconTable } from './icons';
import { renderKey, renderStrip } from './render';
import type { KeyView } from './keys';
import table from './generated/icons.json';

export const connection = createConnection({
  open: (url) => new WebSocket(url),
  log: (msg) => streamDeck.logger.info(msg),
});

const icons = table as IconTable;

/** Draw a view on a key, or on a dial's touch strip. */
export async function draw(action: KeyAction<JsonObject> | DialAction<JsonObject>, view: KeyView): Promise<void> {
  const markup = iconMarkup(icons, view.icon) ?? (view.icon ? iconMarkup(icons, 'CircleCheck') : null);
  if (action.isDial()) {
    await action.setFeedback({ canvas: renderStrip(view, markup) });
  } else {
    await action.setImage(renderKey(view, markup));
    await action.setTitle('');
  }
}

/** Stream Deck's own feedback for a command: a tick when it worked (or was already done), a warning otherwise. */
export async function acknowledge(action: KeyAction<JsonObject> | DialAction<JsonObject>, outcome: CommandOutcome): Promise<void> {
  const fine = outcome?.ok === true || outcome?.reason === 'too_soon';
  if (fine && action.isKey()) await action.showOk();
  else if (!fine) await action.showAlert();
}

/** Run an async handler, logging instead of letting a rejection end the plugin. */
export function guard(what: string, fn: () => Promise<void>): void {
  fn().catch((err) => streamDeck.logger.error(`${what}: ${err instanceof Error ? err.message : err}`));
}
