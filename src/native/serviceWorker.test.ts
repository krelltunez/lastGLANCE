import { describe, it, expect, vi } from 'vitest'
import { SW_RELOAD_KEY, settleServiceWorker, type ServiceWorkerEnv } from './serviceWorker'

const flush = () => new Promise(r => setTimeout(r, 0))

function setup(opts: { shell: boolean; controlled?: boolean; unregisterFails?: boolean; reloaded?: boolean }) {
  const unregister = vi.fn(async () => true)
  const container = {
    controller: opts.controlled ? ({} as ServiceWorker) : null,
    register: vi.fn(async () => ({})),
    getRegistrations: vi.fn(async () => {
      if (opts.unregisterFails) throw new Error('no')
      return [{ unregister }, { unregister }]
    }),
  }
  const cacheNames = ['workbox-precache-v2-https://localhost/', 'workbox-runtime', 'other']
  const caches = {
    keys: vi.fn(async () => cacheNames),
    delete: vi.fn<(name: string) => Promise<boolean>>(async () => true),
  }
  const store = new Map<string, string>(opts.reloaded ? [[SW_RELOAD_KEY, '1']] : [])
  const session = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
  const loadHandlers: Array<() => void> = []
  const env: ServiceWorkerEnv = {
    shell: opts.shell,
    container: container as unknown as ServiceWorkerContainer,
    caches: caches as unknown as CacheStorage,
    session,
    reload: vi.fn(),
    onLoad: fn => void loadHandlers.push(fn),
  }
  return { env, container, caches, unregister, store, loadHandlers }
}

describe('settleServiceWorker', () => {
  it('boots with no service worker support', async () => {
    const { env } = setup({ shell: true })
    expect(await settleServiceWorker({ ...env, container: undefined })).toBe(true)
  })

  it('registers the worker on load in the browser', async () => {
    const { env, container, loadHandlers } = setup({ shell: false })
    expect(await settleServiceWorker(env)).toBe(true)
    expect(container.register).not.toHaveBeenCalled()
    loadHandlers.forEach(fn => fn())
    expect(container.register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    expect(container.getRegistrations).not.toHaveBeenCalled()
  })

  it('in a shell page no worker served: unregisters, deletes only the workbox caches, boots', async () => {
    const { env, container, caches, unregister, store } = setup({ shell: true, reloaded: true })
    expect(await settleServiceWorker(env)).toBe(true)
    await flush()
    expect(container.register).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledTimes(2)
    expect(caches.delete.mock.calls.map(c => c[0])).toEqual(['workbox-precache-v2-https://localhost/', 'workbox-runtime'])
    expect(env.reload).not.toHaveBeenCalled()
    expect(store.has(SW_RELOAD_KEY)).toBe(false)
  })

  // The blank first launch after a Play update: the worker a headless refresh
  // registered served the previous bundle, which must not delete the caches
  // its own chunks are still loading from.
  it('in a shell page a worker served: keeps the caches, unregisters, reloads instead of booting', async () => {
    const { env, caches, unregister, store } = setup({ shell: true, controlled: true })
    expect(await settleServiceWorker(env)).toBe(false)
    await flush()
    expect(unregister).toHaveBeenCalledTimes(2)
    expect(caches.delete).not.toHaveBeenCalled()
    expect(env.reload).toHaveBeenCalledTimes(1)
    expect(store.get(SW_RELOAD_KEY)).toBe('1')
  })

  it('boots rather than reloading twice in a session', async () => {
    const { env, caches } = setup({ shell: true, controlled: true, reloaded: true })
    expect(await settleServiceWorker(env)).toBe(true)
    await flush()
    expect(env.reload).not.toHaveBeenCalled()
    expect(caches.delete).not.toHaveBeenCalled()
  })

  it('boots when the worker cannot be unregistered', async () => {
    const { env } = setup({ shell: true, controlled: true, unregisterFails: true })
    expect(await settleServiceWorker(env)).toBe(true)
    expect(env.reload).not.toHaveBeenCalled()
  })

  it('boots when session storage throws', async () => {
    const { env } = setup({ shell: true, controlled: true })
    const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }
    expect(await settleServiceWorker({ ...env, session: throwing })).toBe(false)
    expect(env.reload).toHaveBeenCalledTimes(1)
  })
})
