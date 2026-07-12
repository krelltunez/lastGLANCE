// Generate Play Store / marketing screenshots against a running dev/preview build.
//
// Seeds a fresh browser profile with a rich, realistic demo dataset (categories,
// subcategories, chores, and ~a year of varied completion history) directly into
// the app's IndexedDB, then drives Chromium to capture dark-mode phone and tablet
// screenshots. Nothing is written to your real profile; each shot uses a throwaway
// browser context.
//
// Usage:
//   1. Start the app in another terminal:  npm run dev   (or `npm run preview`)
//   2. Run:                                 npm run gen:screenshots
//
// Env overrides:
//   BASE_URL     app URL to shoot            (default http://localhost:5173)
//   OUT_DIR      output directory            (default ./store-screenshots)
//   CHROME_PATH  Chromium executable path    (default: auto-resolved by
//                playwright-core, honouring PLAYWRIGHT_BROWSERS_PATH)
//
// Output (dark mode): phone-1-dashboard, phone-2-detail, phone-3a-editmode,
// phone-3b-editform (1200x2370), tablet-1-dashboard, tablet-2-detail (2560x1600).

import { chromium } from 'playwright-core'
import { mkdirSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173/'
const OUT = resolve(process.env.OUT_DIR ?? 'store-screenshots')
mkdirSync(OUT, { recursive: true })

// playwright-core does not ship a browser. Prefer CHROME_PATH, else look for a
// Chromium under PLAYWRIGHT_BROWSERS_PATH (how this repo's dev image ships it),
// else undefined -> let playwright-core resolve its own managed download.
function resolveChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (root && existsSync(root)) {
    for (const dir of readdirSync(root)) {
      if (!dir.startsWith('chromium')) continue
      for (const bin of [
        'chrome-linux/chrome',
        'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
      ]) {
        const p = resolve(root, dir, bin)
        if (existsSync(p)) return p
      }
    }
  }
  return undefined
}
const EXEC = resolveChrome()

// ── Demo taxonomy ────────────────────────────────────────────────────────────
// Icons are restricted to names that survive the app's ICON_REGISTRY dedup
// (lucide aliases like Wind/WashingMachine/Pill/Scissors collapse to another
// component and render blank), so every chore/category below shows an icon.
const CATS = [
  { k: 'home', name: 'Home', icon: 'Home' },
  { k: 'clean', name: 'Cleaning', icon: 'Brush', parent: 'home' },
  { k: 'kitchen', name: 'Kitchen', icon: 'CookingPot', parent: 'home' },
  { k: 'health', name: 'Health', icon: 'HeartPulse' },
  { k: 'fitness', name: 'Fitness', icon: 'Dumbbell', parent: 'health' },
  { k: 'medical', name: 'Medical', icon: 'BriefcaseMedical', parent: 'health' },
  { k: 'vehicle', name: 'Vehicle', icon: 'Car' },
  { k: 'finances', name: 'Finances', icon: 'Coins' },
  { k: 'garden', name: 'Garden', icon: 'Flower' },
  { k: 'pets', name: 'Pets', icon: 'Bone' },
]
// [categoryKey, name, icon, cadenceDays, lastDoneDaysAgo]
const CHORES = [
  ['clean', 'Vacuum', 'Fan', 7, 9],
  ['clean', 'Mop floors', 'Droplets', 14, 14],
  ['clean', 'Clean bathrooms', 'Bath', 7, 6],
  ['clean', 'Do laundry', 'Droplet', 7, 12],
  ['clean', 'Change bed sheets', 'BedDouble', 14, 15],
  ['kitchen', 'Clean kitchen', 'CookingPot', 10, 9],
  ['kitchen', 'Wipe counters', 'Droplet', 3, 6],
  ['kitchen', 'Take out trash', 'Brush', 3, 5],
  ['fitness', 'Morning workout', 'Dumbbell', 2, 2],
  ['fitness', 'Evening walk', 'Footprints', 1, 0],
  ['fitness', 'Bike ride', 'Bike', 7, 6],
  ['medical', 'Take vitamins', 'Cross', 1, 1],
  ['medical', 'Dentist cleaning', 'Cross', 180, 55],
  ['medical', 'Annual physical', 'Activity', 365, 70],
  ['medical', 'Eye exam', 'Eye', 365, 90],
  ['medical', 'Haircut', 'Brush', 30, 25],
  ['vehicle', 'Wash car', 'Droplets', 30, 15],
  ['vehicle', 'Oil change', 'Fuel', 120, 16],
  ['vehicle', 'Check tire pressure', 'Gauge', 30, 28],
  ['finances', 'Review budget', 'BadgeDollarSign', 30, 25],
  ['finances', 'Pay bills', 'Banknote', 30, 19],
  ['finances', 'Check bank statements', 'DollarSign', 30, 25],
  ['finances', 'Check credit score', 'CreditCard', 90, 15],
  ['garden', 'Water plants', 'Droplet', 7, 7],
  ['garden', 'Mow lawn', 'Leaf', 14, 12],
  ['garden', 'Weed garden', 'Flower2', 21, 19],
  ['garden', 'Fertilize lawn', 'FlaskConical', 60, 54],
  ['pets', 'Feed cats', 'Fish', 1, 0],
  ['pets', 'Clean litter box', 'Cat', 7, 7],
  ['pets', 'Brush cats', 'Brush', 14, 13],
  ['pets', 'Vet checkup', 'Cross', 365, 90],
]

