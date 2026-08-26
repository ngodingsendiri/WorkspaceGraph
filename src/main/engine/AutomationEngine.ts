/**
 * Automation System (blueprint 22) — declarative rules in vault
 * File: <vault>/.workspacegraph/automation.json
 */
import fs from 'fs'
import path from 'path'
import { workspaceEngine } from './WorkspaceEngine'
import { assertPathInVault } from '../security/PathSandbox'
import { markSelfWrite } from '../utils/selfWrite'
import { BrowserWindow } from 'electron'

export type AutomationTriggerType =
  | 'file_created'
  | 'file_updated'
  | 'file_deleted'
  | 'workspace_opened'
  | 'manual'
  | 'schedule'
  | 'project_created'
  | 'task_completed'
  | 'daily_note_created'
  | 'ai_response_generated'

/** Cron-style schedule: either a repeating interval or a daily atTime slot. */
export interface AutomationSchedule {
  /** Interval length (with unit) — e.g. { every: 30, unit: 'minutes' } */
  every?: number
  unit?: 'minutes' | 'hours' | 'days'
  /** Daily slot HH:MM (local time, same convention as daily notes) */
  atTime?: string
  /** 0=Sunday … 6=Saturday; empty = every day */
  daysOfWeek?: number[]
}

/**
 * M6a PLT-2: declarative conditions evaluated against the triggering context.
 * A rule fires only when every condition matches. Empty/absent = unconditional.
 */
export interface AutomationCondition {
  /** Field to inspect: file path type, tags, metadata key, or a simple custom predicate. */
  field: 'file_type' | 'tags' | 'metadata' | 'custom'
  /** Comparison operator. */
  op: 'equals' | 'not_equals' | 'contains' | 'not_contains'
  /** Expected value (string or comma-separated list for contains). */
  value: string
  /** For field === 'metadata': the frontmatter key to check. */
  key?: string
}

export interface AutomationRule {
  id: string
  name: string
  enabled: boolean
  trigger: {
    type: AutomationTriggerType
    /** glob-like: ends with .md or contains path fragment */
    match?: string
    /** Only for trigger.type === 'schedule' */
    schedule?: AutomationSchedule
  }
  /** M6a PLT-2: optional conditions — all must pass for the rule to fire. */
  conditions?: AutomationCondition[]
  actions: AutomationAction[]
}

export type AutomationAction =
  | { type: 'log'; message: string }
  | { type: 'append_to_note'; path: string; content: string }
  | { type: 'set_frontmatter_tag'; path: string; tag: string }
  | { type: 'notify'; message: string }
  | { type: 'create_note'; path: string; content: string }

export interface AutomationLogEntry {
  at: string
  ruleId: string
  message: string
  ok: boolean
}

export interface AutomationConfig {
  version: 1
  rules: AutomationRule[]
}

export interface SchedulerInfo {
  running: boolean
  nextFire: string | null
}

const DEFAULT_CONFIG: AutomationConfig = {
  version: 1,
  rules: [
    {
      id: 'sample-log-md',
      name: 'Log markdown changes',
      enabled: false,
      trigger: { type: 'file_updated', match: '.md' },
      actions: [{ type: 'log', message: 'MD updated: {{relativePath}}' }]
    },
    {
      id: 'daily-touch-log',
      name: 'Append file create to daily note',
      enabled: false,
      trigger: { type: 'file_created', match: '.md' },
      actions: [
        {
          type: 'append_to_note',
          path: 'Daily/{{date}}.md',
          content: '- Created [[{{title}}]] ({{relativePath}})\n'
        }
      ]
    },
    {
      id: 'daily-digest-log',
      name: 'Daily digest (09:00, Sen–Jum)',
      enabled: false,
      trigger: {
        type: 'schedule',
        schedule: { atTime: '09:00', daysOfWeek: [1, 2, 3, 4, 5] }
      },
      actions: [{ type: 'log', message: 'Daily digest {{date}} — {{workspace}}' }]
    }
  ]
}

const TICK_MS = 60_000

