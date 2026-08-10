/**
 * R0-1 — MCP (Model Context Protocol) client.
 *
 * Registers MCP servers from <vault>/.workspacegraph/mcp.json and exposes
 * their tools to the AI agent as `mcp__<serverId>__<toolName>` (Claude Code
 * naming — the `__` split survives tool names that contain underscores).
 * Two transports: stdio (local CLI servers: filesystem, context7, memory) and
 * streamable HTTP (remote servers: GitHub, databases, search gateways).
 *
 * Safety model (defense-in-depth, mirrors the vault tool gates):
 *  - Read-classified tools (MCP `readOnlyHint: true`) run for every role.
 *  - EVERYTHING else is treated as a WRITE and requires BOTH:
 *      (a) server-level `allowWriteTools: true` in mcp.json (user consent),
 *      (b) a role whose tool permissions include writes (writer/curator/
 *          planner/general — a researcher never writes, even to MCP).
 *  - Advertised schemas (native + fence) only include tools the role may call,
 *    so the model rarely attempts a denied call (defense in depth, same as
 *    ROLE_TOOL_PERMISSIONS).
 *  - connect + callTool are bounded by timeouts so a dead server can never
 *    hang a stream or the Settings panel.
 *
 * The singleton performs NO side effects at import time — the app hooks
 * connectAll/disconnectAll into the vault open/close lifecycle and Settings
 * drives ensureConnected on demand.
 */
import fs from 'fs'
import path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { workspaceEngine } from '../engine/WorkspaceEngine'
import type { ProviderTool } from '../ai/providers/BaseProvider'

/** One registered MCP server (persisted to .workspacegraph/mcp.json). */
export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'http'
  /** stdio: executable to spawn (node, npx, python, deno…). */
  command?: string
  args?: string[]
  /** Extra env vars merged over process.env for the child process. */
  env?: Record<string, string>
  /** http: streamable-HTTP endpoint URL. */
  url?: string
  enabled: boolean
  /**
   * User consent gate for write-classified tools. When false, read-only MCP
   * tools still work but anything that could mutate external state is blocked
   * and never advertised to the model.
   */
  allowWriteTools: boolean
}

/** A discovered MCP tool, exposed to the agent as `mcp__<server>__<tool>`. */
export interface McpToolInfo {
  name: string
  serverId: string
  serverName: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** readOnlyHint === true → safe for every role; else treated as write. */
  readOnly: boolean
}

export interface McpServerStatus {
  id: string
  name: string
  transport: 'stdio' | 'http'
  enabled: boolean
  allowWriteTools: boolean
  connected: boolean
  tools: number
  error?: string
}

/** Full callable name: `mcp__<serverId>__<toolName>` — the `__` prefix. */
export const MCP_TOOL_PREFIX = 'mcp__'

const CONNECT_TIMEOUT_MS = 15_000
const CALL_TIMEOUT_MS = 60_000

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/** Sanitize a user-supplied server id so the `mcp__<id>__<tool>` split stays parseable. */
export function sanitizeServerId(raw: string): string {
  return (
    String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || `srv${Date.now().toString(36)}`
  )
}

export function parseMcpToolName(fullName: string): {
  serverId: string
  toolName: string
} | null {
  if (!fullName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = fullName.slice(MCP_TOOL_PREFIX.length)
  const idx = rest.indexOf('__')
  if (idx <= 0) return null
  return { serverId: rest.slice(0, idx), toolName: rest.slice(idx + 2) }
}

function isValidServer(s: unknown): s is McpServerConfig {
  if (!s || typeof s !== 'object') return false
  const o = s as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id || typeof o.name !== 'string') return false
  if (o.transport !== 'stdio' && o.transport !== 'http') return false
  if (o.transport === 'stdio') {
    if (typeof o.command !== 'string' || !o.command.trim()) return false
  } else if (typeof o.url !== 'string' || !o.url.trim()) {
    return false
  }
  return true
}

function normalizeServer(raw: McpServerConfig): McpServerConfig {
  return {
    id: sanitizeServerId(raw.id),
    name: String(raw.name || raw.id).slice(0, 60),
    transport: raw.transport,
    command: raw.transport === 'stdio' ? String(raw.command || '') : undefined,
    args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
    env: raw.env && typeof raw.env === 'object' ? (raw.env as Record<string, string>) : undefined,
    url: raw.transport === 'http' ? String(raw.url || '') : undefined,
    enabled: raw.enabled !== false,
    allowWriteTools: raw.allowWriteTools === true
  }
}

