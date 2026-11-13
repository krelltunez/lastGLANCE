import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, parseDeckCommand, STREAM_DECK_PORT } from './deckProtocol';
import { STREAM_DECK_PORT as SETTINGS_PORT } from './localIntegrations';

describe('the Stream Deck protocol', () => {
  it('uses the port Settings shows', () => {
    expect(STREAM_DECK_PORT).toBe(SETTINGS_PORT);
  });

  it('accepts the three commands, shaped exactly', () => {
    expect(parseDeckCommand(JSON.stringify({ type: 'lg:auth', token: 'a'.repeat(32) }))).toEqual({ type: 'lg:auth', token: 'a'.repeat(32) });
    expect(parseDeckCommand(JSON.stringify({ type: 'lg:chore:complete', choreId: 'ch-1', clientId: 'k1' }))).toEqual({ type: 'lg:chore:complete', choreId: 'ch-1', clientId: 'k1' });
    expect(parseDeckCommand(JSON.stringify({ type: 'lg:open', target: 'action:add', clientId: 'k2' }))).toEqual({ type: 'lg:open', target: 'action:add', clientId: 'k2' });
    expect(parseDeckCommand(Buffer.from(JSON.stringify({ type: 'lg:open', clientId: 'k3' })))).toEqual({ type: 'lg:open', target: null, clientId: 'k3' });
  });

  it('drops anything else, never forwarding it', () => {
    for (const raw of [
      '{oops', '[]', 'null', 42, null,
      JSON.stringify({ type: 'lg:chore:complete', choreId: 'ch-1' }),                     // no clientId
      JSON.stringify({ type: 'lg:chore:complete', choreId: 'a b', clientId: 'k' }),       // not an id
      JSON.stringify({ type: 'lg:auth', token: 'short' }),
      JSON.stringify({ type: 'lg:open', target: 7, clientId: 'k' }),
      JSON.stringify({ type: 'day:task:complete', id: 'x' }),                             // another app's protocol
      JSON.stringify({ type: 'lg:chore:complete', choreId: 'c', clientId: 'k', pad: 'x'.repeat(MAX_FRAME_BYTES) }),
    ]) expect(parseDeckCommand(raw), String(raw).slice(0, 60)).toBeNull();
  });
});
