import { describe, it, expect } from 'vitest'
import {
  AUTO_MODEL,
  isAutoModel,
  resolveAutoModel,
  autoLabel,
  buildModelGroups
} from './chatModelPicker'

const grok = {
  id: 'grok',
  name: 'Grok',
  defaultModel: 'grok-4.5',
  models: [
    { id: 'grok-4.5', name: 'Grok 4.5' },
    { id: 'grok-3.5', name: 'Grok 3.5' }
  ]
}
const ollama = {
  id: 'ollama',
  name: 'Ollama',
  models: [{ id: 'llama3', name: 'Llama 3' }]
}
const empty = { id: 'empty', name: 'Empty', models: [] }

describe('chatModelPicker (P1-3)', () => {
  it('isAutoModel treats the sentinel, empty, and undefined as auto', () => {
    expect(isAutoModel(AUTO_MODEL)).toBe(true)
    expect(isAutoModel('')).toBe(true)
    expect(isAutoModel(undefined)).toBe(true)
    expect(isAutoModel(null)).toBe(true)
    expect(isAutoModel('grok-4.5')).toBe(false)
  })

  it('resolveAutoModel prefers defaultModel, then the first model', () => {
    expect(resolveAutoModel(grok)).toBe('grok-4.5')
    expect(resolveAutoModel(ollama)).toBe('llama3')
    expect(resolveAutoModel(empty)).toBe('')
    expect(resolveAutoModel(null)).toBe('')
  })

  it('autoLabel shows the resolved model next to Auto', () => {
    expect(autoLabel(grok)).toBe('Auto · grok-4.5')
    expect(autoLabel(empty)).toBe('Auto')
  })

  it('buildModelGroups keeps provider grouping and omits empty providers', () => {
    const groups = buildModelGroups([grok, ollama, empty])
    expect(groups).toHaveLength(2)
    expect(groups[0].providerId).toBe('grok')
    expect(groups[0].models.map((m) => m.id)).toEqual(['grok-4.5', 'grok-3.5'])
    expect(groups[1].providerId).toBe('ollama')
  })
})
