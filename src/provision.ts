import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PluginInput, ToolContext } from '@opencode-ai/plugin'
import type { Agent, Operation } from './model.js'
import type { Store } from './store.js'

export type ProvisionRunner = (file: string, args: string[], options: ExecFileOptionsWithStringEncoding) => Promise<{ stdout: string; stderr: string }>
export type OpenInput = {
  persona: string
  folder: string
  placement: 'pane' | 'subworkspace' | 'workspace'
  management: 'managed' | 'independent'
  isolation?: { branch: string; baseCommit?: string }
  idempotencyKey: string
}

// Store must implement these transactionally. A close claim must exclude other closes
// and pending/active deliveries; enqueue/resume/attempt must honour closingAgent too.
export interface ProvisionClaims {
  claimOperation(id: string, expectedState: string, nextState: string): boolean
  closingAgent(identity: string): boolean
}
type Fields = Record<string, unknown>
type Pane = { paneId: string; terminalId: string; workspaceId: string; directory: string; sessionId?: string; state: string }

function object(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provision record')
  return value as Fields
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Expected nonblank single-line text')
  return value
}
function absolute(value: unknown): string {
  const path = text(value)
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Folder must be absolute and normalised')
  return path
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'` }
function pane(value: unknown): Pane {
  const p = object(value)
  const session = p.agent_session == null ? undefined : object(p.agent_session)
  return {
    paneId: text(p.pane_id), terminalId: text(p.terminal_id), workspaceId: text(p.workspace_id),
    directory: absolute(p.cwd), state: typeof p.agent_status === 'string' ? p.agent_status : 'unknown',
    ...(p.agent === 'opencode' && session?.agent === 'opencode' && session.kind === 'id' ? { sessionId: text(session.value) } : {}),
  }
}
function matches(a: Pane, b: Pick<Agent, 'paneId' | 'terminalId' | 'workspaceId' | 'directory'>): boolean {
  return a.paneId === b.paneId && a.terminalId === b.terminalId && a.workspaceId === b.workspaceId && a.directory === b.directory
}

export class Provisioner {
  private readonly origins = new Set<string>()
  private readonly claims: ProvisionClaims
  private readonly plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../dist/index.js')

  constructor(private readonly store: Store, private readonly run: ProvisionRunner = promisify(execFile), private readonly env: NodeJS.ProcessEnv = process.env, private readonly client?: PluginInput['client']) {
    const claims = store as Store & Partial<ProvisionClaims>
    if (typeof claims.claimOperation !== 'function' || typeof claims.closingAgent !== 'function') {
      throw new Error('Provisioner requires atomic Store.claimOperation and Store.closingAgent (with dispatch exclusion)')
    }
    this.claims = claims as Store & ProvisionClaims
    if (typeof client?.session?.create !== 'function') throw new Error('Provisioner requires an OpenCode client for exact session creation')
  }

  private context(): { socket: string; callerPane: string } {
    if (this.env.HERDR_ENV !== '1') throw new Error('Provisioning requires a local herdr pane')
    return { socket: absolute(this.env.HERDR_SOCKET_PATH), callerPane: text(this.env.HERDR_PANE_ID) }
  }

  private async command(file: string, args: string[], cwd?: string, signal?: AbortSignal, env = this.env): Promise<string> {
    const output = await this.run(file, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env, ...(cwd ? { cwd } : {}), ...(signal ? { signal } : {}) })
    return output.stdout
  }

  private async herdr(args: string[], signal?: AbortSignal): Promise<Fields> {
    return object(object(JSON.parse(await this.command('herdr', args, undefined, signal))).result)
  }

  private current(operation: Operation): Operation {
    const current = this.store.operations(operation.originSessionId).find(item => item.id === operation.id)
    if (!current) throw new Error('Missing provision operation')
    return current
  }

  private checkpoint(operation: Operation, state: string, fields: Fields): Operation {
    return this.store.updateOperation(operation.id, state, { ...operation.result, ...fields })
  }

  private async inventory(signal?: AbortSignal): Promise<Pane[]> {
    const result = await this.herdr(['agent', 'list'], signal)
    if (!Array.isArray(result.agents)) throw new Error('Invalid herdr agent inventory')
    return result.agents.map(pane)
  }

  async open(input: OpenInput, ctx: ToolContext): Promise<Operation> {
    if (Object.keys(input).some(key => !['persona', 'folder', 'placement', 'management', 'isolation', 'idempotencyKey'].includes(key))) throw new Error('Unknown open field; tasks are not launch arguments')
    const context = this.context()
    const folder = absolute(input.folder)
    const persona = text(input.persona)
    if (persona.startsWith('-') || /\s/.test(persona)) throw new Error('Invalid persona')
    if (!['pane', 'workspace', 'subworkspace'].includes(input.placement) || !['managed', 'independent'].includes(input.management)) throw new Error('Invalid placement or management')
    if (input.placement === 'subworkspace' && !input.isolation) throw new Error('Subworkspace requires isolation')
    if (input.placement === 'workspace' && input.isolation) throw new Error('Workspace uses the existing folder without isolation')
    if (input.isolation && Object.keys(input.isolation).some(key => !['branch', 'baseCommit'].includes(key))) throw new Error('Unknown isolation field')
    const isolation = input.isolation ? { branch: text(input.isolation.branch), baseCommit: input.isolation.baseCommit === undefined ? 'HEAD' : text(input.isolation.baseCommit) } : null
    this.origins.add(ctx.sessionID)
    let op = this.store.beginOperation('open_agent', ctx.sessionID, text(input.idempotencyKey), {
      persona, folder, placement: input.placement, management: input.management, isolation, ...context,
    })
    if (!this.claims.claimOperation(op.id, 'requested', 'preparing')) return this.current(op)
    op = this.current(op)
    try {
      ctx.abort.throwIfAborted()
      if (await realpath(folder) !== folder || !(await stat(folder)).isDirectory()) throw new Error('Folder must be a real directory, not a symlink')
      if (this.env.OPENCODE_PURE === '1' || this.env.OPENCODE_PURE === 'true') throw new Error('OPENCODE_PURE disables the coordination plugin')
      const config = JSON.stringify({ plugin: [this.plugin] })
      const launchEnv = { ...this.env, OPENCODE_CONFIG_CONTENT: config }
      const assertPersona = async (cwd: string) => {
        const listing = await this.command('opencode', ['agent', 'list'], cwd, ctx.abort, launchEnv)
        if (!listing.split('\n').some(line => /^(\S+)\s+\((primary|subagent|all)\)\s*$/.exec(line.trim())?.[1] === persona)) throw new Error('Persona is not available in the destination configuration')
      }
      await assertPersona(folder)
      let destination = folder
      let baseCommit = ''
      if (isolation) {
        const root = await realpath((await this.command('git', ['-C', folder, 'rev-parse', '--show-toplevel'], folder, ctx.abort)).trim())
        const checkedBranch = (await this.command('git', ['-C', folder, 'check-ref-format', '--branch', isolation.branch], folder, ctx.abort)).trim()
        if (checkedBranch !== isolation.branch || isolation.branch.startsWith('-')) throw new Error('Isolation requires a literal fresh branch')
        const branches = await this.command('git', ['-C', folder, 'for-each-ref', '--format=%(refname)', `refs/heads/${isolation.branch}`], folder, ctx.abort)
        if (branches.trim()) throw new Error('Isolation branch already exists')
        baseCommit = (await this.command('git', ['-C', folder, 'rev-parse', '--verify', '--end-of-options', `${isolation.baseCommit}^{commit}`], folder, ctx.abort)).trim()
        if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error('Invalid resolved base commit')
        const parent = join(absolute(this.env.HOME || homedir()), '.config', 'opencode', 'opencode-herdr', 'worktrees')
        destination = join(parent, op.id)
        const rel = relative(root, destination)
        if (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)) throw new Error('Isolation worktree must be outside the repository')
        for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
          try {
            if (await realpath(ancestor) !== ancestor) throw new Error('Worktree parent must not contain symlinks')
            break
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        op = this.checkpoint(op, 'uncertain', { effect: 'worktree_directory', destination, branch: isolation.branch, baseCommit })
        await mkdir(parent, { recursive: true, mode: 0o700 })
        if (await realpath(parent) !== parent) throw new Error('Worktree parent must not contain symlinks')
        try { await lstat(destination); throw new Error('Worktree destination already exists') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        op = this.checkpoint(op, 'preparing', { effect: null })
        if (input.placement === 'pane') {
          op = this.checkpoint(op, 'uncertain', { effect: 'worktree_add' })
          await this.command('git', ['-C', folder, 'worktree', 'add', '-b', isolation.branch, destination, baseCommit], folder, ctx.abort)
          op = this.checkpoint(op, 'preparing', { effect: null, worktreeCreated: true })
          await assertPersona(destination)
        }
      }
      const label = `${persona}-${op.id}`
      op = this.checkpoint(op, 'uncertain', { effect: 'placement', destination, label })
      let receipt: Fields
      let workspaceId: string | undefined
      if (input.placement === 'pane') {
        const result = await this.herdr(['pane', 'split', context.callerPane, '--direction', 'right', '--cwd', destination, '--no-focus'], ctx.abort)
        receipt = object(result.pane)
      } else {
        const args = input.placement === 'workspace'
          ? ['workspace', 'create', '--cwd', folder, '--label', label, '--no-focus']
          : ['worktree', 'create', '--cwd', folder, '--branch', isolation!.branch, '--base', baseCommit, '--path', destination, '--label', label, '--no-focus']
        const result = await this.herdr(args, ctx.abort)
        receipt = object(result.root_pane)
        op = this.checkpoint(op, 'uncertain', {
          ...(typeof receipt.pane_id === 'string' ? { paneId: receipt.pane_id } : {}),
          ...(typeof receipt.terminal_id === 'string' ? { terminalId: receipt.terminal_id } : {}),
        })
        workspaceId = text(object(result.workspace).workspace_id)
        op = this.checkpoint(op, 'uncertain', { workspaceId })
        if (input.placement === 'subworkspace' && object(result.worktree).path !== destination) throw new Error('Worktree receipt mismatch')
      }
      // Retain returned identifiers even when the following readback cannot prove the binding.
      op = this.checkpoint(op, 'uncertain', {
        ...(typeof receipt.pane_id === 'string' ? { paneId: receipt.pane_id } : {}),
        ...(typeof receipt.terminal_id === 'string' ? { terminalId: receipt.terminal_id } : {}),
      })
      const paneId = text(receipt.pane_id)
      const terminalId = text(receipt.terminal_id)
      const verified = pane((await this.herdr(['pane', 'get', paneId], ctx.abort)).pane)
      if (verified.paneId !== paneId || verified.terminalId !== terminalId || verified.directory !== destination ||
          (workspaceId && verified.workspaceId !== workspaceId) || verified.sessionId) throw new Error('Created pane binding changed or already has a conversation')
      op = this.checkpoint(op, 'preparing', { effect: null, workspaceId: verified.workspaceId })
      if (input.placement === 'subworkspace') await assertPersona(destination)
      ctx.abort.throwIfAborted()
      op = this.checkpoint(op, 'uncertain', { effect: 'session_create' })
      const session = await this.client!.session.create({ query: { directory: destination }, body: { title: label }, throwOnError: true, signal: ctx.abort })
      const expectedSessionId = text(session.data.id)
      op = this.checkpoint(op, 'preparing', { effect: null, expectedSessionId })
      ctx.abort.throwIfAborted()
      op = this.checkpoint(op, 'uncertain', { effect: 'launch', launchAttempted: true })
      const ready = 'Initialise this conversation for Herdr coordination. No task has been assigned. Call list_requests to check your inbox, then wait for work. Do not edit files, commit, or close resources.'
      await this.herdr(['pane', 'run', paneId, `env OPENCODE_CONFIG_CONTENT=${quote(config)} opencode --session ${quote(expectedSessionId)} --agent ${quote(persona)} --prompt ${quote(ready)}`], ctx.abort)
      op = this.checkpoint(op, 'launching', { effect: null })
      return await this.observeOpen(op, ctx.abort)
    } catch {
      // CLI diagnostics may contain environment/configuration secrets. Keep only the stage.
      return this.checkpoint(op, op.state === 'preparing' ? 'failed' : op.state === 'launching' ? 'launching' : 'uncertain', { error: 'Provisioning did not complete; resources retained for inspection' })
    }
  }

  private async observeOpen(op: Operation, signal?: AbortSignal): Promise<Operation> {
    op = this.current(op)
    // Never adopt a terminal occupant without the session-create receipt.
    if (op.state !== 'launching' && !(op.state === 'uncertain' && op.result?.effect === 'launch')) return op
    const r = op.result
    if (!r?.launchAttempted || !r.paneId || !r.terminalId || !r.workspaceId || !r.destination || !r.expectedSessionId) return op
    if (op.payload.socket !== this.context().socket) return op
    const binding = { paneId: text(r.paneId), terminalId: text(r.terminalId), workspaceId: text(r.workspaceId), directory: absolute(r.destination) }
    const inventory = await this.inventory(signal)
    const candidates = inventory.filter(p => matches(p, binding) && p.sessionId === r.expectedSessionId)
    if (candidates.length !== 1 || inventory.filter(p => p.terminalId === binding.terminalId).length !== 1) return op
    const found = candidates[0]
    this.store.bindProvision(op.id, { ...binding, sessionId: found.sessionId!, socket: text(op.payload.socket), state: found.state,
      label: text(r.label), lastSeen: Date.now(), management: op.payload.management as Agent['management'],
      ...(op.payload.management === 'managed' ? { managerSessionId: op.originSessionId } : {}),
    })
    return this.current(op)
  }

  // Internal lifecycle implementation/tests only. Do not expose as a tool until a
  // trusted operation-scoped owner grant exists: ctx.ask may auto-allow by policy.
  async close(input: { identity: string; idempotencyKey: string }, ctx: ToolContext): Promise<Operation> {
    if (Object.keys(input).some(key => !['identity', 'idempotencyKey'].includes(key))) throw new Error('Unknown close field')
    const context = this.context()
    this.origins.add(ctx.sessionID)
    let op = this.store.beginOperation('close_agent', ctx.sessionID, text(input.idempotencyKey), { identity: text(input.identity), socket: context.socket })
    // The Store transaction must reserve the recipient against dispatch, not just this key.
    if (!this.claims.claimOperation(op.id, 'requested', 'authorising')) return this.current(op)
    op = this.current(op)
    try {
      const agent = this.store.agent(input.identity)
      if (agent.socket !== context.socket || agent.machineId !== this.store.machineId || agent.sessionId === ctx.sessionID) throw new Error('Close requires a different exact local conversation')
      const inspect = async () => {
        if (!this.claims.closingAgent(agent.id)) throw new Error('Close reservation is missing')
        if (this.store.pending(agent.id) || this.store.list(agent.sessionId).inbox.some(r => ['queued', 'unknown', 'submitted', 'accepted', 'paused'].includes(r.state) || r.mayContinue)) throw new Error('Agent has unresolved requests')
        const inventory = await this.inventory(ctx.abort)
        const candidates = inventory.filter(p => p.paneId === agent.paneId || p.terminalId === agent.terminalId || p.sessionId === agent.sessionId)
        if (candidates.length !== 1 || !matches(candidates[0], agent) || candidates[0].sessionId !== agent.sessionId || !['idle', 'done'].includes(candidates[0].state)) throw new Error('Exact agent is not idle or done')
      }
      await inspect()
      op = this.checkpoint(op, 'authorising', { binding: { ...agent } })
      await ctx.ask({ permission: 'opencode_herdr.close_agent', patterns: [agent.id], always: [], metadata: {
        identity: agent.id, sessionId: agent.sessionId, paneId: agent.paneId, terminalId: agent.terminalId,
        workspaceId: agent.workspaceId, directory: agent.directory, socket: agent.socket,
      } })
      ctx.abort.throwIfAborted()
      await inspect()
      op = this.checkpoint(op, 'uncertain', { effect: 'pane_close' })
      await this.herdr(['pane', 'close', agent.paneId], ctx.abort)
      return await this.observeClose(op, ctx.abort)
    } catch {
      return this.checkpoint(op, op.state === 'uncertain' ? 'uncertain' : 'failed', { error: 'Close not confirmed; no resource cleanup was performed' })
    }
  }

  private async observeClose(op: Operation, signal?: AbortSignal): Promise<Operation> {
    if (op.result?.effect !== 'pane_close' || !op.result.binding || op.payload.socket !== this.context().socket) return op
    const binding = object(op.result.binding)
    const inventory = await this.inventory(signal)
    if (inventory.some(p => p.terminalId === binding.terminalId || p.sessionId === binding.sessionId || p.paneId === binding.paneId)) return op
    const result = await this.herdr(['pane', 'list', '--workspace', text(binding.workspaceId)], signal)
    if (!Array.isArray(result.panes)) throw new Error('Invalid herdr pane inventory')
    if (result.panes.map(value => object(value)).some(p => p.pane_id === binding.paneId || p.terminal_id === binding.terminalId)) return op
    return this.checkpoint(op, 'closed', { effect: null, error: null })
  }

  // Readback only. No resource creation, relaunch, close replay, or automatic Git cleanup.
  async reconcile(originSessionId?: string): Promise<void> {
    if (originSessionId) this.origins.add(originSessionId)
    for (const origin of this.origins) {
      for (const op of this.store.operations(origin)) {
        try {
          if (op.kind === 'open_agent' && op.result?.expectedSessionId &&
              (op.state === 'launching' || (op.state === 'uncertain' && op.result.effect === 'launch'))) await this.observeOpen(op)
          if (op.kind === 'close_agent' && op.state === 'uncertain') await this.observeClose(op)
        } catch { /* Failed readback leaves the persisted uncertainty unchanged. */ }
      }
    }
  }
}
