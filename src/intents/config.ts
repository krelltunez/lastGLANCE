export interface IntentsConfig {
  enabled: boolean
  webdavUrl: string
  webdavUsername: string
  webdavPassword: string
  folderPath: string
  pollIntervalMinutes: number
  encryptionEnabled: boolean
}

export interface ActivityEntry {
  id: string
  timestamp: string
  type: 'sent' | 'received' | 'error'
  message: string
  detail?: string
}

export const DEFAULT_CONFIG: IntentsConfig = {
  enabled: false,
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  folderPath: 'GLANCE/events',
  pollIntervalMinutes: 15,
  encryptionEnabled: false,
}

const CONFIG_KEY = 'lg_intents_config'
const ACTIVITY_KEY = 'lg_intents_activity'
const CURSOR_KEY = 'lg_intents_cursor'
const MAX_ACTIVITY = 50

export function getIntentsConfig(): IntentsConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveIntentsConfig(config: IntentsConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

export function isIntentsConfigured(config: IntentsConfig): boolean {
  return config.enabled && Boolean(config.webdavUrl) && Boolean(config.webdavUsername) && Boolean(config.webdavPassword)
}

export function getActivityLog(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY)
    if (!raw) return []
    return JSON.parse(raw) as ActivityEntry[]
  } catch {
    return []
  }
}

export function addActivityEntry(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
  const log = getActivityLog()
  const newEntry: ActivityEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  }
  const updated = [newEntry, ...log].slice(0, MAX_ACTIVITY)
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(updated))
}

export function clearActivityLog(): void {
  localStorage.removeItem(ACTIVITY_KEY)
}

export function getPollingCursor(): string | null {
  return localStorage.getItem(CURSOR_KEY)
}

export function setPollingCursor(timestamp: string): void {
  localStorage.setItem(CURSOR_KEY, timestamp)
}
