import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@vscode/codicons/dist/codicon.css'
import './styles/app.css'
import { App } from './App'
import { ConsoleApp } from './ConsoleApp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initLanguage } from './i18n'
import { msg, tr } from '@shared/i18n'

// The same page is the developer console's window when opened with #console (#637).
const isConsole = location.hash === '#console'

// The language first, so the first render is in it (#767).
await initLanguage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label={isConsole ? () => tr(msg({ id: 'shell.view.devConsole', defaultMessage: 'The developer console', description: 'Names the developer console\'s window when it fails to show ("The developer console ran into a problem…").' })) : 'Hive' /* i18n-ignore: the app's name */} root>
      {isConsole ? <ConsoleApp /> : <App />}
    </ErrorBoundary>
  </StrictMode>
)
