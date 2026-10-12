import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@vscode/codicons/dist/codicon.css'
import './styles/app.css'
import { App } from './App'
import { ConsoleApp } from './ConsoleApp'
import { ErrorBoundary } from './components/ErrorBoundary'

// The same page is the developer console's window when opened with #console (#637).
const isConsole = location.hash === '#console'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label={isConsole ? 'Developer Console' : 'Hive'} root>
      {isConsole ? <ConsoleApp /> : <App />}
    </ErrorBoundary>
  </StrictMode>
)
