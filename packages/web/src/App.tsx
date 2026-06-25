import { AuthGate } from './components/AuthGate.js'
import { StoreProvider } from './state/store.js'
import { Shell } from './components/Shell.js'

export function App() {
  return (
    <AuthGate>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </AuthGate>
  )
}
