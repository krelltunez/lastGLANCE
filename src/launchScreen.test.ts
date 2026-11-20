import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import sharp from 'sharp'

/**
 * Cold open, from the launch screen to the app's first frame. CI cannot launch
 * the app, so this holds the pieces to each other:
 *
 *   launch screen (Splash, light and dark)  →  web view background before the
 *   page paints (LaunchBackground)  →  the page's first frame (theme-init.js)
 *
 * The middle step was Capacitor's systemBackground, white in light mode: the
 * white flash between the dark launch screen and the app.
 */
const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const ASSETS = 'ios/App/App/Assets.xcassets'

type Rgb = [number, number, number]
const hex = (c: Rgb) => '#' + c.map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')

async function cornerOf(path: string): Promise<string> {
  const { data } = await sharp(join(root, path)).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true })
  return hex([data[0], data[1], data[2]])
}

function launchBackground(): { light: string; dark: string } {
  const json = JSON.parse(read(`${ASSETS}/LaunchBackground.colorset/Contents.json`))
  const toHex = (c: { components: Record<string, string> }) =>
    hex(['red', 'green', 'blue'].map((k) => Number(c.components[k])) as Rgb)
  const any = json.colors.filter((c: { appearances?: unknown }) => !c.appearances)
  const dark = json.colors.filter((c: { appearances?: { value: string }[] }) => c.appearances?.some((a) => a.value === 'dark'))
  expect(any).toHaveLength(1)
  expect(dark).toHaveLength(1)
  return { light: toHex(any[0].color), dark: toHex(dark[0].color) }
}

describe('cold open: launch screen → web view → first frame', () => {
  it('paints the web view in the launch colour before the page loads', () => {
    const swift = read('ios/App/App/BridgeViewController.swift').replace(/\/\/.*$/gm, '')
    // First thing capacitorDidLoad does, so it happens before the page loads.
    expect(swift).toMatch(/override open func capacitorDidLoad\(\) \{\s*paintLaunchBackground\(\)/)
    const paint = swift.slice(swift.indexOf('func paintLaunchBackground'))
    expect(paint).toContain('UIColor(named: "LaunchBackground")')
    for (const line of ['webView?.isOpaque = false', 'webView?.backgroundColor = launch', 'webView?.scrollView.backgroundColor = launch']) {
      expect(paint).toContain(line)
    }
  })

  it('LaunchBackground is the light theme background in light mode and the splash navy in dark', async () => {
    const { light, dark } = launchBackground()
    expect(light).toBe('#F8FAFC') // Tailwind slate-50, src/index.css body background
    expect(dark).toBe(await cornerOf('assets/splash-dark.png'))
  })

  it('the Splash images follow the appearance, each matching LaunchBackground', async () => {
    const { light, dark } = launchBackground()
    for (const n of [1, 2, 3]) {
      expect(await cornerOf(`${ASSETS}/Splash.imageset/Default@${n}x~universal~anyany.png`)).toBe(light)
      expect(await cornerOf(`${ASSETS}/Splash.imageset/Default@${n}x~universal~anyany-dark.png`)).toBe(dark)
    }
    // The asset generator's sources agree, so re-running it keeps both.
    expect(await cornerOf('assets/splash.png')).toBe(light)
    expect(await cornerOf('assets/splash-dark.png')).toBe(dark)
  })

  it('loads the theme script from <head>, as a file (the CSP allows no inline script)', () => {
    const html = read('index.html')
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toContain('<script src="/theme-init.js"></script>')
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('/src/main.tsx'))
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)/)
  })

  describe('theme-init.js decides the first frame by the rule App.tsx applies after', () => {
    const script = read('public/theme-init.js')
    const firstFrame = (saved: string | null, osDark: boolean, broken = false) => {
      const classes = new Set<string>()
      runInNewContext(script, {
        localStorage: { getItem: (k: string) => { if (broken) throw new Error('no storage'); return k === 'theme' ? saved : null } },
        window: { matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && osDark }) },
        document: { documentElement: { classList: { add: (c: string) => classes.add(c) } } },
      })
      return classes.has('dark') ? 'dark' : 'light'
    }

    it.each([
      ['dark', false, 'dark'],
      ['dark', true, 'dark'],
      ['light', true, 'light'],
      ['light', false, 'light'],
      ['system', true, 'dark'],
      ['system', false, 'light'],
      [null, true, 'dark'],
      [null, false, 'light'],
    ] as const)('saved %s, OS dark %s → %s', (saved, osDark, expected) => {
      expect(firstFrame(saved, osDark)).toBe(expected)
    })

    it('fails quietly when storage is unavailable', () => {
      expect(() => firstFrame(null, true, true)).not.toThrow()
    })

    // The same rule as App.tsx's, which takes over once React mounts.
    it('reads the key App.tsx stores', () => {
      expect(read('src/App.tsx')).toMatch(/localStorage\.getItem\('theme'\)/)
    })
  })
})
