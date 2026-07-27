import React from 'react'
import { AppShell } from './components/layout/AppShell'
import { Toaster } from './components/ui/Toast'

function App(): React.JSX.Element {
  return (
    <>
      <AppShell />
      <Toaster />
    </>
  )
}

export default App
