import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { WebErrorBoundary } from './components/startup/WebErrorBoundary.tsx'
import { validateEndpointConfig } from './lib/platform-endpoints.js'
import 'xterm/css/xterm.css' // Import xterm.css for terminal styling

validateEndpointConfig()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebErrorBoundary>
      <App />
    </WebErrorBoundary>
  </StrictMode>,
)
