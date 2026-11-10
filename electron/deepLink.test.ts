import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEEP_LINK_HOSTS, deepLinkFromArgv, deepLinkToken } from './deepLink';

describe('lastglance:// links', () => {
  it.each([
    ['lastglance://chore/3f2c-a1', 'chore:3f2c-a1'],
    ['lastglance://filter/soon', 'filter:soon'],
    ['lastglance://person/p_1', 'person:p_1'],
    ['lastglance://log/p_1', 'log:p_1'],
    ['lastglance://people', 'people'],
    ['lastglance://chores', 'chores'],
    ['lastglance://action/search', 'action:search'],
    ['lastglance://action/add', 'action:add'],
    ['LASTGLANCE://CHORE/abc', 'chore:abc'],
  ])('%s opens %s', (url, token) => {
    expect(deepLinkToken(url)).toBe(token);
  });

  it.each([
    'lastglance://chore', 'lastglance://chore/', 'lastglance://action/delete', 'lastglance://settings',
    'lastglance://chore/a%20b', 'lastglance://chore/<script>', 'https://chore/abc', 'not a url', 42,
  ])('refuses %s', (url) => {
    expect(deepLinkToken(url)).toBeNull();
  });

  it('finds the URL among a second instance\'s arguments', () => {
    expect(deepLinkFromArgv(['/opt/lastGLANCE/lastglance', '--no-sandbox', 'lastglance://chore/abc'])).toBe('lastglance://chore/abc');
    expect(deepLinkFromArgv(['/opt/lastGLANCE/lastglance', '--hidden'])).toBeNull();
  });

  it('covers exactly the hosts the iOS shell maps (AppDelegate.deepLinkToken)', () => {
    const swift = readFileSync(path.join(__dirname, '../ios/App/App/AppDelegate.swift'), 'utf-8');
    const fn = swift.slice(swift.indexOf('static func deepLinkToken'));
    const body = fn.slice(0, fn.indexOf('\n    }\n'));
    // The outer switch's cases: url.host values, not the action sub-switch's.
    const outer = body.slice(0, body.indexOf('switch url.lastPathComponent'));
    const hosts = [...outer.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(0);
    expect([...hosts].sort()).toEqual([...DEEP_LINK_HOSTS].sort());
  });
});
