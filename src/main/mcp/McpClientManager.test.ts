import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  mcpManager,
  sanitizeServerId,
  parseMcpToolName,
  MCP_TOOL_PREFIX,
  type McpServerConfig
} from './McpClientManager'
import { executeTool } from '../ai/AgentTools'

/**
 * Tiny real MCP server (stdio) exercising all three classification shapes:
 * - echo: no annotations → treated as WRITE (safe default)
 * - count_words: readOnlyHint → read
 * - write_file: destructiveHint → write
 * Uses NODE_PATH to resolve the SDK from the project's node_modules (the
 * script itself lives in a temp dir, outside the project).
 */
const SERVER_SRC = `
const { Server } = require('@modelcontextprotocol/sdk/server/index.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js')
const server = new Server({ name: 'wg-test-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'echo', description: 'Echo the given text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'count_words', description: 'Count words in text', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
    { name: 'write_file', description: 'Write a file', annotations: { destructiveHint: true }, inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
  ]
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params
  if (name === 'echo') return { content: [{ type: 'text', text: 'echo:' + String(args.text || '') }] }
  if (name === 'count_words') return { content: [{ type: 'text', text: String(String(args.text || '').trim().split(/\\s+/).filter(Boolean).length) }] }
  if (name === 'write_file') return { content: [{ type: 'text', text: 'wrote ' + String(args.path || '') }] }
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true }
})
server.connect(new StdioServerTransport())
`