/** Structural MCP tool shape (avoids coupling to the SDK's versioned types). */
interface McpRawTool {
  name?: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

interface McpCallResult {
  content?: { type?: string; text?: string }[]
  isError?: boolean
  structuredContent?: unknown
}

function classifyTool(t: McpRawTool): 'read' | 'write' {
  return t.annotations?.readOnlyHint === true ? 'read' : 'write'
}

function describeMcpError(res: McpCallResult): string {
  const texts = (res.content || [])
    .filter((c) => typeof c?.text === 'string')
    .map((c) => c.text as string)
  return texts.join(' ').slice(0, 400) || 'MCP tool error'
}

export class McpClientManager {
  private servers: McpServerConfig[] = []
  private clients = new Map<string, Client>()
  /** serverId → discovered tools (last successful tools/list). */
  private tools = new Map<string, McpToolInfo[]>()
  /** serverId → last error (connect failure / call failure). */
  private errors = new Map<string, string>()
  private root: string | null = null

  configPath(root?: string | null): string | null {
    const r = root ?? this.root ?? workspaceEngine.getState().rootPath
    return r ? path.join(r, '.workspacegraph', 'mcp.json') : null
  }

  /** (Re)load server config from disk for the current vault. Idempotent. */
  loadConfig(root?: string | null): void {
    const r = root ?? this.root ?? workspaceEngine.getState().rootPath
    if (r) this.root = r
    this.servers = []
    const file = this.configPath()
    if (!file || !fs.existsSync(file)) return
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as { servers?: unknown }
      if (Array.isArray(parsed.servers)) {
        this.servers = parsed.servers.filter(isValidServer).map(normalizeServer)
      }
    } catch {
      /* corrupt config → empty list; never crash the app */
    }
  }

  getServers(): McpServerConfig[] {
    this.ensureLoaded()
    return this.servers
  }

