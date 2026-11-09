// The desktop proxy's address policy against the canonical table in
// api/ssrf-vectors.json, the same file api/ssrf-vectors.test.js holds this
// repo's web proxy to. After the desktop half of dayGLANCE's
// electron/proxyUrlPolicy.parity.test.ts (krelltunez/dayGLANCE@8d72008).
//
// The table is generated in dayGLANCE and copied here verbatim; see the header
// of api/ssrf-vectors.test.js. If this fails, do not relax it: the policy
// drifted from the table, or this copy of the table is stale.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decideProxyUrl, defaultTrustedHosts, isNeverExemptibleIp, isPrivateOrReservedIp } from './proxyUrlPolicy.js';

interface Vector {
  address: string;
  family: number;
  class: 'ok' | 'private' | 'always';
  note: string;
}

const table = JSON.parse(readFileSync(path.resolve(__dirname, '../api/ssrf-vectors.json'), 'utf-8'));
const vectors: Vector[] = table.vectors;

describe('electron/proxyUrlPolicy.ts agrees with api/ssrf-vectors.json', () => {
  it('reads a table with all three classes and both families', () => {
    expect([...new Set(vectors.map((v) => v.class))].sort()).toEqual(['always', 'ok', 'private']);
    expect(vectors.some((v) => v.family === 6)).toBe(true);
  });

  // The module answers with two predicates rather than a classifier. The
  // mapping is exact: `ok` is neither, `private` is private but grantable,
  // `always` is private and never exemptible.
  it.each(vectors.map((v) => [v.address, v.class, v.note] as const))('%s is %s: %s', (address, expected) => {
    expect({ private: isPrivateOrReservedIp(address), never: isNeverExemptibleIp(address) }).toEqual({
      private: expected !== 'ok',
      never: expected === 'always',
    });
  });

  // Through the decision the proxy actually takes, with no grants: a public
  // address passes, a grantable one asks for consent, the rest are refused.
  it.each(vectors.map((v) => [v.address, v.class] as const))('a fresh install decides %s (%s)', (address, expected) => {
    const host = address.includes(':') ? `[${address}]` : address;
    const decision = decideProxyUrl({
      urlString: `https://${host}/remote.php/dav/`,
      resolvedAddresses: [address],
      trusted: defaultTrustedHosts(),
    });
    expect(decision.kind).toBe(expected === 'ok' ? 'allow' : expected === 'private' ? 'needs-consent' : 'deny');
  });
});
