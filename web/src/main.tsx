import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './i18n/index.ts'
import './index.css'
import App from './App.tsx'

// immediate: the worker registers without waiting for the load event, so a
// first visit that goes offline seconds later is already precached.
registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
