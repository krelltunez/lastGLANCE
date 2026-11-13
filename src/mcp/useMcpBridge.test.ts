import { describe, expect, it, vi } from 'vitest'
import { answerMcpRequest } from './useMcpBridge'
import { fixtureData } from './readModel.fixture'

describe("the page's MCP answers", () => {
  it('answers through the read model with the request id, loading People only when the method reads them', async () => {
    const load = vi.fn(async () => fixtureData())
    await expect(answerMcpRequest({ id: 7, method: 'list_categories', params: {} }, { load })).resolves.toMatchObject({ id: 7, ok: true })
    expect(load).toHaveBeenLastCalledWith(false)
    await answerMcpRequest({ id: 8, method: 'list_people' }, { load })
    expect(load).toHaveBeenLastCalledWith(true)
  })

  it('answers a ping without reading anything', async () => {
    const load = vi.fn(async () => fixtureData())
    await expect(answerMcpRequest({ id: 1, method: 'ping' }, { load })).resolves.toEqual({ id: 1, ok: true, data: { ok: true } })
    expect(load).not.toHaveBeenCalled()
  })

  it('answers a failed read as internal, so it never looks like a window that stopped answering', async () => {
    const load = vi.fn(async () => { throw new Error('IndexedDB is closed') })
    await expect(answerMcpRequest({ id: 3, method: 'overview' }, { load }))
      .resolves.toEqual({ id: 3, ok: false, error: { code: 'internal', message: 'IndexedDB is closed' } })
  })

  it('sends a write to the write model, with its undo record beside the data', async () => {
    const write = vi.fn(async () => ({ ok: true as const, data: { chore: { id: 'c' } }, undo: { summary: 'Created “c”', op: { kind: 'remove_created_chore' as const, choreId: 'c' } } }))
    await expect(answerMcpRequest({ id: 4, method: 'create_chore', params: { name: 'c' } }, { write }))
      .resolves.toEqual({ id: 4, ok: true, data: { chore: { id: 'c' } }, undo: { summary: 'Created “c”', op: { kind: 'remove_created_chore', choreId: 'c' } } })
    expect(write).toHaveBeenCalledWith('create_chore', { name: 'c' })
    await expect(answerMcpRequest({ id: 5, method: 'create_chore' }, {})).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
  })

  it('ignores anything that is not a request', async () => {
    for (const raw of [null, {}, { id: '1', method: 'overview' }, { id: 1 }]) {
      await expect(answerMcpRequest(raw, { load: async () => fixtureData() })).resolves.toBeNull()
    }
  })
})
