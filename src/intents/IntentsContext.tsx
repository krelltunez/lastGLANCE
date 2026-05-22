import { createContext, useContext, useState } from 'react'
import { getIntentsConfig, isIntentsConfigured, type IntentsConfig } from './config'

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

  const isConfigured = isIntentsConfigured(config)

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