async function seedRichData(page) {
  return page.evaluate(async ({ cats, chores }) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('lastglance')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction(['categories', 'chores', 'completionEvents'], 'readwrite')
    const catStore = tx.objectStore('categories')
    const choreStore = tx.objectStore('chores')
    const evtStore = tx.objectStore('completionEvents')
    const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

    await req(catStore.clear())
    await req(choreStore.clear())
    await req(evtStore.clear())

    const now = Date.now()
    const DAY = 86400000
    const uuid = () => crypto.randomUUID()
    const iso = (ms) => new Date(ms).toISOString()

    // Global activity level shared by ALL chores (so quiet/busy days line up in the
    // aggregate header grid). Built from irregular random-length blocks with random
    // intensities — including scattered near-empty stretches — plus per-day jitter,
    // so the result looks genuinely random rather than a periodic sine (no stripes).
    const gf = new Array(382)
    {
      let d = 0
      while (d <= 381) {
        const len = 3 + Math.floor(Math.random() * 16)
        const r = Math.random()
        const level = r < 0.18 ? 0.02 + Math.random() * 0.08   // near-empty stretch
          : r < 0.45 ? 0.20 + Math.random() * 0.30             // low
          : r < 0.80 ? 0.50 + Math.random() * 0.45             // medium
          : 0.95 + Math.random() * 0.55                        // busy
        for (let i = 0; i < len && d <= 381; i++, d++) {
          gf[d] = Math.max(0, level * (0.65 + Math.random() * 0.7))
        }
      }
    }

    // categories: parents first so children can reference the numeric id
    const catId = {}, catSync = {}
    for (const c of cats.filter(c => !c.parent)) {
      const sync = uuid(); catSync[c.k] = sync
      catId[c.k] = await req(catStore.add({
        sync_id: sync, name: c.name, sort_order: cats.indexOf(c), icon: c.icon,
        parent_sync_id: null, parent_category_id: null, assigned_user_sync_ids: [],
        updated_at: iso(now),
      }))
    }
    for (const c of cats.filter(c => c.parent)) {
      const sync = uuid(); catSync[c.k] = sync
      catId[c.k] = await req(catStore.add({
        sync_id: sync, name: c.name, sort_order: cats.indexOf(c), icon: c.icon,
        parent_sync_id: catSync[c.parent], parent_category_id: catId[c.parent],
        assigned_user_sync_ids: [], updated_at: iso(now),
      }))
    }

    let totalEvents = 0
    let order = 0
    for (const [catKey, name, icon, cadence, last] of chores) {
      const choreId = await req(choreStore.add({
        sync_id: uuid(), name, category_id: catId[catKey], category_sync_id: catSync[catKey],
        sort_order: order++, target_cadence_days: cadence, notify_when_overdue: true,
        auto_schedule_to_dayglance: false, preferred_schedule_behavior: null,
        seasonal_start: null, seasonal_end: null, icon: icon ?? undefined,
        assigned_user_sync_ids: [], created_at: iso(now - 400 * DAY), updated_at: iso(now),
      }))
      // Day-by-day history so density fluctuates: genuine gaps (0), single days (1),
      // and occasional multi-per-day bursts (2-3). The most-recent completion is pinned
      // at exactly `last` days ago so the card's recency colour/elapsed text stays right.
      const mkEvent = async (ms) => {
        const at = new Date(ms)
        at.setHours(6 + Math.floor(Math.random() * 16), Math.floor(Math.random() * 60), 0, 0)
        await req(evtStore.add({
          sync_id: uuid(), chore_id: choreId, completed_at: at.toISOString(),
          note: null, source: 'manual', completed_by_user_sync_id: null,
        }))
        totalEvents++
      }
      await mkEvent(now - last * DAY)
      const base = Math.min(0.9, Math.max(0.03, 1 / cadence))
      const phase = Math.random() * Math.PI * 2
      for (let d = last + 1; d <= 380; d++) {
        const intensity = 0.35 + 0.85 * (0.5 + 0.5 * Math.sin(d / 26 + phase)) + (Math.random() - 0.5) * 0.35
        const p = Math.min(0.95, Math.max(0, base * intensity * gf[d] * 1.4))
        if (Math.random() < p) {
          const dayMs = now - d * DAY
          await mkEvent(dayMs)
          if (Math.random() < 0.22) await mkEvent(dayMs)                  // some days: 2
          if (cadence <= 3 && Math.random() < 0.10) await mkEvent(dayMs)  // frequent chores: occasional 3
        }
      }
    }
    await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error) })
    return { cats: cats.length, chores: chores.length, events: totalEvents }
  }, { cats: CATS, chores: CHORES })
}

