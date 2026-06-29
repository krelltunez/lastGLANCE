import { describe, it, expect, vi, beforeEach } from 'vitest'

// Native-wiring test mocks the vault client + native HTTP so we can assert the
// probe builds the client with the native-safe fetch adapter. The outcome tests
// below inject getSalt directly and never touch these mocks.
const createVaultClientMock = vi.fn()
vi.mock('@glance-apps/sync', () => ({
  createVaultClient: (cfg: unknown) => createVaultClientMock(cfg),
}))

const nativeHttpFetchMock = vi.fn(
  async (method: string, url: string, headers: Record<string, string>, body: string | null) => ({
    status: 200,
    ok: true,
    statusText: '',
    // Echo the request so the test can assert the (method, url, headers, body)
    // shape reached CapacitorHttp; also keeps every param genuinely used.
    body: JSON.stringify({ salt: 'AAAA', request: { method, url, headers, body } }),
  }),
)
// isNativePlatform is a const binding; mock the module so the probe sees `true`.
vi.mock('@/sync/nativeHttp', () => ({
  isNativePlatform: true,
  nativeHttpFetch: (...args: Parameters<typeof nativeHttpFetchMock>) => nativeHttpFetchMock(...args),
}))

import { testVaultConnection, classifyVaultTestError } from './testVaultConnection'

const INPUT = { vaultUrl: 'https://vault.example.com', vaultToken: 'tok', accountId: 'acct-1' }

beforeEach(() => {
  createVaultClientMock.mockReset()
  nativeHttpFetchMock.mockClear()
})

describe('testVaultConnection — typed outcomes (getSalt mocked)', () => {
  it('SUCCESS: a registered salt -> ok, salt present', async () => {
    const getSalt = vi.fn(async () => new Uint8Array(16).fill(7))
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: true, code: null, salt: true })
    expect(getSalt).toHaveBeenCalledWith('acct-1')
  })

  it('SALT-NOT-ESTABLISHED: getSalt null (404) -> ok + ACCOUNT_ID_REQUIRED, NOT an error', async () => {
    const getSalt = vi.fn(async () => null)
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: true, code: 'ACCOUNT_ID_REQUIRED', salt: false })
  })

  it('SALT-NOT-ESTABLISHED: an empty salt is also treated as fresh (acceptable)', async () => {
    const getSalt = vi.fn(async () => new Uint8Array(0))
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: true, code: 'ACCOUNT_ID_REQUIRED', salt: false })
  })

  it('AUTH FAILURE: getSalt throws with status 401 -> AUTH_FAILURE', async () => {
    const getSalt = vi.fn(async () => { throw Object.assign(new Error('get salt failed: 401'), { status: 401 }) })
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: false, code: 'AUTH_FAILURE' })
  })

  it('FORBIDDEN: getSalt throws with status 403 -> FORBIDDEN', async () => {
    const getSalt = vi.fn(async () => { throw Object.assign(new Error('get salt failed: 403'), { status: 403 }) })
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: false, code: 'FORBIDDEN' })
  })

  it('NETWORK: getSalt rejects with no status (bad URL / unreachable) -> NETWORK_ERROR', async () => {
    const getSalt = vi.fn(async () => { throw new TypeError('Failed to fetch') })
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: false, code: 'NETWORK_ERROR' })
  })

  it('NETWORK: any other non-2xx (e.g. 500) falls back to NETWORK_ERROR', async () => {
    const getSalt = vi.fn(async () => { throw Object.assign(new Error('get salt failed: 500'), { status: 500 }) })
    const r = await testVaultConnection(INPUT, getSalt)
    expect(r).toEqual({ ok: false, code: 'NETWORK_ERROR' })
  })

  it('never throws — a rejection is always converted to a typed outcome', async () => {
    const getSalt = vi.fn(async () => { throw 'weird-non-error' })
    await expect(testVaultConnection(INPUT, getSalt)).resolves.toEqual({ ok: false, code: 'NETWORK_ERROR' })
  })
})

describe('classifyVaultTestError (pure)', () => {
  it('401 -> AUTH_FAILURE', () => {
    expect(classifyVaultTestError({ status: 401 })).toEqual({ ok: false, code: 'AUTH_FAILURE' })
  })
  it('403 -> FORBIDDEN', () => {
    expect(classifyVaultTestError({ status: 403 })).toEqual({ ok: false, code: 'FORBIDDEN' })
  })
  it('no status -> NETWORK_ERROR', () => {
    expect(classifyVaultTestError(new Error('boom'))).toEqual({ ok: false, code: 'NETWORK_ERROR' })
  })
})

describe('native wiring — reaches the vault via vaultFetchImpl, not a plain fetch', () => {
  it('builds the client with a native-safe fetchImpl that routes through nativeHttpFetch', async () => {
    // Capture the config the probe passes to createVaultClient, and have the
    // client resolve getSalt by calling that injected fetchImpl (proving the
    // probe wired it). The fetchImpl must hit nativeHttpFetch on native.
    let capturedFetch: typeof fetch | undefined
    createVaultClientMock.mockImplementation((cfg: { fetchImpl?: typeof fetch }) => {
      capturedFetch = cfg.fetchImpl
      return {
        async getSalt(accountId: string) {
          // Exercise the adapter exactly like the real client would.
          const res = await cfg.fetchImpl!(`https://vault.example.com/salt/${accountId}`, { method: 'GET', headers: {} })
          const body = await (res as Response).json()
          return body.salt ? new Uint8Array([0, 0, 0]) : null
        },
      }
    })

    const r = await testVaultConnection(INPUT) // no injected getSalt -> real defaultGetSalt path

    expect(createVaultClientMock).toHaveBeenCalledTimes(1)
    expect(capturedFetch).toBeTypeOf('function') // native-safe adapter injected, NOT undefined
    expect(nativeHttpFetchMock).toHaveBeenCalledTimes(1) // request went through CapacitorHttp bridge
    expect(nativeHttpFetchMock.mock.calls[0][0]).toBe('GET') // (method, url, headers, body) shape
    expect(nativeHttpFetchMock.mock.calls[0][1]).toBe('https://vault.example.com/salt/acct-1')
    expect(r).toEqual({ ok: true, code: null, salt: true })
  })
})
