import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { DeliveryWorker, requestPrompt } from '../src/delivery.js'
import type { Notice, Request } from '../src/model.js'
import { handleRequest, remoteOutbox, remoteSession, RemoteTransport, type RemoteRunner } from '../src/remote.js'
import { Store } from '../src/store.js'

const workers: DeliveryWorker[] = []
const stores: Store[] = []
const directories: string[] = []
const envKeys = ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID'] as const
let savedEnv: (string | undefined)[]

beforeEach(() => { savedEnv = envKeys.map(key => process.env[key]) })
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  envKeys.forEach((key, index) => {
    if (savedEnv[index] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[index]
  })
})

function open(path: string) {
  const store = new Store(path)
  stores.push(store)
  return store
}

function database(name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'herdr-workflow-'))
  directories.push(directory)
  const path = join(directory, `${name}.sqlite`)
  return { path, store: open(path) }
}

// Match the delivery fixture's runtime settings and exact message readback contract.
function host(store: Store, name: string) {
  const agent = store.observeAgent({ sessionId: name, socket: `/fake/${name}.sock`, paneId: `${name}-pane`,
    terminalId: `${name}-terminal`, workspaceId: 'workspace', directory: `/project/${name}`,
    label: name, state: 'idle', lastSeen: Date.now() })
  type Prompt = { path: { id: string }; query: { directory: string }; body: {
    messageID: string; parts: { type: 'text'; text: string }[]
  } }
  const receipts = new Map<string, unknown>()
  const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) })
  const session = {
    get: mock(async () => ok({ id: agent.sessionId, directory: agent.directory,
      agent: 'reviewer', model: { providerID: 'provider', id: 'selected-model', variant: 'high' } })),
    status: mock(async () => ok({ [agent.sessionId]: { type: 'idle' } })),
    message: mock(async ({ path }: { path: { id: string; messageID: string } }) => receipts.has(path.messageID)
      ? ok(receipts.get(path.messageID))
      : { error: { name: 'NotFoundError' }, response: new Response(null, { status: 404 }) }),
    promptAsync: mock(async (input: Prompt) => {
      receipts.set(input.body.messageID, { info: { role: 'user', id: input.body.messageID, sessionID: input.path.id },
        parts: input.body.parts })
      return ok(undefined)
    }),
  }
  const publish = mock(async (..._args: unknown[]) => true)
  const worker = new DeliveryWorker(store, { session } as unknown as PluginInput['client'], agent.directory,
    async () => [agent], publish)
  workers.push(worker)
  // Simulate separate plugin processes serially without touching a real Herdr binding.
  const tick = async () => {
    process.env.HERDR_ENV = '1'
    process.env.HERDR_SOCKET_PATH = agent.socket
    process.env.HERDR_PANE_ID = agent.paneId
    await worker.tick()
  }
  const acceptPrompt = (request: Request) => {
    const prompt = session.promptAsync.mock.calls.at(-1)![0]
    expect(prompt).toMatchObject({ path: { id: agent.sessionId }, query: { directory: agent.directory },
      body: { agent: 'reviewer', model: { providerID: 'provider', modelID: 'selected-model' }, variant: 'high',
        parts: [{ type: 'text', text: requestPrompt(request) }] } })
    expect(prompt.body).not.toHaveProperty('noReply')
    expect(store.request(request.id)).toMatchObject({ state: 'submitted', messageId: prompt.body.messageID })
    const [, id, generation, deliveryId] = prompt.body.parts[0].text.match(
      /read_task with requestId="([^"]+)", generation=(\d+), deliveryId="([^"]+)"/,
    )!
    return store.accept(id, Number(generation), deliveryId, agent.sessionId)
  }
  const deliverNotice = async (notice: Notice) => {
    expect(notice).toMatchObject({ state: 'pending', sessionId: agent.sessionId, directory: agent.directory })
    const before = session.promptAsync.mock.calls.length
    await tick()
    expect(session.promptAsync).toHaveBeenCalledTimes(before + 1)
    const prompt = session.promptAsync.mock.calls.at(-1)![0]
    expect(prompt).toMatchObject({ path: { id: agent.sessionId }, query: { directory: agent.directory },
      body: { parts: [{ type: 'text', text: notice.text }] } })
    expect(store.notices(agent.sessionId).find(n => n.id === notice.id)).toMatchObject({
      state: 'delivered', messageId: prompt.body.messageID,
    })
    await tick()
    expect(session.promptAsync).toHaveBeenCalledTimes(before + 1)
  }
  return { agent, session, publish, tick, acceptPrompt, deliverNotice }
}

