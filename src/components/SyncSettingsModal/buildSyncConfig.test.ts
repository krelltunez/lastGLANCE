import { describe, it, expect } from 'vitest'
import { buildSyncConfigToSave } from './buildSyncConfig'

// Mirrors the WebDAV provider's required fields.
const WEBDAV_FIELDS = [{ key: 'webdavUrl' }, { key: 'username' }, { key: 'appPassword' }]

const filled = { webdavUrl: 'https://dav.example.com', username: 'user', appPassword: 'pass' }

describe('buildSyncConfigToSave (issue #204: cannot disable WebDAV sync)', () => {
  it('persists enabled:false when disabling with all fields filled (does not drop the config)', () => {
    const cfg = buildSyncConfigToSave({
      provider: 'webdav', formData: filled, configFields: WEBDAV_FIELDS,
      folderPath: 'GLANCE/lastglance', syncEnabled: false, encEnabled: false,
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.enabled).toBe(false)
    expect(cfg!.appPassword).toBe('pass') // credentials preserved
  })

  it('keeps the config (enabled:false) when disabling even if a required field is blank', () => {
    // The exact bug: a blank required field used to null the whole config, which
    // reset the toggle back to on and wiped credentials on the next open.
    const cfg = buildSyncConfigToSave({
      provider: 'webdav', formData: { ...filled, appPassword: '' }, configFields: WEBDAV_FIELDS,
      folderPath: 'GLANCE/lastglance', syncEnabled: false, encEnabled: false,
    })
    expect(cfg).not.toBeNull()
    expect(cfg!.enabled).toBe(false)
    expect(cfg!.webdavUrl).toBe('https://dav.example.com')
  })

  it('saves enabled:true with the full config when sync is on and fields are filled', () => {
    const cfg = buildSyncConfigToSave({
      provider: 'webdav', formData: filled, configFields: WEBDAV_FIELDS,
      folderPath: 'GLANCE/lastglance', syncEnabled: true, encEnabled: true,
    })
    expect(cfg).toMatchObject({
      provider: 'webdav', webdavUrl: 'https://dav.example.com', username: 'user',
      appPassword: 'pass', syncFolder: 'GLANCE/lastglance', enabled: true, encryptionEnabled: true,
    })
  })

  it('clears the config (null) only when every field is blank', () => {
    const cfg = buildSyncConfigToSave({
      provider: 'webdav', formData: { webdavUrl: '', username: '', appPassword: '' }, configFields: WEBDAV_FIELDS,
      folderPath: 'GLANCE/lastglance', syncEnabled: false, encEnabled: false,
    })
    expect(cfg).toBeNull()
  })

  it('treats whitespace-only fields as empty', () => {
    const cfg = buildSyncConfigToSave({
      provider: 'webdav', formData: { webdavUrl: '   ', username: '', appPassword: '' }, configFields: WEBDAV_FIELDS,
      folderPath: 'GLANCE/lastglance', syncEnabled: true, encEnabled: false,
    })
    expect(cfg).toBeNull()
  })
})