describe('McpClientManager', () => {
  let tmp: string
  let serverFile: string
  const baseServer = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    id: 'test',
    name: 'Test Server',
    transport: 'stdio',
    command: process.execPath,
    args: [serverFile],
    // The server script lives in a temp dir outside the project — NODE_PATH
    // lets its `require('@modelcontextprotocol/sdk/...')` resolve here.
    env: { NODE_PATH: path.resolve(__dirname, '../../..', 'node_modules') },
    enabled: true,
    allowWriteTools: false,
    ...over
  })

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mcp-'))
    serverFile = path.join(tmp, 'mcp-server.cjs')
    fs.writeFileSync(serverFile, SERVER_SRC, 'utf-8')
  })

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  beforeEach(async () => {
    await mcpManager.disconnectAll()
    mcpManager.loadConfig(tmp)
  })

  afterEach(async () => {
    await mcpManager.disconnectAll()
  })

  describe('naming + parsing', () => {
    it('sanitizeServerId keeps alnum/_/- and lowercases', () => {
      expect(sanitizeServerId('My Server!')).toBe('my_server')
      expect(sanitizeServerId('  GitHub  ')).toBe('github')
      expect(sanitizeServerId('')).toMatch(/^srv/)
      expect(sanitizeServerId('a'.repeat(100)).length).toBeLessThanOrEqual(40)
    })

    it('parseMcpToolName splits on the SECOND __ (tool names may contain _)', () => {
      expect(parseMcpToolName(`${MCP_TOOL_PREFIX}test__echo`)).toEqual({
        serverId: 'test',
        toolName: 'echo'
      })
      expect(parseMcpToolName(`${MCP_TOOL_PREFIX}test__my_long_tool`)).toEqual({
        serverId: 'test',
        toolName: 'my_long_tool'
      })
      expect(parseMcpToolName('search')).toBeNull()
      expect(parseMcpToolName(`${MCP_TOOL_PREFIX}`)).toBeNull()
      expect(parseMcpToolName(`${MCP_TOOL_PREFIX}__`)).toBeNull()
    })
  })

  describe('config persistence', () => {
    it('save → file roundtrip → load', () => {
      const res = mcpManager.saveServers([baseServer()], tmp)
      expect(res.ok).toBe(true)
      const file = path.join(tmp, '.workspacegraph', 'mcp.json')
      expect(fs.existsSync(file)).toBe(true)
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
      expect(parsed.version).toBe(1)
      expect(parsed.servers).toHaveLength(1)
      expect(parsed.servers[0].id).toBe('test')

      // Fresh manager view from disk (disconnectAll wipes the in-memory list)
      mcpManager.disconnectAll()
      mcpManager.loadConfig(tmp)
      expect(mcpManager.getServers()).toHaveLength(1)
      expect(mcpManager.getServers()[0].command).toBe(process.execPath)
    })

    it('rejects invalid entries and sanitizes ids', () => {
      const bad = { ...baseServer(), id: '', transport: 'tcp' } as unknown as McpServerConfig
      const res = mcpManager.saveServers([bad, baseServer({ id: 'Has Spaces' })], tmp)
      expect(res.ok).toBe(true)
      const servers = mcpManager.getServers()
      expect(servers).toHaveLength(1)
      expect(servers[0].id).toBe('has_spaces')
    })

    it('save without a vault root fails cleanly', () => {
      // Fresh manager (root cleared) with no vault → no config path
      mcpManager.disconnectAll()
      const res = mcpManager.saveServers([baseServer()], null)
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
    })
  })

  describe('connect + discovery (real stdio server)', () => {
    it('connects, lists 3 tools, classifies from annotations', async () => {
      await mcpManager.saveServers([baseServer()], tmp)
      const statuses = await mcpManager.ensureConnected(['test'])
      const st = statuses.find((s) => s.id === 'test')
      expect(st?.connected).toBe(true)
      expect(st?.tools).toBe(3)

      // readOnlyHint → read
      expect(mcpManager.isReadTool(`${MCP_TOOL_PREFIX}test__count_words`)).toBe(true)
      expect(mcpManager.isWriteTool(`${MCP_TOOL_PREFIX}test__count_words`)).toBe(false)
      // destructiveHint / no annotation → write (safe default)
      expect(mcpManager.isWriteTool(`${MCP_TOOL_PREFIX}test__write_file`)).toBe(true)
      expect(mcpManager.isWriteTool(`${MCP_TOOL_PREFIX}test__echo`)).toBe(true)
      expect(mcpManager.isReadTool(`${MCP_TOOL_PREFIX}test__echo`)).toBe(false)
      // Non-MCP names never classify
      expect(mcpManager.isReadTool('read_note')).toBe(false)
      expect(mcpManager.isWriteTool('read_note')).toBe(false)
    }, 20000)

    it('callTool executes and returns formatted text', async () => {
      await mcpManager.saveServers([baseServer()], tmp)
      await mcpManager.ensureConnected(['test'])
      expect(await mcpManager.callTool(`${MCP_TOOL_PREFIX}test__echo`, { text: 'halo' })).toBe(
        'echo:halo'
      )
      // JSON-parsable text is returned structured (count '4' → number 4)
      expect(
        await mcpManager.callTool(`${MCP_TOOL_PREFIX}test__count_words`, { text: 'a b c d' })
      ).toBe(4)
    }, 20000)

    it('callTool on a disconnected server throws a clear error', async () => {
      await mcpManager.saveServers([baseServer()], tmp)
      await expect(mcpManager.callTool(`${MCP_TOOL_PREFIX}test__echo`, {})).rejects.toThrow(
        /tidak terhubung/
      )
    }, 10000)
  })

  describe('write gate', () => {
    it('isWriteAllowed follows the server toggle', async () => {
      await mcpManager.saveServers([baseServer()], tmp)
      await mcpManager.ensureConnected(['test'])
      expect(mcpManager.isWriteAllowed(`${MCP_TOOL_PREFIX}test__write_file`)).toBe(false)

      await mcpManager.saveServers([baseServer({ allowWriteTools: true })], tmp)
      await mcpManager.ensureConnected(['test'])
      expect(mcpManager.isWriteAllowed(`${MCP_TOOL_PREFIX}test__write_file`)).toBe(true)
    }, 20000)

    it('getToolSchemas/getFenceDocs hide write tools when canWrite=false', async () => {
      await mcpManager.saveServers([baseServer({ allowWriteTools: true })], tmp)
      await mcpManager.ensureConnected(['test'])

      const all = mcpManager.getToolSchemas(true).map((s) => s.function.name)
      expect(all).toContain(`${MCP_TOOL_PREFIX}test__echo`)
      expect(all).toContain(`${MCP_TOOL_PREFIX}test__write_file`)

      // Researcher view: reads only, write tools never advertised
      const readOnly = mcpManager.getToolSchemas(false).map((s) => s.function.name)
      expect(readOnly).toContain(`${MCP_TOOL_PREFIX}test__count_words`)
      expect(readOnly).not.toContain(`${MCP_TOOL_PREFIX}test__write_file`)

      const docs = mcpManager.getFenceDocs(false)
      expect(docs.some((d) => d.name === `${MCP_TOOL_PREFIX}test__count_words`)).toBe(true)
      expect(docs.some((d) => d.name === `${MCP_TOOL_PREFIX}test__write_file`)).toBe(false)
    }, 20000)

    it('disabled servers never advertise or connect', async () => {
      await mcpManager.saveServers([baseServer({ enabled: false })], tmp)
      const statuses = await mcpManager.ensureConnected()
      const st = statuses.find((s) => s.id === 'test')
      expect(st?.connected).toBe(false)
      expect(mcpManager.getToolSchemas(true)).toHaveLength(0)
    }, 10000)
  })

  describe('AgentTools integration (executeTool routing + gates)', () => {
    it('routes MCP tools and enforces role + server gates', async () => {
      await mcpManager.saveServers([baseServer({ allowWriteTools: true })], tmp)
      await mcpManager.ensureConnected(['test'])

      // general may write (server toggle on)
      const write = await executeTool(
        { tool: `${MCP_TOOL_PREFIX}test__write_file`, args: { path: 'x' } },
        'general'
      )
      expect(write.ok).toBe(true)
      expect(write.result).toBe('wrote x')

      // researcher: write denied even with the server toggle on
      const denied = await executeTool(
        { tool: `${MCP_TOOL_PREFIX}test__write_file`, args: { path: 'x' } },
        'researcher'
      )
      expect(denied.ok).toBe(false)
      expect(denied.error).toMatch(/tidak diizinkan/)

      // server toggle off: writer blocked too
      await mcpManager.saveServers([baseServer()], tmp)
      await mcpManager.ensureConnected(['test'])
      const blocked = await executeTool(
        { tool: `${MCP_TOOL_PREFIX}test__write_file`, args: { path: 'x' } },
        'writer'
      )
      expect(blocked.ok).toBe(false)
      expect(blocked.error).toMatch(/diblokir/)

      // reads run for every role
      const read = await executeTool(
        { tool: `${MCP_TOOL_PREFIX}test__count_words`, args: { text: 'a b' } },
        'researcher'
      )
      expect(read.ok).toBe(true)
      expect(read.result).toBe(2)
    }, 30000)

    it('AgentTools classification feeds the read/write split', () => {
      // Reuse the exported isReadTool/isWriteTool through the mcp manager state
      expect(mcpManager.isMcpTool(`${MCP_TOOL_PREFIX}test__echo`)).toBe(true)
      expect(mcpManager.isMcpTool('read_note')).toBe(false)
    })
  })

  describe('lifecycle hygiene', () => {
    it('saveServers prunes removed servers and rejects duplicate ids', async () => {
      await mcpManager.saveServers([baseServer(), baseServer({ id: 'test2', name: 'Test2' })], tmp)
      await mcpManager.ensureConnected()
      expect(mcpManager.getStatus().filter((s) => s.connected)).toHaveLength(2)

      // Removing a server must drop its live connection (no process leak)
      await mcpManager.saveServers([baseServer()], tmp)
      const after = mcpManager.getStatus()
      expect(after).toHaveLength(1)
      expect(after[0].id).toBe('test')
      expect(after[0].connected).toBe(true)

      // Duplicate ids would clobber each other's clients — rejected cleanly
      const dup = mcpManager.saveServers([baseServer(), baseServer()], tmp)
      expect(dup.ok).toBe(false)
      expect(dup.error).toMatch(/Duplicate/)
      // Config untouched by the rejected write
      expect(mcpManager.getServers()).toHaveLength(1)
    }, 20000)

    it('toggle allowWriteTools keeps the live connection (no reconnect storm)', async () => {
      await mcpManager.saveServers([baseServer()], tmp)
      await mcpManager.ensureConnected(['test'])
      expect(mcpManager.getStatus()[0].connected).toBe(true)

      // Toggle only — the gate reads config live, so the connection survives
      await mcpManager.saveServers([baseServer({ allowWriteTools: true })], tmp)
      expect(mcpManager.getStatus()[0].connected).toBe(true)
      expect(mcpManager.isWriteAllowed(`${MCP_TOOL_PREFIX}test__write_file`)).toBe(true)
      // ensureConnected skips already-connected servers (no churn)
      await mcpManager.ensureConnected()
      expect(mcpManager.getStatus()[0].connected).toBe(true)
    }, 20000)
  })

  describe('failure handling', () => {
    it('bad command records a status error without rejecting ensureConnected', async () => {
      await mcpManager.saveServers(
        [baseServer({ command: 'definitely-not-a-real-command-xyz' })],
        tmp
      )
      const statuses = await mcpManager.ensureConnected(['test'])
      const st = statuses.find((s) => s.id === 'test')
      expect(st?.connected).toBe(false)
      expect(st?.error).toBeTruthy()
    }, 20000)

    it('disconnectAll leaves a clean slate', async () => {
      await mcpManager.saveServers([baseServer()], tmp)
      await mcpManager.ensureConnected(['test'])
      expect(mcpManager.getStatus()[0].connected).toBe(true)
      await mcpManager.disconnectAll()
      expect(mcpManager.getServers()).toHaveLength(0)
      expect(mcpManager.getStatus()).toHaveLength(0)
    }, 20000)
  })
})
