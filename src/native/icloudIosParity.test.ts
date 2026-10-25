import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The iOS shell is not compiled in CI, so this holds ICloudPlugin.swift to the
// bridge in src/native/icloud.ts (every method registered and implemented),
// to the containers the transports name, and to the entitlements and the
// Xcode project that make the plugin exist at all.

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const swift = read('ios/App/App/plugins/ICloudPlugin.swift')
const ts = read('src/native/icloud.ts')

function tsPluginMethods(): string[] {
  const body = ts.slice(ts.indexOf('export interface ICloudPluginType {'))
  const block = body.slice(0, body.indexOf('\n}'))
  return [...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).filter((m) => m !== 'addListener')
}

function swiftRegistered(): string[] {
  const start = swift.indexOf('public let pluginMethods')
  const block = swift.slice(start, swift.indexOf('].map', start))
  return [...block.matchAll(/"(\w+)"/g)].map((m) => m[1])
}

describe('ICloudPlugin.swift matches the bridge', () => {
  it('registers exactly the methods the bridge calls', () => {
    expect(swiftRegistered().sort()).toEqual(tsPluginMethods().sort())
  })

  it('implements every method it registers', () => {
    const missing = swiftRegistered().filter((m) => !new RegExp(`@objc func ${m}\\(`).test(swift))
    expect(missing).toEqual([])
  })

  it('is the "ICloud" plugin the bridge registers, and posts the event it listens for', () => {
    expect(swift).toContain('public let jsName = "ICloud"')
    expect(ts).toContain("registerPlugin<ICloudPluginType>('ICloud')")
    expect(swift).toContain('notifyListeners("changed"')
  })

  it('knows both containers the transports name, under the identifiers the entitlements grant', () => {
    expect(swift).toContain('"own": "iCloud.com.lastglance"')
    expect(swift).toContain('"dayglance": "iCloud.com.dayglance"')
    expect(ts).toContain("export type ICloudContainer = 'own' | 'dayglance'")
  })

  it('watches the two sync files the transport writes', () => {
    expect(swift).toContain('static let watchedFiles = ["lastglance-sync.json", "lastglance-people.json"]')
  })
})

describe('the app can reach iCloud', () => {
  it('the entitlements grant iCloud Documents on both containers', () => {
    const ent = read('ios/App/App/App.entitlements')
    for (const key of ['com.apple.developer.icloud-container-identifiers', 'com.apple.developer.ubiquity-container-identifiers']) {
      const block = ent.slice(ent.indexOf(`<key>${key}</key>`), ent.indexOf('</array>', ent.indexOf(`<key>${key}</key>`)))
      expect(block).toContain('<string>iCloud.com.lastglance</string>')
      expect(block).toContain('<string>iCloud.com.dayglance</string>')
    }
    expect(ent).toMatch(/<key>com\.apple\.developer\.icloud-services<\/key>\s*<array>\s*<string>CloudDocuments<\/string>/)
  })

  it('the plugin is registered and compiled into the app target', () => {
    expect(read('ios/App/App/BridgeViewController.swift')).toContain('registerPluginInstance(ICloudPlugin())')
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj')
    expect(pbx).toMatch(/ICloudPlugin\.swift in Sources \*\/ = \{isa = PBXBuildFile/)
    expect(pbx).toMatch(/ICloudPlugin\.swift \*\/ = \{isa = PBXFileReference/)
    expect((pbx.match(/ICloudPlugin\.swift in Sources \*\/,/g) ?? []).length).toBe(1)
  })
})
