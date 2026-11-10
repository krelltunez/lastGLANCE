import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function desktop() {
  const files = { saveText: vi.fn(async () => ({ saved: true })), stash: vi.fn(async () => {}) }
  vi.stubGlobal('window', {
    lastGlanceDesktop: {
      info: { platform: 'darwin', version: '3.0.1', isMAS: false, secureStorage: true },
      shell: { setMenuLabels: () => {}, setTheme: () => {}, exitFullscreen: () => {} },
      files,
    },
  })
  return files
}

describe('exports on the desktop', () => {
  it('saves through the native save dialog', async () => {
    const files = desktop()
    const { saveCsvFile } = await import('./exportFile')
    await saveCsvFile('lastglance-journal.csv', 'a,b\n1,2')
    expect(files.saveText).toHaveBeenCalledWith({ filename: 'lastglance-journal.csv', text: 'a,b\n1,2' })
  })

  it('stashes the pre-restore copy silently, without a dialog', async () => {
    const files = desktop()
    const { stashJsonFile } = await import('./exportFile')
    await stashJsonFile('lastglance-before-restore.json', '{"v":1}')
    expect(files.stash).toHaveBeenCalledWith({ filename: 'lastglance-before-restore.json', text: '{"v":1}' })
    expect(files.saveText).not.toHaveBeenCalled()
  })
})
