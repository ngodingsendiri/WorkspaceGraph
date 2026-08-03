import React from 'react'
import { AppShell } from './components/layout/AppShell'
import { Toaster } from './components/ui/Toast'
import { DialogHost } from './components/ui/Dialog'

function App(): React.JSX.Element {
  return (
    <>
      <AppShell />
      <Toaster />
      <DialogHost />
    </>
  )
}

export default App
