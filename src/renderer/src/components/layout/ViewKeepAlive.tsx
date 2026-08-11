import React from 'react'

interface ViewKeepAliveProps {
  /** True when this pane is the active view and should be visible. */
  active: boolean
  children: React.ReactNode
}

/**
 * Keep-alive pane for main-content views (P-2 navigation perf).
 *
 * Mounts `children` once and toggles visibility with the `hidden` attribute
 * instead of unmounting on view switch. The heavy views (CodeMirror editor,
 * graph canvas) therefore survive navigation — switching views is a CSS
 * display toggle (~ms) rather than a full remount (~100ms–1s on this tree).
 *
 * The CSS rule `.view-keepalive[hidden] { display: none !important }` wins
 * over the pane's own `display: flex` (the UA `[hidden] { display: none }`
 * would otherwise be overridden by the author rule).
 */
export const ViewKeepAlive: React.FC<ViewKeepAliveProps> = ({ active, children }) => (
  <div className="view-keepalive" hidden={!active} aria-hidden={!active}>
    {children}
  </div>
)
