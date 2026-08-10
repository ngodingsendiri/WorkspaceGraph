import { describe, it, expect } from 'vitest'
import {
  CANCEL_ARM_MS,
  cancelRemainingMs,
  isArmedExpired,
  nextCancelClick,
  cancelConfirmLabel
} from './chatCancelConfirm'

/**
 * Component test for the two-step stop gate (node env, no jsdom): the pure
 * click contract is the confirmation behaviour a user experiences — the
 * ChatPanel wires nextCancelClick straight into the stop button's onClick, so
 * what is asserted here is exactly when a cancel can and cannot fire.
 */
describe('chatCancelConfirm — two-step stop gate', () => {
  const t0 = 1_000_000

  it('first click on idle always arms, never cancels', () => {
    expect(nextCancelClick(false, null, t0)).toBe('arm')
  })

  it('second click inside the window cancels', () => {
    expect(nextCancelClick(true, t0, t0 + 1)).toBe('cancel')
    expect(nextCancelClick(true, t0, t0 + 500)).toBe('cancel')
    expect(nextCancelClick(true, t0, t0 + CANCEL_ARM_MS - 1)).toBe('cancel')
  })

  it('a click after the arm expired re-arms instead of cancelling', () => {
    // An expired confirmation must never fire a cancel — a slow user (or a
    // click after the countdown) re-arms, it does not kill the stream.
    expect(nextCancelClick(true, t0, t0 + CANCEL_ARM_MS)).toBe('rearm')
    expect(nextCancelClick(true, t0, t0 + CANCEL_ARM_MS + 4000)).toBe('rearm')
  })

  it('remaining counts down to 0 at the window edge and never goes negative', () => {
    expect(cancelRemainingMs(t0, t0)).toBe(CANCEL_ARM_MS)
    expect(cancelRemainingMs(t0, t0 + 1000)).toBe(CANCEL_ARM_MS - 1000)
    expect(cancelRemainingMs(t0, t0 + CANCEL_ARM_MS)).toBe(0)
    expect(cancelRemainingMs(t0, t0 + CANCEL_ARM_MS + 5000)).toBe(0)
    expect(cancelRemainingMs(null, t0)).toBe(0)
  })

  it('isArmedExpired flips exactly at the window boundary', () => {
    expect(isArmedExpired(t0, t0 + CANCEL_ARM_MS - 1)).toBe(false)
    expect(isArmedExpired(t0, t0 + CANCEL_ARM_MS)).toBe(true)
    expect(isArmedExpired(null, t0)).toBe(false)
  })

  it('armed label shows a ticking seconds countdown', () => {
    expect(cancelConfirmLabel(CANCEL_ARM_MS)).toBe('Stop? 3')
    expect(cancelConfirmLabel(2000)).toBe('Stop? 2')
    expect(cancelConfirmLabel(1001)).toBe('Stop? 2')
    expect(cancelConfirmLabel(1000)).toBe('Stop? 1')
  })

  it('label at 0ms is a stable bare "Stop?" (NIT-2 — no misleading "Stop? 1")', () => {
    expect(cancelConfirmLabel(0)).toBe('Stop?')
    expect(cancelConfirmLabel(-5)).toBe('Stop?')
  })

  it('full flow: arm → wait past window → rearm → cancel on the second click', () => {
    // t0: first click arms
    expect(nextCancelClick(false, null, t0)).toBe('arm')
    // t0+3s: the arm expired — a click re-arms, it does NOT cancel
    const rearmedAt = t0 + CANCEL_ARM_MS + 500
    expect(nextCancelClick(true, t0, rearmedAt)).toBe('rearm')
    // one second after the re-arm: second click cancels
    expect(nextCancelClick(true, rearmedAt, rearmedAt + 1000)).toBe('cancel')
  })
})