/** Local calendar day key (YYYY-MM-DD) — scheduler day boundaries are local. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseAtTime(atTime: string): [number, number] {
  const [h, m] = atTime.split(':').map(Number)
  return [h, m]
}

function unitMs(unit?: 'minutes' | 'hours' | 'days'): number {
  switch (unit) {
    case 'hours':
      return 3_600_000
    case 'days':
      return 86_400_000
    default:
      return 60_000
  }
}

export class AutomationEngine {
  private config: AutomationConfig = DEFAULT_CONFIG
  private logs: AutomationLogEntry[] = []
  private enabled = true
  private rootPath: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** Per-rule last fire timestamp (interval rules) */
  private lastFiredAt: Record<string, number> = {}
  /** Per-rule last fire day key (daily rules) */
  private lastFiredDay: Record<string, string> = {}
  /**
   * A1: re-entrancy guards. markSelfWrite (utils/selfWrite) suppresses the
   * watcher echo for files automation itself wrote; these two guards are the
   * second net for loops that bypass it:
   *  - reentrancyDepth: synchronous nested handleEvent (rare), bounded.
   *  - lastHandledAt: async watcher echo (the real loop vector) — the same
   *    rule must not re-process the same file within the cooldown window.
   */
  private reentrancyDepth = 0
  private readonly MAX_REENTRANCY_DEPTH = 3
  private lastHandledAt: Record<string, number> = {}
  private readonly REENTRANCY_COOLDOWN_MS = 5000

  load(workspaceRoot: string): void {
    this.rootPath = workspaceRoot
    const file = path.join(workspaceRoot, '.workspacegraph', 'automation.json')
    try {
      if (fs.existsSync(file)) {
        this.config = JSON.parse(fs.readFileSync(file, 'utf-8')) as AutomationConfig
        if (!this.config.rules) this.config.rules = []
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AutomationConfig
        this.save()
      }
    } catch {
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AutomationConfig
    }
    this.seedSchedulerState()
    this.restart()
  }

  unload(): void {
    this.stop()
    this.rootPath = null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (on) this.restart()
    else this.stop()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  getConfig(): AutomationConfig {
    return this.config
  }

  getLogs(limit = 50): AutomationLogEntry[] {
    return this.logs.slice(-limit).reverse()
  }

  save(config?: AutomationConfig): void {
    if (config) this.config = config
    if (!this.rootPath) return
    const dir = path.join(this.rootPath, '.workspacegraph')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'automation.json'),
      JSON.stringify(this.config, null, 2),
      'utf-8'
    )
    this.restart()
  }

  private matchPath(match: string | undefined, filePath: string): boolean {
    if (!match) return true
    const m = match.toLowerCase()
    const p = filePath.replace(/\\/g, '/').toLowerCase()
    if (m.startsWith('*.')) return p.endsWith(m.slice(1))
    return p.includes(m)
  }

  private interpolate(template: string, ctx: Record<string, string>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => ctx[k] ?? '')
  }

  private buildCtx(filePath?: string): Record<string, string> {
    const date = new Date().toISOString().split('T')[0]
    const root = this.rootPath || ''
    const relativePath = filePath && root ? path.relative(root, filePath).replace(/\\/g, '/') : ''
    const title = filePath ? path.basename(filePath, path.extname(filePath)) : ''
    return {
      date,
      time: new Date().toTimeString().slice(0, 5),
      path: filePath || '',
      relativePath,
      title,
      workspace: root ? path.basename(root) : ''
    }
  }

  /** M6a PLT-2: evaluate all conditions for a rule against a file context. */
  private conditionsMatch(
    conditions: AutomationCondition[] | undefined,
    filePath?: string
  ): boolean {
    if (!conditions || conditions.length === 0) return true
    for (const cond of conditions) {
      let actual = ''
      if (cond.field === 'file_type') {
        const rel = filePath ? path.relative(this.rootPath || '', filePath).replace(/\\/g, '/') : ''
        const lower = rel.toLowerCase()
        if (lower.startsWith('projects')) actual = 'project'
        else if (lower.startsWith('tasks')) actual = 'task'
        else if (lower.startsWith('people')) actual = 'people'
        else if (lower.startsWith('knowledge')) actual = 'knowledge'
        else if (lower.startsWith('daily')) actual = 'daily'
        else if (lower.startsWith('sop')) actual = 'sop'
        else actual = 'other'
      } else if (cond.field === 'tags') {
        actual = this.tagsOf(filePath)
      } else if (cond.field === 'metadata' && filePath && cond.key) {
        try {
          const { content } = workspaceEngine.readFile(filePath)
          const m = content.match(/^---\n([\s\S]*?)\n---/)
          const fm = m ? m[1] : ''
          const line = fm
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.startsWith(`${cond.key}:`))
          actual = line
            ? line
                .split(':')
                .slice(1)
                .join(':')
                .trim()
                .replace(/^["']|["']$/g, '')
            : ''
        } catch {
          actual = ''
        }
      }
      const expected = (cond.value || '').trim().toLowerCase()
      const a = actual.toLowerCase()
      const ok =
        cond.op === 'equals'
          ? a === expected
          : cond.op === 'not_equals'
            ? a !== expected
            : cond.op === 'contains'
              ? expected
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .every((e) => a.includes(e))
              : !expected
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .some((e) => a.includes(e))
      if (!ok) return false
    }
    return true
  }

  /** Comma/space-separated tags from a note's frontmatter (for conditions). */
  private tagsOf(filePath?: string): string {
    if (!filePath) return ''
    try {
      const { content } = workspaceEngine.readFile(filePath)
      const m = content.match(/^---\n([\s\S]*?)\n---/)
      if (!m) return ''
      const fm = m[1]
      const line = fm
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('tags:'))
      if (!line) return ''
      return line.replace(/^tags:\s*/, '').replace(/[[\]"']/g, '')
    } catch {
      return ''
    }
  }

  handleEvent(type: AutomationTriggerType, filePath?: string): void {
    if (!this.enabled || !this.rootPath) return
    // A1: stop runaway re-entry (rule write → watcher echo → same rule …).
    // Fail-open on the boundary: skip the event, log once, allow later events.
    if (this.reentrancyDepth >= this.MAX_REENTRANCY_DEPTH) {
      this.pushLog('__reentrancy__', `skip ${type} (max depth ${this.MAX_REENTRANCY_DEPTH})`, false)
      return
    }
    this.reentrancyDepth++

    const ctx = this.buildCtx(filePath)
    try {
      for (const rule of this.config.rules) {
        if (!rule.enabled) continue
        if (rule.trigger.type !== type) continue
        if (filePath && !this.matchPath(rule.trigger.match, filePath)) continue
        // M6a PLT-2: conditions gate the rule
        if (!this.conditionsMatch(rule.conditions, filePath)) continue

        // A1 (async): the same rule must not re-process the same file within
        // the cooldown window — this is what actually stops append-to-own-file
        // loops, since the watcher fires on a fresh event-loop tick.
        if (filePath) {
          const cooldownKey = `${rule.id}:${filePath.replace(/\\/g, '/').toLowerCase()}`
          const last = this.lastHandledAt[cooldownKey]
          if (last != null && Date.now() - last < this.REENTRANCY_COOLDOWN_MS) {
            continue
          }
          this.lastHandledAt[cooldownKey] = Date.now()
        }

        for (const action of rule.actions) {
          try {
            this.runAction(action, ctx, rule.id)
          } catch (err) {
            this.pushLog(rule.id, err instanceof Error ? err.message : String(err), false)
          }
        }
      }
    } finally {
      this.reentrancyDepth--
    }
  }

  private runAction(action: AutomationAction, ctx: Record<string, string>, ruleId: string): void {
    if (action.type === 'log') {
      const msg = this.interpolate(action.message, ctx)
      this.pushLog(ruleId, msg, true)
      console.log(`[Automation] ${ruleId}: ${msg}`)
      return
    }

    if (action.type === 'append_to_note') {
      const rel = this.interpolate(action.path, ctx)
      const abs = path.join(this.rootPath!, rel)
      assertPathInVault(abs, this.rootPath!)
      const content = this.interpolate(action.content, ctx)
      const dir = path.dirname(abs)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      // A1: mark our own write so the watcher doesn't re-fire the same rule
      markSelfWrite(abs)
      if (!fs.existsSync(abs)) {
        workspaceEngine.writeFile(
          abs,
          `---\ntitle: ${path.basename(abs, '.md')}\ntype: daily\ndate: ${ctx.date}\n---\n\n# ${path.basename(abs, '.md')}\n\n`
        )
      }
      const existing = workspaceEngine.readFile(abs).content
      workspaceEngine.writeFile(abs, existing.replace(/\s*$/, '') + '\n' + content)
      this.pushLog(ruleId, `append → ${rel}`, true)
      return
    }

    if (action.type === 'set_frontmatter_tag') {
      const rel = this.interpolate(action.path, ctx)
      const abs = path.join(this.rootPath!, rel)
      assertPathInVault(abs, this.rootPath!)
      if (!fs.existsSync(abs)) {
        this.pushLog(ruleId, `tag skip missing ${rel}`, false)
        return
      }
      let raw = workspaceEngine.readFile(abs).content
      const tag = this.interpolate(action.tag, ctx)
      if (raw.includes(`#${tag}`) || raw.includes(`- ${tag}`)) {
        this.pushLog(ruleId, `tag already present ${tag}`, true)
        return
      }
      if (raw.startsWith('---')) {
        // Normalize CRLF to LF first so frontmatter slicing is clean on Windows
        const norm = raw.replace(/\r\n/g, '\n')
        const end = norm.indexOf('\n---', 3)
        if (end !== -1) {
          const fm = norm.slice(0, end)
          const body = norm.slice(end)
          if (fm.includes('tags:')) {
            raw =
              fm.replace(/tags:\s*\[([^\]]*)\]/, (_full, inner: string) => {
                const parts = inner
                  .split(',')
                  .map((s: string) => s.trim())
                  .filter(Boolean)
                if (!parts.includes(tag) && !parts.includes(`"${tag}"`)) parts.push(tag)
                return `tags: [${parts.join(', ')}]`
              }) + body
          } else {
            raw = fm + `\ntags: [${tag}]` + body
          }
          markSelfWrite(abs)
          workspaceEngine.writeFile(abs, raw)
          this.pushLog(ruleId, `tag ${tag} → ${rel}`, true)
        }
      }
    }

    // M6a PLT-3: notify — broadcast to the renderer (plugin:notify channel)
    if (action.type === 'notify') {
      const msg = this.interpolate(action.message, ctx)
      this.pushLog(ruleId, msg, true)
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          win.webContents.send('plugin:notify', { message: msg })
        }
      } catch {
        /* no windows / test env — notify is best-effort */
      }
      return
    }

    // M6a PLT-3: create_note — write a new .md file
    if (action.type === 'create_note') {
      const rel = this.interpolate(action.path, ctx)
      const abs = path.join(this.rootPath!, rel)
      assertPathInVault(abs, this.rootPath!)
      const content = this.interpolate(action.content, ctx)
      const dir = path.dirname(abs)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      markSelfWrite(abs)
      workspaceEngine.writeFile(abs, content)
      this.pushLog(ruleId, `create → ${rel}`, true)
      return
    }
  }

  private pushLog(ruleId: string, message: string, ok: boolean): void {
    this.logs.push({ at: new Date().toISOString(), ruleId, message, ok })
    if (this.logs.length > 200) this.logs = this.logs.slice(-200)
  }

  runManual(ruleId: string, filePath?: string): { ok: boolean; error?: string } {
    if (!this.rootPath) return { ok: false, error: 'No workspace open' }
    const rule = this.config.rules.find((r) => r.id === ruleId)
    if (!rule) return { ok: false, error: 'Rule not found' }
    const ctx = this.buildCtx(filePath)
    for (const action of rule.actions) {
      try {
        this.runAction(action, ctx, rule.id)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
    return { ok: true }
  }

  // ─── Scheduler (trigger type 'schedule') ───────────────────────────────

  /** Start the 60s tick. Idempotent; unref'd so it never holds the app open. */
  start(): void {
    if (this.timer || !this.rootPath || !this.enabled) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    const t = this.timer
    if (typeof t.unref === 'function') t.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  restart(): void {
    this.stop()
    this.start()
  }

  /**
   * Seed per-rule scheduler state on load:
   * - interval rules start counting from now (full interval before first fire)
   * - daily rules already past today's slot are marked fired so a restart
   *   never double-fires (or fires hours late) for the current day.
   */
  seedSchedulerState(): void {
    this.lastFiredAt = {}
    this.lastFiredDay = {}
    const now = new Date()
    const today = localDayKey(now)
    for (const rule of this.config.rules) {
      if (!rule.enabled || rule.trigger.type !== 'schedule') continue
      const sched = rule.trigger.schedule
      if (!sched) continue
      if (sched.atTime) {
        const [h, m] = parseAtTime(sched.atTime)
        const atMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime()
        if (now.getTime() >= atMs && this.dayAllowed(sched, now)) {
          this.lastFiredDay[rule.id] = today
        }
      } else if (sched.every && sched.every > 0) {
        this.lastFiredAt[rule.id] = now.getTime()
      }
    }
  }

  private dayAllowed(sched: AutomationSchedule, date: Date): boolean {
    const list = sched.daysOfWeek
    if (!list || list.length === 0) return true
    return list.includes(date.getDay())
  }

  /**
   * Note: an interval rule blocked by daysOfWeek catches up on the first
   * allowed tick (e.g. every-1h Mon-only fires at 00:00 Tue) — the time of
   * day drifts after a blocked day; intentional, documented in the plan.
   */
  private tick(): void {
    if (!this.enabled || !this.rootPath) return
    const now = new Date()
    for (const rule of this.config.rules) {
      if (!rule.enabled || rule.trigger.type !== 'schedule') continue
      const sched = rule.trigger.schedule
      if (!sched || !this.shouldFire(rule.id, sched, now)) continue
      const ctx = this.buildCtx()
      for (const action of rule.actions) {
        try {
          this.runAction(action, ctx, rule.id)
        } catch (err) {
          this.pushLog(rule.id, err instanceof Error ? err.message : String(err), false)
        }
      }
      this.lastFiredAt[rule.id] = now.getTime()
      this.lastFiredDay[rule.id] = localDayKey(now)
    }
  }

  private shouldFire(id: string, sched: AutomationSchedule, now: Date): boolean {
    if (!this.dayAllowed(sched, now)) return false
    const today = localDayKey(now)
    if (sched.atTime) {
      if (this.lastFiredDay[id] === today) return false
      const [h, m] = parseAtTime(sched.atTime)
      const atMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime()
      return now.getTime() >= atMs
    }
    if (sched.every && sched.every > 0) {
      const last = this.lastFiredAt[id]
      if (last === undefined) return true
      return now.getTime() - last >= sched.every * unitMs(sched.unit)
    }
    return false
  }

  /** Validate an automation config; returns a list of human-readable errors. */
  static validateConfig(config: AutomationConfig): string[] {
    const errs: string[] = []
    for (const rule of config.rules) {
      if (rule.trigger.type !== 'schedule') continue
      const s = rule.trigger.schedule
      const label = rule.name || rule.id
      if (!s) {
        errs.push(`Rule "${label}": trigger schedule butuh blok schedule`)
        continue
      }
      if (s.atTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.atTime)) {
        errs.push(`Rule "${label}": atTime "${s.atTime}" tidak valid (HH:MM)`)
      }
      if (!s.atTime && s.every === undefined) {
        errs.push(`Rule "${label}": butuh atTime (harian) atau every (interval)`)
      }
      if (s.every !== undefined && (!Number.isInteger(s.every) || s.every < 1)) {
        errs.push(`Rule "${label}": every harus bilangan bulat ≥ 1`)
      }
      if (s.every !== undefined && !['minutes', 'hours', 'days'].includes(s.unit || 'minutes')) {
        errs.push(`Rule "${label}": unit harus minutes/hours/days`)
      }
      if (s.atTime && s.every !== undefined) {
        errs.push(`Rule "${label}": pilih salah satu — atTime (harian) atau every (interval)`)
      }
      if (s.daysOfWeek) {
        for (const d of s.daysOfWeek) {
          if (!Number.isInteger(d) || d < 0 || d > 6) {
            errs.push(`Rule "${label}": daysOfWeek harus 0–6 (0=Minggu)`)
            break
          }
        }
      }
    }
    return errs
  }

  /** Next fire time for a schedule rule (null if it will never fire). */
  nextFireTime(rule: AutomationRule, now = new Date()): Date | null {
    if (rule.trigger.type !== 'schedule' || !rule.trigger.schedule) return null
    const sched = rule.trigger.schedule
    if (sched.atTime) {
      const [h, m] = parseAtTime(sched.atTime)
      for (let d = 0; d < 8; d++) {
        const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d, h, m, 0)
        if (cand.getTime() <= now.getTime()) continue
        if (this.dayAllowed(sched, cand)) return cand
      }
      return null
    }
    if (sched.every && sched.every > 0) {
      const span = sched.every * unitMs(sched.unit)
      const base = this.lastFiredAt[rule.id] ?? now.getTime()
      let cand = new Date(base + span)
      for (let i = 0; i < 8; i++) {
        if (cand.getTime() <= now.getTime()) cand = new Date(cand.getTime() + span)
        if (this.dayAllowed(sched, cand)) return cand
        cand = new Date(
          cand.getFullYear(),
          cand.getMonth(),
          cand.getDate() + 1,
          cand.getHours(),
          cand.getMinutes(),
          cand.getSeconds()
        )
      }
      return null
    }
    return null
  }

  getSchedulerInfo(): SchedulerInfo {
    const running = this.timer !== null && this.enabled && !!this.rootPath
    let next: Date | null = null
    for (const rule of this.config.rules) {
      if (!rule.enabled) continue
      const t = this.nextFireTime(rule)
      if (t && (!next || t.getTime() < next.getTime())) next = t
    }
    return { running, nextFire: next ? next.toISOString() : null }
  }
}

export const automationEngine = new AutomationEngine()
