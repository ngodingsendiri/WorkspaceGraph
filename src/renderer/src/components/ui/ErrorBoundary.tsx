/**
 * Catches render crashes so the window is never a silent blank screen.
 */
import React from 'react'

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  State
> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', this.props.label || 'app', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      const label = this.props.label || 'WorkspaceGraph'
      return (
        <div
          style={{
            padding: 24,
            fontFamily: "Inter, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif",
            color: '#e8e8ec',
            background: '#1a1a1e',
            height: '100%',
            overflow: 'auto',
            boxSizing: 'border-box'
          }}
        >
          <h1 style={{ fontSize: 18, margin: '0 0 12px' }}>{label} crash</h1>
          <p style={{ opacity: 0.8, marginBottom: 12 }}>
            UI gagal render. Salin error di bawah (DevTools: Ctrl+Shift+I).
          </p>
          <pre
            style={{
              background: '#111',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              border: '1px solid #333'
            }}
          >
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #555',
                background: '#2a2a30',
                color: '#fff',
                cursor: 'pointer'
              }}
              onClick={() => this.setState({ error: null })}
            >
              Coba lagi
            </button>
            <button
              type="button"
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid #555',
                background: '#2a2a30',
                color: '#fff',
                cursor: 'pointer'
              }}
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
