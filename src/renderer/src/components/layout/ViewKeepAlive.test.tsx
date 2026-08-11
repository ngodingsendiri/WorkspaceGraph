// @vitest-environment jsdom
/**
 * Keep-alive navigation (P-2): switching views must hide/show the pane, never
 * unmount it. Regression — if someone reverts to conditional mounting, the
 * hidden pane disappears from the DOM and this fails.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ViewKeepAlive } from './ViewKeepAlive'

describe('ViewKeepAlive', () => {
  it('keeps children mounted while hidden', () => {
    const { container } = render(
      <ViewKeepAlive active={false}>
        <div data-testid="child">editor content</div>
      </ViewKeepAlive>
    )
    const pane = container.firstChild as HTMLElement
    expect(pane.hasAttribute('hidden')).toBe(true)
    // Hidden ≠ unmounted — the editor/graph stays alive across view switches
    expect(screen.getByTestId('child')).toBeTruthy()
  })

  it('toggles visibility without remounting children', () => {
    const { container, rerender } = render(
      <ViewKeepAlive active={false}>
        <div data-testid="child">graph canvas</div>
      </ViewKeepAlive>
    )
    const pane = container.firstChild as HTMLElement
    const childBefore = screen.getByTestId('child')

    rerender(
      <ViewKeepAlive active={true}>
        <div data-testid="child">graph canvas</div>
      </ViewKeepAlive>
    )
    expect(pane.hasAttribute('hidden')).toBe(false)
    // Same DOM node — React reconciled in place instead of remounting
    expect(screen.getByTestId('child')).toBe(childBefore)

    rerender(
      <ViewKeepAlive active={false}>
        <div data-testid="child">graph canvas</div>
      </ViewKeepAlive>
    )
    expect(pane.hasAttribute('hidden')).toBe(true)
    expect(screen.getByTestId('child')).toBe(childBefore)
  })

  it('exposes aria-hidden to match the visual state', () => {
    const { container, rerender } = render(
      <ViewKeepAlive active={false}>
        <span>x</span>
      </ViewKeepAlive>
    )
    const pane = container.firstChild as HTMLElement
    expect(pane.getAttribute('aria-hidden')).toBe('true')
    rerender(
      <ViewKeepAlive active={true}>
        <span>y</span>
      </ViewKeepAlive>
    )
    expect(pane.getAttribute('aria-hidden')).toBe('false')
  })
})