function fixture(remote = false) {
  const sender = database('sender')
  const receiver = remote ? database('receiver') : sender
  const origin = host(sender.store, 'origin:session')
  const recipient = host(receiver.store, 'recipient')
  const input = { originSessionId: origin.agent.sessionId, originDirectory: origin.agent.directory,
    recipientId: recipient.agent.id, kind: 'task' as const, text: 'Review the workflow', idempotencyKey: 'workflow-1' }
  return { sender: sender.store, receiver: receiver.store, senderPath: sender.path, origin, recipient, input }
}

function remoteFixture() {
  const f = fixture(true)
  const secret = 'workflow-test-token-0123456789abcdef0123456789abcdef'
  const peer = { id: 'other', sshTarget: 'worker@example.invalid', helperPath: '/fake/remote-helper.js',
    expectedMachineId: f.receiver.machineId, token: secret }
  const trust = { trustedOrigins: [{ machineId: f.sender.machineId, token: secret }] }
  const packets: { op: string; protocolVersion: number; originMachineId: string; originSessionId: string;
    expectedMachineId: string; token: string; args: Record<string, unknown> }[] = []
  let loseEnqueueReceipt = false
  const runner: RemoteRunner = async (target, command, stdin) => {
    expect(target).toBe(peer.sshTarget)
    expect(command).toBe("bun '/fake/remote-helper.js'")
    const packet = JSON.parse(stdin)
    packets.push(packet)
    const response = JSON.stringify(handleRequest(f.receiver, trust, packet))
    if (packet.op === 'enqueue' && loseEnqueueReceipt) {
      loseEnqueueReceipt = false
      throw new Error('Lost receipt after receiver committed enqueue')
    }
    return response
  }
  const remote = new RemoteTransport(f.sender, [peer], runner)
  return { ...f, peer, trust, packets, runner, remote, loseReceipt: () => { loseEnqueueReceipt = true } }
}

test('local task flows through worker acceptance, question/reply and result outbox delivery', async () => {
  const f = fixture()
  const request = f.sender.enqueue(f.input)
  expect(f.recipient.session.promptAsync).not.toHaveBeenCalled()
  expect(f.sender.list(f.input.originSessionId).outbox).toEqual([request])
  await f.recipient.tick()
  expect(f.recipient.acceptPrompt(request)).toMatchObject({ state: 'accepted', text: f.input.text })
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(1)

  const question = f.receiver.ask(request.id, request.generation, f.recipient.agent.sessionId, 'Which branch?')
  const questionNotice = f.sender.notices(f.input.originSessionId)[0]
  expect(questionNotice.text).toContain(question.id)
  expect(questionNotice.text).toContain('Which branch?')
  await f.origin.deliverNotice(questionNotice)
  f.sender.reply(question.id, f.input.originSessionId, 'main')
  const replyNotice = f.receiver.notices(f.recipient.agent.sessionId)[0]
  expect(replyNotice.text).toContain(question.id)
  await f.recipient.deliverNotice(replyNotice)
  expect(f.receiver.questions(request.id, f.recipient.agent.sessionId)).toMatchObject([
    { id: question.id, state: 'answered', reply: { sessionId: f.input.originSessionId, text: 'main' } },
  ])

  const outcome = { outcome: 'completed' as const, summary: 'Workflow reviewed', checks: ['Reviewed main'], risks: [] }
  f.receiver.finish(request.id, request.generation, f.recipient.agent.sessionId, outcome)
  const resultNotice = f.sender.notices(f.input.originSessionId)[1]
  expect(resultNotice.text).toContain(outcome.summary)
  expect(resultNotice.text).toContain(request.id)
  await f.origin.deliverNotice(resultNotice)
  expect(f.sender.list(f.input.originSessionId).outbox).toMatchObject([{ id: request.id, state: 'completed' }])
  expect(f.origin.publish.mock.calls.at(-1)?.[2]).toMatchObject({ outbox: [{ id: request.id, state: 'completed' }] })
  const history = f.sender.history(request.id, f.input.originSessionId)
  expect(history.results).toMatchObject([outcome])
  expect(history.audit.map(event => event.transition)).toEqual([
    'enqueue:1', 'attempt:1', 'submitted:1', 'accept:1', 'ask:1', 'reply:1', 'finish:1:completed',
  ])
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(2)
  expect(f.origin.session.promptAsync).toHaveBeenCalledTimes(2)
})

