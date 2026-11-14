import { describe, expect, it } from 'vitest';
import { localizeResourceResult, localizeTimes, localizeToolResult, parseTimeInput, toLocalIso } from './mcpTimes';

const DENVER = 'America/Denver';

describe('times on the MCP surface are local', () => {
  it('writes an instant as wall-clock time with its offset, across DST', () => {
    // 9:30 pm on a Friday in Denver is Saturday in UTC; local keeps it Friday.
    expect(toLocalIso(Date.parse('2026-11-14T04:30:00Z'), DENVER)).toBe('2026-11-13T21:30:00-07:00');
    expect(toLocalIso(Date.parse('2026-07-04T18:00:00Z'), DENVER)).toBe('2026-07-04T12:00:00-06:00');
    expect(toLocalIso(Date.parse('2026-11-14T04:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-14T10:00:00+05:30');
    expect(toLocalIso(Date.parse('2026-11-14T04:30:00.789Z'), 'UTC')).toBe('2026-11-14T04:30:00+00:00');
  });

  it('rewrites only time fields holding a whole instant, at any depth', () => {
    const out = localizeTimes({
      last_completed_at: '2026-11-14T04:30:00.000Z',
      next_due: '2026-11-20',
      snoozed_until: '2026-11-21T07:00:00Z',
      completions: [{ completed_at: '2026-11-14T04:30:00Z', note: '2026-11-14T04:30:00Z' }],
      at: '2026-11-14T04:30:00Z',
      before: { occurred_at: '2026-11-14T04:30:00Z' },
      created_at: null,
      name: 'Water plants',
    }, DENVER);
    expect(out).toEqual({
      last_completed_at: '2026-11-13T21:30:00-07:00',
      next_due: '2026-11-20',
      snoozed_until: '2026-11-21T00:00:00-07:00',
      // A note is the user's text, whatever it holds.
      completions: [{ completed_at: '2026-11-13T21:30:00-07:00', note: '2026-11-14T04:30:00Z' }],
      at: '2026-11-13T21:30:00-07:00',
      before: { occurred_at: '2026-11-13T21:30:00-07:00' },
      created_at: null,
      name: 'Water plants',
    });
  });

  it('localizes a tool result and the text that mirrors it, and leaves errors alone', () => {
    const data = { completed_at: '2026-11-14T04:30:00Z' };
    const r = localizeToolResult({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data }, DENVER);
    expect(r.structuredContent).toEqual({ completed_at: '2026-11-13T21:30:00-07:00' });
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
    const err = { isError: true, content: [{ type: 'text' as const, text: '{"error":{}}' }] };
    expect(localizeToolResult(err, DENVER)).toBe(err);
  });

  it('localizes a resource\'s JSON body', () => {
    const r = localizeResourceResult({ contents: [{ uri: 'x', mimeType: 'application/json', text: '{"updated_at":"2026-11-14T04:30:00Z"}' }] }, DENVER);
    expect(JSON.parse(r.contents[0].text)).toEqual({ updated_at: '2026-11-13T21:30:00-07:00' });
  });
});

describe('time inputs', () => {
  it('reads a local wall-clock time in the zone, as dayGLANCE writes them', () => {
    expect(parseTimeInput('2026-11-13 21:30', DENVER)).toBe('2026-11-13T21:30:00-07:00');
    expect(parseTimeInput('2026-07-04T12:00', DENVER)).toBe('2026-07-04T12:00:00-06:00');
    expect(parseTimeInput('2026-11-13 21:30:15', 'Asia/Kolkata')).toBe('2026-11-13T21:30:15+05:30');
  });

  it('keeps an ISO instant with a zone as given', () => {
    expect(parseTimeInput('2026-11-12T18:30:00-07:00', DENVER)).toBe('2026-11-12T18:30:00-07:00');
    expect(parseTimeInput('2026-11-12T18:30:00Z', DENVER)).toBe('2026-11-12T18:30:00Z');
  });

  it('takes the earlier of a repeated hour, and the time after a skipped one', () => {
    // 2026-11-01, 1:30 am happens twice in Denver: first in MDT.
    expect(parseTimeInput('2026-11-01 01:30', DENVER)).toBe('2026-11-01T01:30:00-06:00');
    // 2026-03-08, 2:30 am never happens: clocks go from 2:00 to 3:00.
    expect(parseTimeInput('2026-03-08 02:30', DENVER)).toBe('2026-03-08T03:30:00-06:00');
  });

  it('refuses anything else', () => {
    for (const bad of ['yesterday', '2026-11-13', '2026-02-30 10:00', '2026-11-13 24:00', '13/11/2026 10:00', '2026-11-13T25:00:00Z']) {
      expect(parseTimeInput(bad, DENVER), bad).toBeNull();
    }
  });
});
