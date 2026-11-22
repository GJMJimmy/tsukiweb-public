import { createRoot } from 'react-dom/client'
import App from './components/App'
import { StrictMode } from 'react'
import { mountDialogManager } from '@tsukiweb/common/ui-core/components/ModalPrompt'
import { initFileHandling, registerFileHandler } from '@tsukiweb/common/utils/pwa-file-handlers'
import { importGameDataFromFile } from 'engine/pwa-file-handler';
import { registerOfflineWorker } from 'offline/register';
import { FULLSAVE_EXT } from './utils/constants';
import { StringsProvider } from 'translation/lang'
import { ErrorBoundary } from 'react-error-boundary';
import PageCrash from './screens/CrashScreen';
import { installErrorOverlay } from './utils/errorOverlay';
import { installDiagnostics } from './utils/diagnostics';

// Show uncaught errors and rejected promises on screen (see utils/errorOverlay)
installErrorOverlay()
installDiagnostics() // ?diag=1 renders an on-screen environment report

mountDialogManager()

//PWA File Handling
registerFileHandler(FULLSAVE_EXT, importGameDataFromFile)
initFileHandling()

//Offline assets (service worker + IndexedDB), fire and forget
void registerOfflineWorker()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary FallbackComponent={PageCrash}>
      <StringsProvider>
        <App />
      </StringsProvider>
    </ErrorBoundary>
  </StrictMode>
)