test('an instruction ahead of a task frees the delivery queue only on acceptance, without a result', async () => {
  const f = fixture()
  const instruction = f.sender.enqueue({ ...f.input, kind: 'instruction', text: 'Do not commit', idempotencyKey: 'instruction' })
  const task = f.sender.enqueue(f.input)
  await f.recipient.tick()
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(f.sender.pending(f.recipient.agent.id)?.id).toBe(instruction.id)
  expect(f.sender.request(task.id).state).toBe('queued')
  expect(f.recipient.acceptPrompt(instruction).state).toBe('accepted')
  expect(f.sender.pending(f.recipient.agent.id)?.id).toBe(task.id)
  expect(f.sender.history(instruction.id, f.input.originSessionId).results).toEqual([])
  expect(f.sender.notices()).toEqual([])
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(2)
  expect(f.recipient.acceptPrompt(task).state).toBe('accepted')
  const next = f.sender.enqueue({ ...f.input, idempotencyKey: 'next-task' })
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(2)
  expect(f.sender.request(next.id).state).toBe('queued')
})

test('remote workflow authenticates two stores and delivers question, reply and result through both workers', async () => {
  const f = remoteFixture()
  expect(f.sender.machineId).not.toBe(f.receiver.machineId)
  expect(await f.remote.handshake(f.peer.id, f.input.originSessionId)).toEqual({ machineId: f.receiver.machineId })
  expect(() => handleRequest(f.receiver, f.trust, { ...f.packets[0], token: `${f.peer.token}-wrong` })).toThrow('authentication')
  const request = await f.remote.request(f.peer.id, f.input)
  expect(f.packets.map(packet => packet.op)).toEqual(['handshake', 'handshake', 'enqueue'])
  expect(f.packets.every(packet => packet.protocolVersion === 1 && packet.originMachineId === f.sender.machineId &&
    packet.expectedMachineId === f.receiver.machineId && packet.originSessionId === f.input.originSessionId &&
    packet.token === f.peer.token)).toBe(true)
  expect(request.originSessionId).toBe(remoteSession(f.sender.machineId, f.input.originSessionId))
  expect(f.sender.list(f.input.originSessionId).outbox).toEqual([])
  expect(remoteOutbox(f.sender, f.input.originSessionId)).toMatchObject([{ id: request.id, state: 'queued' }])
  expect(f.recipient.session.promptAsync).not.toHaveBeenCalled()
  await f.recipient.tick()
  f.recipient.acceptPrompt(request)
  const question = f.receiver.ask(request.id, request.generation, f.recipient.agent.sessionId, 'Which branch remotely?')
  expect(f.sender.notices()).toEqual([])
  await f.remote.sync(f.peer.id, f.input.originSessionId)
  await f.remote.sync(f.peer.id, f.input.originSessionId)
  const questionNotices = f.sender.notices(f.input.originSessionId)
  expect(questionNotices).toHaveLength(1)
  expect(questionNotices[0].text).toContain(question.id)
  expect(questionNotices[0].text).toContain(question.text)
  await f.origin.deliverNotice(questionNotices[0])

  await f.remote.reply(f.peer.id, question.id, f.input.originSessionId, 'main')
  expect(f.receiver.questions(request.id, f.recipient.agent.sessionId)).toMatchObject([
    { id: question.id, state: 'answered', reply: { sessionId: request.originSessionId, text: 'main' } },
  ])
  const replies = f.receiver.notices(f.recipient.agent.sessionId)
  expect(replies).toHaveLength(1)
  expect(replies[0].text).toContain(question.id)
  await f.recipient.deliverNotice(replies[0])
  const outcome = { outcome: 'completed' as const, summary: 'Remote review complete', checks: ['Reviewed main'], risks: [], evidence: ['review-report'] }
  f.receiver.finish(request.id, request.generation, f.recipient.agent.sessionId, outcome)
  expect(f.sender.notices(f.input.originSessionId)).toHaveLength(1)
  await f.remote.sync(f.peer.id, f.input.originSessionId)
  await f.remote.sync(f.peer.id, f.input.originSessionId)
  const notices = f.sender.notices(f.input.originSessionId)
  expect(notices).toHaveLength(2)
  expect(notices[1].text).toContain(outcome.summary)
  expect(notices[1].text).toContain('review-report')
  await f.origin.deliverNotice(notices[1])
  expect(remoteOutbox(f.sender, f.input.originSessionId)).toMatchObject([{ id: request.id, state: 'completed' }])
  expect(f.origin.publish.mock.calls.at(-1)?.[2]).toMatchObject({ outbox: [{ id: request.id, state: 'completed' }] })
  expect(f.sender.operations(f.input.originSessionId)[0].result?.history).toEqual(f.receiver.history(request.id, request.originSessionId))
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(2)
  expect(f.origin.session.promptAsync).toHaveBeenCalledTimes(2)
})

