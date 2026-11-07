// The PWA service worker is for the browser only. In the native shells the
// bundle ships inside the app, and a worker there serves the precache of the
// build that installed it, which after a store update is the previous version.
//
// "Native shell" covers two WebViews: the Capacitor app, and Android's headless
// refresh (LauncherRefreshWorker), which loads the same bundle at the same
// origin with no Capacitor bridge, so Capacitor reports the web platform there.
// Until 3.0.1 the headless page took the browser branch and registered the
// worker, and the app's next start after a Play update was served the old
// bundle by it. That bundle then deleted the worker's caches while its own lazy
// chunks were still loading from them, fetched `App-<old hash>.js` from the
// new APK, got a 404 and rendered nothing until the app was swiped away.
//
// So a shell page never registers a worker, and it removes one an earlier build
// left. A page the worker did NOT serve has nothing in flight from its caches,
// so it deletes them. A page the worker DID serve may be the old bundle, and it
// is still loading from those caches: it leaves them, unregisters the worker and
// loads again, this time from the installed files. The reload happens once per
// session at most, so a worker that will not go away still lets the page boot.

export const SW_RELOAD_KEY = 'lastglance.swReloaded'

type Session = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ServiceWorkerEnv {
  /** The Capacitor app, or the headless refresh WebView. */
  shell: boolean
  container: ServiceWorkerContainer | undefined
  caches: CacheStorage | undefined
  session: Session | undefined
  reload: () => void
  /** Runs fn once the page has loaded (window 'load'). */
  onLoad: (fn: () => void) => void
}

const attempt = <T>(fn: () => T): T | undefined => {
  try {
    return fn()
  } catch {
    return undefined
  }
}

const deleteWorkboxCaches = (cacheStorage: CacheStorage | undefined): Promise<unknown> =>
  cacheStorage
    ? cacheStorage.keys()
        .then(keys => Promise.all(keys.filter(k => k.startsWith('workbox-')).map(k => cacheStorage.delete(k))))
        .catch(() => {})
    : Promise.resolve()

/**
 * Registers the worker in the browser, or retires it in a native shell.
 * Resolves true when the page should boot, false when it is reloading.
 */
export async function settleServiceWorker(env: ServiceWorkerEnv): Promise<boolean> {
  const sw = env.container
  if (!sw) return true

  if (!env.shell) {
    env.onLoad(() => {
      sw.register('/sw.js', { scope: '/' }).catch(() => {})
    })
    return true
  }

  const unregistered = sw.getRegistrations()
    .then(regs => Promise.all(regs.map(r => r.unregister())))
    .then(() => true, () => false)

  if (!sw.controller) {
    attempt(() => env.session?.removeItem(SW_RELOAD_KEY))
    void unregistered.then(() => deleteWorkboxCaches(env.caches))
    return true
  }

  // Served by a worker. Reloaded once already this session and still served
  // by one: boot on what it serves rather than loop.
  if (attempt(() => env.session?.getItem(SW_RELOAD_KEY))) return true
  if (!(await unregistered)) return true
  attempt(() => env.session?.setItem(SW_RELOAD_KEY, '1'))
  env.reload()
  return false
}
