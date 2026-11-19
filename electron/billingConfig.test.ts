import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MAS_BILLING } from './billingConfig';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf-8');

describe('MAS billing uses the iOS app\'s store setup (Universal Purchase)', () => {
  it('the same product ids as the app', () => {
    const ts = read('src/billing/billing.ts');
    expect(ts).toContain(`yearly: '${MAS_BILLING.products.yearly}'`);
    expect(ts).toContain(`lifetime: '${MAS_BILLING.products.lifetime}'`);
  });

  // Given a window, the package sends every purchase and restore result to
  // that one for the life of the process (@glance-apps/billing before 0.2.3
  // could do nothing else): a window recreated by crash recovery then shows a
  // paywall whose spinner never clears.
  it('main gives billing the current window, not the first one', () => {
    expect(read('electron/main.ts')).toMatch(/registerElectronBilling\(\(\) => live\(mainWindow\), /);
  });

  it('the iOS RevenueCat key and entitlement', () => {
    expect(read('ios/App/App/AppDelegate.swift')).toContain(`configure(apiKey: "${MAS_BILLING.rcApiKey}")`);
    expect(read('ios/App/App/plugins/RevenueCatBilling.swift')).toContain(`static let entitlementId = "${MAS_BILLING.entitlementId}"`);
  });
});