  saveServers(servers: McpServerConfig[], root?: string | null): { ok: boolean; error?: string } {
    // Distinguish "no root passed" (fall back to the loaded vault) from an
    // explicit null (no vault — must fail cleanly, never silently write to a
    // stale workspaceEngine root).
    const r = root !== undefined ? root : (this.root ?? workspaceEngine.getState().rootPath)
    if (!r) return { ok: false, error: 'No workspace open' }
    const file = this.configPath(r)
    if (!file) return { ok: false, error: 'No workspace open' }
    const clean = servers.filter(isValidServer).map(normalizeServer)
    // Duplicate ids would silently clobber each other's clients/tools maps —
    // reject the write so the Settings form surfaces the mistake.
    const ids = new Set<string>()
    for (const s of clean) {
      if (ids.has(s.id)) return { ok: false, error: `Duplicate server id: ${s.id}` }
      ids.add(s.id)
    }
    const prev = this.servers
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ version: 1, servers: clean }, null, 2), 'utf-8')
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    this.servers = clean
    // Prune connections for servers that were REMOVED or whose transport/
    // endpoint changed — otherwise the child process + client would leak until
    // vault close. A pure allowWriteTools/enabled toggle keeps the live
    // connection (the gate reads this.servers config on every call, so no
    // reconnect is needed for enforcement).
    for (const s of clean) {
      const old = prev.find((x) => x.id === s.id)
      if (
        old &&
        (old.transport !== s.transport || old.command !== s.command || old.url !== s.url)
      ) {
        void this.disconnect(s.id)
      }
    }
    for (const id of Array.from(this.clients.keys())) {
      if (!clean.some((s) => s.id === id)) void this.disconnect(id)
    }
    return { ok: true }
  }

  /** Total registered servers (for the Settings badge). */
  getServerCount(): number {
    this.ensureLoaded()
    return this.servers.length
  }

  isMcpTool(name: string): boolean {
    return name.startsWith(MCP_TOOL_PREFIX)
  }

  isReadTool(fullName: string): boolean {
    if (!this.isMcpTool(fullName)) return false
    const parsed = parseMcpToolName(fullName)
    if (!parsed) return false
    return (this.tools.get(parsed.serverId) || []).some((t) => t.name === fullName && t.readOnly)
  }

  isWriteTool(fullName: string): boolean {
    if (!this.isMcpTool(fullName)) return false
    const parsed = parseMcpToolName(fullName)
    if (!parsed) return false
    return (this.tools.get(parsed.serverId) || []).some((t) => t.name === fullName && !t.readOnly)
  }

  /** Server-level write gate: allowWriteTools must be ON for write tools. */
  isWriteAllowed(fullName: string): boolean {
    const parsed = parseMcpToolName(fullName)
    if (!parsed) return false
    const server = this.servers.find((s) => s.id === parsed.serverId)
    return Boolean(server?.allowWriteTools)
  }

  /**
   * Native tool schemas the agent may call for `role`. `canWrite` comes from
   * the role's vault-write capability (AgentTools) — a researcher never sees
   * MCP write tools advertised, and write tools disappear entirely for every
   * role when the server's allowWriteTools is off.
   */
  getToolSchemas(canWrite: boolean): ProviderTool[] {
    this.ensureLoaded()
    const out: ProviderTool[] = []
    for (const [serverId, list] of this.tools) {
      const server = this.servers.find((s) => s.id === serverId)
      if (!server || !server.enabled) continue
      for (const t of list) {
        if (t.readOnly || (canWrite && server.allowWriteTools)) {
          out.push({
            type: 'function',
            function: {
              name: t.name,
              description: t.description || `MCP tool from server "${server.name}"`,
              parameters: normalizeSchema(t.inputSchema)
            }
          })
        }
      }
    }
    return out
  }

  /** One-line fence-protocol docs for the non-native path (Claude/Gemini/Ollama). */
  getFenceDocs(canWrite: boolean): { name: string; description: string }[] {
    this.ensureLoaded()
    const out: { name: string; description: string }[] = []
    for (const [serverId, list] of this.tools) {
      const server = this.servers.find((s) => s.id === serverId)
      if (!server || !server.enabled) continue
      for (const t of list) {
        if (t.readOnly || (canWrite && server.allowWriteTools)) {
          const args = describeSchemaArgs(t.inputSchema)
          out.push({
            name: t.name,
            description: `${t.description || `MCP tool (server ${server.name})`} — args: ${args}`
          })
        }
      }
    }
    return out
  }

  async ensureConnected(ids?: string[]): Promise<McpServerStatus[]> {
    this.ensureLoaded()
    // Skip servers that are ALREADY connected cleanly — Settings toggles then
    // don't churn every child process (the write gate reads config live). Only
    // fresh, errored, or explicitly-requested servers get a connect attempt.
    const targets = this.servers.filter(
      (s) =>
        s.enabled &&
        (!ids || ids.length === 0 || ids.includes(s.id)) &&
        !(this.clients.has(s.id) && !this.errors.has(s.id))
    )
    await Promise.all(targets.map((s) => this.connect(s.id).catch(() => {})))
    return this.getStatus()
  }

  getStatus(): McpServerStatus[] {
    this.ensureLoaded()
    return this.servers.map((s) => ({
      id: s.id,
      name: s.name,
      transport: s.transport,
      enabled: s.enabled,
      allowWriteTools: s.allowWriteTools,
      connected: this.clients.has(s.id),
      tools: (this.tools.get(s.id) || []).length,
      error: this.errors.get(s.id)
    }))
  }

  /** All discovered tools across connected servers (flattened, for display). */
  listTools(): McpToolInfo[] {
    this.ensureLoaded()
    return Array.from(this.tools.values()).flat()
  }

  async connect(serverId: string): Promise<void> {
    this.ensureLoaded()
    await this.disconnect(serverId)
    const server = this.servers.find((s) => s.id === serverId)
    if (!server) throw new Error(`MCP server not found: ${serverId}`)
    if (!server.enabled) throw new Error(`MCP server disabled: ${server.name}`)

    let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined
    try {
      if (server.transport === 'stdio') {
        // process.env has `string | undefined` values — SDK wants a plain
        // Record<string,string>, so drop any undefined entries.
        const env: Record<string, string> = {}
        for (const [k, v] of Object.entries({ ...process.env, ...(server.env || {}) })) {
          if (typeof v === 'string') env[k] = v
        }
        transport = new StdioClientTransport({
          command: String(server.command || ''),
          args: server.args || [],
          env,
          cwd: this.root ?? undefined,
          stderr: 'pipe'
        })
      } else {
        transport = new StreamableHTTPClientTransport(new URL(String(server.url || '')))
      }
      const client = new Client({ name: 'workspacegraph', version: '1.0.0' })
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `MCP connect timeout (${CONNECT_TIMEOUT_MS / 1000}s): ${server.name}`
      )
      const res = (await client.listTools()) as unknown as { tools?: McpRawTool[] }
      const tools: McpToolInfo[] = (res.tools || [])
        .filter((t) => typeof t.name === 'string' && t.name)
        .map((t) => ({
          name: `${MCP_TOOL_PREFIX}${server.id}__${t.name}`,
          serverId: server.id,
          serverName: server.name,
          description: t.description,
          inputSchema: t.inputSchema,
          readOnly: classifyTool(t) === 'read'
        }))
      this.clients.set(server.id, client)
      this.tools.set(server.id, tools)
      this.errors.delete(server.id)
    } catch (err) {
      // Close the transport on ANY failure — a connect timeout leaves the
      // spawned stdio child alive otherwise (orphaned process leak).
      if (transport) {
        try {
          await transport.close()
        } catch {
          /* transport may already be dead */
        }
      }
      // Keep the partial client map clean so a failed connect is retryable
      this.clients.delete(server.id)
      this.tools.delete(server.id)
      this.errors.set(server.id, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId)
    this.clients.delete(serverId)
    this.tools.delete(serverId)
    if (client) {
      try {
        await client.close()
      } catch {
        /* transport already dead */
      }
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.servers.map((s) => this.disconnect(s.id)))
    this.servers = []
    this.errors.clear()
    this.root = null
  }

  /**
   * Execute one MCP tool. Called from AgentTools.executeTool AFTER the
   * role/permission gates — this only performs the network call.
   */
  async callTool(fullName: string, args: Record<string, unknown>): Promise<unknown> {
    const parsed = parseMcpToolName(fullName)
    if (!parsed) throw new Error(`Invalid MCP tool name: ${fullName}`)
    const client = this.clients.get(parsed.serverId)
    if (!client) {
      throw new Error(`MCP server "${parsed.serverId}" tidak terhubung — cek Settings → MCP`)
    }
    const res = (await withTimeout(
      client.callTool({ name: parsed.toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      `MCP call timeout (${CALL_TIMEOUT_MS / 1000}s): ${fullName}`
    )) as McpCallResult
    if (res.isError) {
      const msg = describeMcpError(res)
      this.errors.set(parsed.serverId, msg)
      throw new Error(msg)
    }
    if (res.structuredContent !== undefined && res.structuredContent !== null) {
      return res.structuredContent
    }
    const text = (res.content || [])
      .filter((c) => typeof c?.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
      .trim()
    if (!text) return { ok: true }
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  /**
   * AE-6: live-test a candidate server WITHOUT touching the persisted config.
   * Registers it in memory only, connects (handshake + tools/list), reports
   * tool count / error, then restores the previous list. The vault config is
   * only written on Save — this used to persist-then-restore, which wrote
   * mcp.json twice per Test click (write amplification + settings churn).
   */
  async testServer(
    server: McpServerConfig
  ): Promise<{ ok: boolean; tools: number; error?: string }> {
    this.ensureLoaded()
    const prev = this.servers
    const id = sanitizeServerId(server.id)
    try {
      this.servers = [...prev.filter((s) => s.id !== id), normalizeServer({ ...server, id })]
      await this.connect(id)
      const status = this.getStatus().find((s) => s.id === id)
      return { ok: status?.connected === true, tools: status?.tools ?? 0, error: status?.error }
    } catch (err) {
      return { ok: false, tools: 0, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await this.disconnect(id)
      this.servers = prev
      this.errors.delete(id)
    }
  }

  /** Wire vault lifecycle: fire-and-forget connect of every enabled server. */
  connectAll(): void {
    this.ensureLoaded()
    for (const s of this.servers) {
      if (s.enabled) this.connect(s.id).catch(() => {})
    }
  }

  private ensureLoaded(): void {
    const current = workspaceEngine.getState().rootPath
    if (current !== this.root) {
      this.loadConfig(current)
      // Vault switched (or closed): stale clients from the previous vault must
      // never leak into the next one. connectAll() re-establishes on demand.
      const stale = Array.from(this.clients.keys()).filter(
        (id) => !this.servers.some((s) => s.id === id)
      )
      for (const id of stale) void this.disconnect(id)
    }
  }
}

function normalizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} }
  const s = schema as Record<string, unknown>
  if (s.type !== 'object' || typeof s.properties !== 'object') {
    // Not a JSON-Schema object form — wrap it so OpenAI-compatible providers
    // still accept the tool (the arguments object itself).
    return { type: 'object', properties: {} }
  }
  return s
}

function describeSchemaArgs(schema: Record<string, unknown> | undefined): string {
  const s = normalizeSchema(schema)
  const props = s.properties as Record<string, { type?: string; description?: string }> | undefined
  if (!props) return '{}'
  const entries = Object.entries(props)
    .slice(0, 8)
    .map(([k, v]) => {
      const t = typeof v?.type === 'string' ? v.type : 'string'
      return `${k}: ${t}`
    })
  return `{ ${entries.join(', ')}${Object.keys(props).length > 8 ? ', …' : ''} }`
}

/** App-wide singleton — AgentTools + IPC handlers + workspace lifecycle share it. */
export const mcpManager = new McpClientManager()
