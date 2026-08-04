import { describe, it, expect } from 'vitest'
import { verifyCitations } from './CitationVerifier'

function cite(answer: string, fileContents: Record<string, string>): ReturnType<typeof verifyCitations> {
  const citations = Object.keys(fileContents).map((p) => ({ title: p.split('/').pop() || p, path: p }))
  return verifyCitations(answer, citations, (p) => fileContents[p] || '')
}

describe('verifyCitations', () => {
  it('marks supported when the answer draws on the cited file', () => {
    const res = cite(
      'Eksperimen entanglement kuantum mengukur korelasi foton sejauh 120 kilometer dan hasilnya konsisten dengan prediksi teori.',
      {
        '/vault/Quantum.md':
          '# Quantum\n\nEksperimen entanglement kuantum mengukur korelasi foton sejauh 120 kilometer. Hasil konsisten dengan prediksi teori lokal.',
        '/vault/Lain.md': 'Tips berkebun tomat di musim gugur dan menyiram tanaman.'
      }
    )
    const quantum = res.find((r) => r.path.endsWith('Quantum.md'))
    const lain = res.find((r) => r.path.endsWith('Lain.md'))
    expect(quantum?.supported).toBe(true)
    expect(quantum!.score).toBeGreaterThan(0.1)
    // Unrelated file → weak evidence
    expect(lain?.supported).toBe(false)
  })

  it('returns empty for empty answer or empty citations', () => {
    expect(verifyCitations('', [{ title: 'A', path: '/a.md' }], () => 'x')).toEqual([])
    expect(verifyCitations('some answer text', [], () => 'x')).toEqual([])
  })

  it('assumes supported when the file cannot be read', () => {
    const res = verifyCitations(
      'Ini jawaban panjang tentang topik tertentu yang tidak ada di file manapun.',
      [{ title: 'A', path: '/missing.md' }],
      () => {
        throw new Error('not found')
      }
    )
    expect(res[0].supported).toBe(true)
  })

  it('does not falsely flag a very short answer', () => {
    const res = cite('Ya, benar.', { '/vault/A.md': 'Konten apa pun di sini.' })
    expect(res[0].supported).toBe(true)
  })

  it('boosts supported when the answer names the cited title', () => {
    const res = cite(
      'Menurut QuantumNotes, hasil pengukuran eksperimen konsisten dengan prediksi teori dan metodologi yang diuraikan sebelumnya.',
      { '/vault/QuantumNotes.md': 'Dokumen ini membahas resep masakan nusantara dan bahan-bahannya.' }
    )
    expect(res[0].supported).toBe(true)
  })

  it('flags a hallucinated citation with a long confident answer', () => {
    const res = cite(
      'Rasio keuangan perusahaan naik dua kali lipat pada kuartal ketiga karena strategi ekspansi pasar internasional berhasil meningkatkan margin operasional secara signifikan.',
      { '/vault/Catatan.md': 'Daftar belanja mingguan: telur, susu, roti, dan sayuran segar untuk kebutuhan dapur.' }
    )
    expect(res[0].supported).toBe(false)
    expect(res[0].score).toBeLessThan(0.08)
  })
})
