/**
 * P2-3: chat slash commands — a mini command palette inside the composer.
 *
 * Typing `/` in the input opens a popover (Cursor-style). Selecting a command
 * fills the composer with a prompt template the user can edit before sending.
 * The global CommandPalette (Ctrl+P) stays view-level; this is the chat-scoped
 * counterpart.
 */

export interface SlashCommand {
  /** The command token, e.g. `/compact`. */
  name: string
  /** One-line description shown under the name in the popover. */
  label: string
  /** Prompt template written into the composer on selection. */
  template: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: '/compact',
    label: 'Ringkas percakapan ini',
    template:
      'Ringkas seluruh percakapan ini menjadi poin-poin esensial: keputusan, temuan, file yang dibahas, dan open question. Akhiri dengan 3 baris ringkasan yang bisa dipakai sebagai konteks lanjutan.'
  },
  {
    name: '/learn',
    label: 'Pelajari workspace (bootstrap AI Memory)',
    template:
      'Pelajari workspace (bootstrap AI Memory): baca AI Memory/00 Index.md dan catatan memori lain, perbarui Cara Kerja/Aturan/Pola & Naming/Glossary via proposal, pakai [[wikilink]] agar graph memadat, akhiri dengan ringkasan + daftar proposal.'
  },
  {
    name: '/plan',
    label: 'Buat rencana implementasi',
    template:
      'Buat rencana implementasi langkah demi langkah untuk: [tugas]. Format: tujuan, langkah konkret (sebutkan file yang terlibat), urutan prioritas, dan risiko. Jangan menulis kode dulu — rencanakan.'
  },
  {
    name: '/review',
    label: 'Audit kekurangan / bug',
    template:
      'Audit keseluruhan fitur berikut sebagai reviewer kritis: [fitur]. Temukan bug dan kekurangan, beri prioritas (P1/P2/P3), dan sarankan perbaikan paling berdampak.'
  }
]

/** Case-insensitive prefix filter — empty query returns everything. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter((c) => c.name.toLowerCase().startsWith(q))
}

/** Resolve a command by its full token (`/plan`). */
export function findSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === name)
}

/**
 * P2-5: bridge from the global CommandPalette (Ctrl+P).
 *
 * The chat panel unmounts while hidden, so a palette selection can fire when
 * no listener exists. The request is stashed here first, then broadcast — the
 * ChatPanel listener consumes the stash (mounted case) or the mount effect
 * picks it up later (panel hidden when the palette fired).
 */
const COMPOSER_COMMAND_EVENT = 'wg:composer-command'
let pendingComposerCommand: SlashCommand | null = null

export function requestComposerCommand(name: string): void {
  const cmd = findSlashCommand(name)
  if (!cmd) return
  pendingComposerCommand = cmd
  // Node test env has no window — the stash alone is enough to unit-test the
  // unmounted path; the broadcast covers the mounted path.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(COMPOSER_COMMAND_EVENT, { detail: cmd.name }))
  }
}

/** Read + clear the stashed request (called by the listener and on mount). */
export function consumeComposerCommand(): SlashCommand | null {
  const cmd = pendingComposerCommand
  pendingComposerCommand = null
  return cmd
}
