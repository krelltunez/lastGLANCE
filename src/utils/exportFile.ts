import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { isNativePlatform } from '@/sync/nativeHttp'
import { desktopBridge } from '@/native/desktop'

function anchorDownload(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// Hand a text export to the user. On the web a plain anchor download works;
// inside the Android WebView that is a silent no-op (no DownloadListener is
// installed), so on native the file is written to the app cache and offered
// through the system share sheet instead (issue #233).
export async function saveTextFile(filename: string, text: string, mimeType: string): Promise<void> {
  // The desktop app: the native save dialog (electron/files.ts). Cancelling
  // it is a user choice, as dismissing the phones' share sheet is.
  const desktop = desktopBridge()
  if (desktop) {
    await desktop.files.saveText({ filename, text })
    return
  }
  if (!isNativePlatform) {
    anchorDownload(filename, text, mimeType)
    return
  }
  const written = await Filesystem.writeFile({
    path: filename,
    data: text,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  })
  try {
    await Share.share({ title: filename, files: [written.uri] })
  } catch (err) {
    // Dismissing the share sheet rejects; that is a user choice, not a failure.
    if (err instanceof Error && /cancel/i.test(err.message)) return
    throw err
  }
}

export function saveJsonFile(filename: string, json: string): Promise<void> {
  return saveTextFile(filename, json, 'application/json')
}

export function saveCsvFile(filename: string, csv: string): Promise<void> {
  return saveTextFile(filename, csv, 'text/csv')
}

// Silently stash a JSON snapshot without any user interaction — used for the
// pre-restore parachute. On the web this is the same anchor download as before;
// on native it writes to app-private storage (public folders need a picker or
// permissions on modern Android, and a share sheet mid-restore would be
// disruptive). The copy is not user-browsable there, but it exists for
// recovery, alongside the remote parachute when sync is configured.
export async function stashJsonFile(filename: string, json: string): Promise<void> {
  // The desktop app keeps it in its own backups folder, with no dialog.
  const desktop = desktopBridge()
  if (desktop) {
    await desktop.files.stash({ filename, text: json })
    return
  }
  if (!isNativePlatform) {
    anchorDownload(filename, json, 'application/json')
    return
  }
  await Filesystem.writeFile({
    path: `snapshots/${filename}`,
    data: json,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
  })
}
