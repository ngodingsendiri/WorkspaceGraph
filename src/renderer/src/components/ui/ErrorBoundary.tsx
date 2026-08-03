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
          className="error-boundary"
          style={{
            padding: 24,
            fontFamily: 'var(--font-sans)',
            color: 'var(--text-primary)',
            background: 'var(--bg-app)',
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
              background: 'var(--bg-input)',
              padding: 12,
              borderRadius: 8,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              border: '1px solid var(--border-default)',
              color: 'var(--text-secondary)'
            }}
          >
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-surface btn-sm"
              onClick={() => this.setState({ error: null })}
            >
              Coba lagi
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
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
