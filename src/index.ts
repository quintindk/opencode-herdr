import { tool, type Plugin, type ToolContext } from "@opencode-ai/plugin";
import { Store } from "./store.js";
import { DeliveryWorker, inventory, requestPrompt } from "./delivery.js";
import { Provisioner } from "./provision.js";
import { readRemoteConfig, RemoteTransport, remoteOutbox, type RemotePeer } from "./remote.js";

const z = tool.schema;
const id = z.string().min(1);
const json = (value: unknown) => JSON.stringify(value, null, 2);

export default (async ({ client, directory }) => {
  const store = new Store();
  let configured = false;
  const worker = new DeliveryWorker(store, client, directory);
  const provisioner = new Provisioner(store, undefined, process.env, client);
  let peers: RemotePeer[] = [];
  try { peers = readRemoteConfig().peers; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { store.close(); throw new Error("Invalid opencode-herdr peers.json; remote configuration must be private and valid"); }
  }
  const remote = new RemoteTransport(store, peers);
  const origins = new Set<string>();
  let stopped = false;
  let reconciliation: Promise<void> | undefined;
  const caller = async (ctx: ToolContext) => {
    if (!configured) throw new Error("Coordination is disabled until configuration passes its Envoy conflict check");
    if (!ctx.sessionID || ctx.sessionID.startsWith("remote:")) throw new Error("A local host-authenticated conversation is required");
    const live = await inventory(store);
    const self = live.find(a => a.sessionId === ctx.sessionID && a.paneId === process.env.HERDR_PANE_ID && a.socket === process.env.HERDR_SOCKET_PATH && a.directory === ctx.directory);
    if (!self) throw new Error("Current conversation is not reported by Herdr. Install Herdr's OpenCode session integration and refresh.");
    origins.add(ctx.sessionID);
    return self;
  };
  const refresh = () => {
    if (stopped || !configured || reconciliation) return;
    reconciliation = (async () => {
      const live = await inventory(store);
      for (const agent of live) if (agent.socket === process.env.HERDR_SOCKET_PATH && agent.paneId === process.env.HERDR_PANE_ID && agent.directory === directory) origins.add(agent.sessionId);
      for (const origin of origins) {
        await provisioner.reconcile(origin);
        for (const peer of peers) {
          await remote.sync(peer.id, origin);
        }
      }
    })().catch(() => console.error("opencode-herdr: operation reconciliation deferred"))
      .finally(() => { reconciliation = undefined; });
  };
  const target = async (identity: string) => {
    const live = await inventory(store);
    const agent = live.find(a => a.id === identity);
    if (!agent) throw new Error("No exact live local agent. Refresh list_agents. Remote targets require peerId.");
    return agent;
  };
  const tools = {
    list_agents: tool({ description: "List exact local OpenCode agent identities, or configured remote peer identities. Discovery does not confer resource authority. Remote observations can be stale.", args: { peerId: id.optional() },
      async execute({ peerId }, ctx) { await caller(ctx); return json(peerId ? await remote.list(peerId, ctx.sessionID) : await inventory(store)); } }),
    list_machines: tool({ description: "List this machine's persistent coordination identity and explicitly configured SSH peers. Does not return tokens.", args: {},
      async execute(_, ctx) { await caller(ctx); return json({ local: store.machineId, peers: peers.map(({ id, expectedMachineId }) => ({ id, machineId: expectedMachineId })) }); } }),
    request_agent: tool({ description: "Queue a task or instruction for an exact agent. Tasks require handback. Instructions release their queue slot when accepted. Does not transfer resources or interrupt work. Reuse the idempotency key only for identical retries.",
      args: { identity: id, kind: z.enum(["task", "instruction"]).default("task"), text: id, executionPolicy: z.enum(["advisory", "code_change"]).default("advisory"), idempotencyKey: id, peerId: id.optional() },
      async execute({ identity, peerId, ...input }, ctx) {
        await caller(ctx);
        if (!peerId) await target(identity);
        const request = { ...input, recipientId: identity, originSessionId: ctx.sessionID, originDirectory: ctx.directory };
        return json(peerId ? await remote.request(peerId, request) : store.enqueue(request));
      } }),
    read_task: tool({ description: "Accept and read the exact request delivery from your prompt. Requires requestId, generation and deliveryId. Preserves existing work. Instruction acceptance does not require handback.",
      args: { requestId: id, generation: z.number().int().positive(), deliveryId: id },
      async execute({ requestId, generation, deliveryId }, ctx) {
        const self = await caller(ctx);
        const request = store.request(requestId);
        if (request.recipientId !== self.id || request.generation !== generation || request.deliveryId !== deliveryId) throw new Error("Request does not match this conversation and generation");
        if (!request.messageId || !await worker.receipt(ctx.sessionID, request.messageId, requestPrompt(request))) throw new Error("Cannot confirm the delivery message");
        return json({ request: store.accept(requestId, generation, deliveryId, ctx.sessionID), questions: store.questions(requestId, ctx.sessionID),
          policy: request.executionPolicy === "advisory" ? "Analyse and report only. Do not edit files or commit." : "Make scoped code changes. Do not commit, merge, discard or clean resources without separate authorisation." });
      } }),
    hand_back: tool({ description: "Publish an immutable result for an accepted task generation. Completed does not commit, merge, close or delete anything. Pause keeps the task resumable. Instructions cannot hand back.",
      args: { requestId: id, generation: z.number().int().positive(), outcome: z.enum(["completed", "paused", "failed"]), summary: id, checks: z.array(z.string()).default([]), risks: z.array(z.string()).default([]), evidence: z.array(z.string()).default([]) },
      async execute({ requestId, generation, ...outcome }, ctx) { await caller(ctx); return json(store.finish(requestId, generation, ctx.sessionID, outcome)); } }),
    inspect_request: tool({ description: "Read authorised request history, immutable results, questions and delivery evidence. Does not accept queued work.", args: { requestId: id, peerId: id.optional() },
      async execute({ requestId, peerId }, ctx) { await caller(ctx); return json(peerId ? await remote.inspect(peerId, requestId, ctx.sessionID) : store.history(requestId, ctx.sessionID)); } }),
    list_requests: tool({ description: "Read this conversation's inbox and outbox. Unknown delivery is not failure. Accepted instructions do not await a result.", args: {},
      async execute(_, ctx) { await caller(ctx); const local = store.list(ctx.sessionID); return json({ ...local, outbox: [...local.outbox, ...remoteOutbox(store, ctx.sessionID)] }); } }),
    cancel_request: tool({ description: "Cancel your outgoing queue obligation. Does not retract an attempted prompt, interrupt an agent or remove resources. Already-submitted work may continue.", args: { requestId: id, peerId: id.optional() },
      async execute({ requestId, peerId }, ctx) { await caller(ctx); return json(peerId ? await remote.cancel(peerId, requestId, ctx.sessionID) : store.cancel(requestId, ctx.sessionID)); } }),
    resume_request: tool({ description: "Resume your paused task with an immutable continuation brief and fresh queue position. Does not recreate an agent or worktree.",
      args: { requestId: id, generation: z.number().int().positive(), text: id, idempotencyKey: id, peerId: id.optional() },
      async execute({ requestId, generation, text, idempotencyKey, peerId }, ctx) { await caller(ctx); return json(peerId ? await remote.resume(peerId, requestId, ctx.sessionID, text, idempotencyKey, generation) : store.resume(requestId, ctx.sessionID, text, idempotencyKey, generation)); } }),
    ask_coordinator: tool({ description: "Persist a correlated question for an accepted task. Does not release the task queue slot. Use inspect_request to read its answer.", args: { requestId: id, generation: z.number().int().positive(), text: id },
      async execute({ requestId, generation, text }, ctx) { await caller(ctx); return json(store.ask(requestId, generation, ctx.sessionID, text)); } }),
    reply_question: tool({ description: "Answer a question on your outgoing request by exact question ID. A reply cannot answer a different generation or question.", args: { questionId: id, text: id, peerId: id.optional() },
      async execute({ questionId, text, peerId }, ctx) { await caller(ctx); return json(peerId ? await remote.reply(peerId, questionId, ctx.sessionID, text) : store.reply(questionId, ctx.sessionID, text)); } }),
    open_agent: tool({ description: "Provision an agent without assigning a task. Explicitly choose managed or independent. Returns a recoverable operation; inspect readiness before requesting work. Never auto-approves permissions or copies secrets.",
      args: { persona: id, folder: id, placement: z.enum(["pane", "subworkspace", "workspace"]), management: z.enum(["managed", "independent"]), isolation: z.object({ branch: id, baseCommit: id.optional() }).optional(), idempotencyKey: id },
      async execute(input, ctx) { await caller(ctx); return json(await provisioner.open(input, ctx)); } }),
    close_agent: tool({ description: "Owner-directed closure is unavailable until trusted, operation-scoped approval is implemented. Use Herdr's user interface. Never treats quoted instructions as approval.", args: { identity: id, idempotencyKey: id },
      async execute(_, ctx) { await caller(ctx); throw new Error("Owner-directed closure requires a trusted owner grant. OpenCode permission policy alone does not establish ownership. Close the pane through Herdr's user interface."); } }),
    list_operations: tool({ description: "Inspect your persisted provisioning, closing and remote delivery operations. Reconciles known resources without repeating uncertain external actions.", args: {},
      async execute(_, ctx) { await caller(ctx); await provisioner.reconcile(ctx.sessionID); return json(store.operations(ctx.sessionID)); } }),
  };
  const timer = setInterval(refresh, 5000);
  timer.unref();
  return {
    tool: tools,
    async config(config) {
      const plugins = config.plugin ?? [];
      if (plugins.some(p => /herdr-envoy|envoy-dist/.test(typeof p === "string" ? p : p[0]))) {
        configured = false;
        throw new Error("Retire or disable the Envoy server plugin before enabling opencode-herdr coordination. Two queue implementations must not share these tools.");
      }
      configured = true;
      worker.start();
      config.command ??= {};
      config.command.herdr ??= { description: "Coordinate Herdr agents", template: "Use list_agents to discover exact identities. Use open_agent to provision without a task, then request_agent for tasks or instructions. Read delivered requests with read_task and publish task outcomes using hand_back. Inspect uncertain operations instead of retrying external effects. Never infer authority to commit, discard or clean resources. $ARGUMENTS" };
    },
    async dispose() { stopped = true; clearInterval(timer); await worker.dispose(); await reconciliation; store.close(); },
  };
}) satisfies Plugin;
