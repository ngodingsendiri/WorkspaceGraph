/**
 * Domain systems scan (Phase 4): Projects, Tasks, People, Knowledge stats
 * Source of truth remains Markdown files.
 */
import type { ParsedMarkdown } from './MarkdownEngine'
import { graphEngine } from './GraphEngine'

export type DomainType =
  'project' | 'task' | 'people' | 'knowledge' | 'daily' | 'sop' | 'document' | 'other'

export interface DomainItem {
  id: string
  title: string
  path: string
  relativePath: string
  type: DomainType
  status?: string
  priority?: string
  tags: string[]
  updatedAt?: string
  openCheckboxes?: number
  doneCheckboxes?: number
}

export interface CheckboxTask {
  text: string
  done: boolean
  noteTitle: string
  notePath: string
  line: number
}

export interface DomainOverview {
  projects: DomainItem[]
  tasks: DomainItem[]
  people: DomainItem[]
  knowledge: DomainItem[]
  openCheckboxes: CheckboxTask[]
  counts: {
    projects: number
    tasks: number
    people: number
    knowledge: number
    openTasks: number
    doneTasks: number
    openCheckboxes: number
  }
  projectsByStatus: Record<string, number>
  tasksByStatus: Record<string, number>
  tasksByPriority: Record<string, number>
}

function typeFromParsed(file: ParsedMarkdown): DomainType {
  const fmType = String(file.frontmatter.type || '').toLowerCase()
  if (
    fmType === 'project' ||
    fmType === 'task' ||
    fmType === 'people' ||
    fmType === 'daily' ||
    fmType === 'sop' ||
    fmType === 'document' ||
    fmType === 'knowledge'
  ) {
    return fmType as DomainType
  }
  const rel = file.relativePath.replace(/\\/g, '/').toLowerCase()
  if (rel.startsWith('projects/')) return 'project'
  if (rel.startsWith('tasks/')) return 'task'
  if (rel.startsWith('people/')) return 'people'
  if (rel.startsWith('knowledge/')) return 'knowledge'
  if (rel.startsWith('daily/')) return 'daily'
  if (rel.startsWith('sop/')) return 'sop'
  if (rel.startsWith('documents/')) return 'document'
  return 'other'
}

export function parseCheckboxes(
  content: string,
  noteTitle: string,
  notePath: string
): CheckboxTask[] {
  const out: CheckboxTask[] = []
  const lines = content.split('\n')
  lines.forEach((line, i) => {
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (m) {
      out.push({
        text: m[2].trim(),
        done: m[1].toLowerCase() === 'x',
        noteTitle,
        notePath,
        line: i + 1
      })
    }
  })
  return out
}

export class DomainEngine {
  private cache: ParsedMarkdown[] = []

  setParsedFiles(files: ParsedMarkdown[]): void {
    this.cache = files
  }

  getOverview(): DomainOverview {
    const projects: DomainItem[] = []
    const tasks: DomainItem[] = []
    const people: DomainItem[] = []
    const knowledge: DomainItem[] = []
    const openCheckboxes: CheckboxTask[] = []
    let openTasks = 0
    let doneTasks = 0
    const projectsByStatus: Record<string, number> = {}
    const tasksByStatus: Record<string, number> = {}
    const tasksByPriority: Record<string, number> = {}

    for (const file of this.cache) {
      const type = typeFromParsed(file)
      const status = String(file.frontmatter.status || '').toLowerCase() || undefined
      const priority = String(file.frontmatter.priority || '').toLowerCase() || undefined
      const boxes = parseCheckboxes(file.content, file.title, file.filePath)
      const open = boxes.filter((b) => !b.done).length
      const done = boxes.filter((b) => b.done).length
      for (const b of boxes) {
        if (!b.done) openCheckboxes.push(b)
      }

      const item: DomainItem = {
        id: file.id,
        title: file.title,
        path: file.filePath,
        relativePath: file.relativePath,
        type,
        status,
        priority,
        tags: file.tags,
        updatedAt: String(file.frontmatter.updated || file.frontmatter.date || ''),
        openCheckboxes: open,
        doneCheckboxes: done
      }

      if (type === 'project') {
        projects.push(item)
        const st = status || 'unknown'
        projectsByStatus[st] = (projectsByStatus[st] || 0) + 1
      } else if (type === 'task') {
        tasks.push(item)
        const st = status || 'todo'
        tasksByStatus[st] = (tasksByStatus[st] || 0) + 1
        const pr = priority || 'medium'
        tasksByPriority[pr] = (tasksByPriority[pr] || 0) + 1
        if (st === 'done' || st === 'completed' || st === 'archived') doneTasks++
        else openTasks++
      } else if (type === 'people') {
        people.push(item)
      } else if (type === 'knowledge') {
        knowledge.push(item)
      }
    }

    // Sort recent first
    const byUpdated = (a: DomainItem, b: DomainItem) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    projects.sort(byUpdated)
    tasks.sort(byUpdated)
    people.sort(byUpdated)
    knowledge.sort(byUpdated)

    return {
      projects,
      tasks,
      people,
      knowledge,
      openCheckboxes: openCheckboxes.slice(0, 50),
      counts: {
        projects: projects.length,
        tasks: tasks.length,
        people: people.length,
        knowledge: knowledge.length,
        openTasks,
        doneTasks,
        openCheckboxes: openCheckboxes.length
      },
      projectsByStatus,
      tasksByStatus,
      tasksByPriority
    }
  }

  listByType(type: DomainType): DomainItem[] {
    const o = this.getOverview()
    switch (type) {
      case 'project':
        return o.projects
      case 'task':
        return o.tasks
      case 'people':
        return o.people
      case 'knowledge':
        return o.knowledge
      default:
        return []
    }
  }

  /** People linked to a note via graph neighbors of type people */
  peopleLinkedTo(filePath: string): DomainItem[] {
    const node = graphEngine.getNodeByPath(filePath)
    if (!node) return []
    const { nodes } = graphEngine.getNeighbors(node.id, 1)
    const peopleIds = new Set(
      nodes
        .filter((n) => n.type === 'people' || n.relativePath.toLowerCase().startsWith('people/'))
        .map((n) => n.id)
    )
    return this.getOverview().people.filter((p) => peopleIds.has(p.id))
  }
}

export const domainEngine = new DomainEngine()
