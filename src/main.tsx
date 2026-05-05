import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Apply theme before first render to avoid flash
const stored = localStorage.getItem('theme')
document.documentElement.classList.toggle('dark', stored !== 'light')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