test('lost remote enqueue receipt is recovered by sync after restart with the same IDs and no duplicate model prompt', async () => {
  const f = remoteFixture()
  f.loseReceipt()
  await expect(f.remote.request(f.peer.id, f.input)).rejects.toThrow('outcome unknown')
  const operation = f.sender.operations(f.input.originSessionId)[0]
  expect(operation.state).toBe('unknown')
  const [request] = f.receiver.list(remoteSession(f.sender.machineId, f.input.originSessionId)).outbox
  expect(request.state).toBe('queued')
  await f.recipient.tick()
  const submitted = f.receiver.request(request.id)
  expect(submitted.state).toBe('submitted')
  const restarted = new RemoteTransport(open(f.senderPath), [f.peer], f.runner)
  const recovered = await restarted.sync(f.peer.id, f.input.originSessionId)
  expect(recovered).toMatchObject([{ id: request.id, deliveryId: request.deliveryId, messageId: submitted.messageId, state: 'submitted' }])
  expect(f.sender.operations(f.input.originSessionId)).toMatchObject([{ id: operation.id, state: 'confirmed' }])
  const enqueues = f.packets.filter(packet => packet.op === 'enqueue')
  expect(enqueues).toHaveLength(2)
  expect(enqueues[1]).toEqual(enqueues[0])
  await restarted.sync(f.peer.id, f.input.originSessionId)
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(f.recipient.acceptPrompt(request).state).toBe('accepted')
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(1)
  expect(f.receiver.list(request.originSessionId).outbox).toHaveLength(1)
  const history = f.receiver.history(request.id, request.originSessionId)
  expect(history.deliveries).toHaveLength(1)
  expect(history.audit.filter(event => event.transition === 'attempt:1')).toHaveLength(1)
})

test.each([false, true])('late outcome after cancellation preserves history and delivers a result without clearing cancellation (remote: %j)', async remote => {
  const f = remote ? remoteFixture() : fixture()
  const transport = 'remote' in f ? f.remote : undefined
  const request = transport ? await transport.request('other', f.input) : f.sender.enqueue(f.input)
  await f.recipient.tick()
  f.recipient.acceptPrompt(request)
  const cancelled = transport ? await transport.cancel('other', request.id, f.input.originSessionId)
    : f.sender.cancel(request.id, f.input.originSessionId)
  expect(cancelled).toMatchObject({ state: 'cancelled', mayContinue: true })
  const outcome = { outcome: 'completed' as const, summary: 'Already-running review finished', checks: ['Reviewed before cancellation arrived'], risks: ['Cancellation arrived after submission'] }
  expect(f.receiver.finish(request.id, request.generation, f.recipient.agent.sessionId, outcome)).toMatchObject({
    state: 'cancelled', mayContinue: true, summary: outcome.summary,
  })
  if (transport) {
    await transport.sync('other', f.input.originSessionId)
    await transport.sync('other', f.input.originSessionId)
  }
  const history = f.receiver.history(request.id, request.originSessionId)
  expect(history.results).toMatchObject([outcome])
  expect(history.deliveries).toMatchObject([{ id: request.deliveryId, state: 'accepted' }])
  expect(history.audit.map(event => event.transition)).toEqual([
    'enqueue:1', 'attempt:1', 'submitted:1', 'accept:1', 'cancel:1', 'finish:1:completed',
  ])
  if (transport) expect(f.sender.operations(f.input.originSessionId)[0].result?.history).toEqual(history)
  const notices = f.sender.notices(f.input.originSessionId)
  expect(notices).toHaveLength(1)
  expect(notices[0].text).toContain(outcome.summary)
  expect(notices[0].text).toContain('cancelled')
  await f.origin.deliverNotice(notices[0])
  const outbox = transport ? remoteOutbox(f.sender, f.input.originSessionId) : f.sender.list(f.input.originSessionId).outbox
  expect(outbox).toMatchObject([{ id: request.id, state: 'cancelled', mayContinue: true }])
  await f.recipient.tick()
  expect(f.recipient.session.promptAsync).toHaveBeenCalledTimes(1)
})