async function newPage(browser, { width, height, dsf }) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: dsf,
    colorScheme: 'dark', isMobile: dsf >= 3, hasTouch: dsf >= 3,
  })
  await ctx.addInitScript(() => {
    // Dark theme + skip the first-run welcome so it never covers a shot.
    localStorage.setItem('theme', 'dark')
    localStorage.setItem('lg-welcome-dismissed', '1')
  })
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('PAGEERROR:', e.message))
  return { ctx, page }
}

// Hide transient overlays that clutter store shots: the overdue toast stack
// (z-[60]) and the mobile FAB cluster (fixed bottom-6 right-6 z-40).
async function hideChrome(page) {
  await page.addStyleTag({ content:
    '[class*="z-[60]"]{display:none!important}' +
    '[class*="z-40"][class*="bottom-6"]{display:none!important}' })
}

async function loadSeeded(browser, size) {
  const { ctx, page } = await newPage(browser, size)
  await page.goto(BASE_URL, { waitUntil: 'networkidle' })
  await page.getByText('Vacuum').first().waitFor({ state: 'attached', timeout: 15000 }) // default seed -> DB exists
  const stats = await seedRichData(page)
  console.log('seeded', JSON.stringify(stats))
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('Morning workout').first().waitFor({ state: 'attached', timeout: 15000 })
  await page.waitForTimeout(2200) // let the header grid's ~1.5s load "wave" settle to true colours
  await hideChrome(page)
  return { ctx, page }
}

const browser = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] })

// ── Phone shots (portrait, 1200x2370) ────────────────────────────────────────
{
  const { ctx, page } = await loadSeeded(browser, { width: 400, height: 790, dsf: 3 })
  await page.screenshot({ path: `${OUT}/phone-1-dashboard.png` })

  await page.getByRole('button', { name: /Morning workout/ }).first().click()
  await page.getByText('Past year').waitFor({ timeout: 10000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/phone-2-detail.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Edit mode (candidate A for the 3rd shot): reorder / edit / delete affordances.
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByRole('button', { name: 'Edit categories and chores' }).first().click()
  await page.waitForTimeout(500)
  await hideChrome(page)
  await page.screenshot({ path: `${OUT}/phone-3a-editmode.png` })

  // Edit-chore form (candidate B): the config surface (icon, cadence, reminders, seasonal).
  await page.getByRole('button', { name: 'Edit Vacuum' }).first().click()
  await page.getByText('Edit chore').waitFor({ timeout: 8000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/phone-3b-editform.png` })
  await ctx.close()
}

// ── Tablet shots (landscape, 2560x1600) ──────────────────────────────────────
{
  const { ctx, page } = await loadSeeded(browser, { width: 1280, height: 800, dsf: 2 })
  await page.screenshot({ path: `${OUT}/tablet-1-dashboard.png` })

  await page.getByRole('button', { name: /Morning workout/ }).first().click()
  await page.getByText('Past year').waitFor({ timeout: 10000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/tablet-2-detail.png` })
  await ctx.close()
}

await browser.close()
console.log('Screenshots written to', OUT)
