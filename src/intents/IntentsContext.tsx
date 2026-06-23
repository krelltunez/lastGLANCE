import { createContext, useContext, useState } from 'react'
import { getIntentsConfig, isIntentsConfigured, type IntentsConfig } from './config'
import { isDbIntentsEnabled } from './dbConfig'

interface IntentsContextValue {
  isConfigured: boolean
  config: IntentsConfig
  refreshConfig: () => void
}

const IntentsContext = createContext<IntentsContextValue | null>(null)

export function IntentsProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<IntentsConfig>(() => getIntentsConfig())

  function refreshConfig() {
    setConfig(getIntentsConfig())
  }

  // Intents are "configured" (so the send-to-dayGLANCE buttons show) when ANY
  // transport is enabled: the WebDAV intents config above, OR the GLANCEvault DB
  // intents transport. Gating on WebDAV alone hid the buttons for vault-only
  // setups. Mirrors enabledIntentTargets() in the emitter.
  const isConfigured = isIntentsConfigured(config) || isDbIntentsEnabled()

  return (
    <IntentsContext.Provider value={{ isConfigured, config, refreshConfig }}>
      {children}
    </IntentsContext.Provider>
  )
}

export function useIntents(): IntentsContextValue {
  const ctx = useContext(IntentsContext)
  if (!ctx) throw new Error('useIntents must be used inside IntentsProvider')
  return ctx
}
