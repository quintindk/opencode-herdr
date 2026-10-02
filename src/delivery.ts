import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import type { PluginInput } from "@opencode-ai/plugin";
import type { Store } from "./store.js";
import type { Agent, Request } from "./model.js";
import { createSidebarPublisher } from "./sidebar.js";
import { remoteOutbox } from "./remote.js";

const run = promisify(execFile);
export const messageId = () => `msg_${(BigInt(Date.now()) * 0x1000n & 0xffffffffffffn).toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`;
export const requestPrompt = (r: Request) => `[opencode-herdr request ${r.id} generation ${r.generation}] ` +
  `Call read_task with requestId="${r.id}", generation=${r.generation}, deliveryId="${r.deliveryId}". ` +
  (r.kind === "instruction" ? "This is an instruction. Reading accepts it. Do not hand back a result." :
    "This is a task alongside your existing work. Call hand_back with the same requestId and generation when finished. " +
    "Do not commit, discard, merge or clean up resources unless separately authorised.");

export async function inventory(store: Store, env = process.env,
  runner: (file: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv }) => Promise<{ stdout: string; stderr: string }> = run): Promise<Agent[]> {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH) return [];
  const response = await runner("herdr", ["agent", "list"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env });
  const panes = JSON.parse(response.stdout).result?.agents;
  if (!Array.isArray(panes)) throw new Error("Invalid Herdr inventory");
  const agents: Agent[] = [];
  const conflicts = new Set<string>();
  for (const pane of panes) {
    if (pane.agent !== "opencode" || pane.agent_session?.agent !== "opencode" || pane.agent_session.kind !== "id") continue;
    if (![pane.pane_id, pane.terminal_id, pane.workspace_id, pane.cwd, pane.agent_session.value].every((s) => typeof s === "string" && s)) continue;
    try { agents.push(store.observeAgent({ sessionId: pane.agent_session.value, socket: env.HERDR_SOCKET_PATH,
      paneId: pane.pane_id, terminalId: pane.terminal_id, workspaceId: pane.workspace_id, directory: pane.cwd,
      label: pane.name || pane.terminal_title || pane.agent_session.value, state: pane.agent_status || "unknown", lastSeen: Date.now() })); }
    catch (error) {
      if (error instanceof Error && error.message === "Agent binding changed; refusing to rebind an existing conversation") conflicts.add(pane.agent_session.value);
      else throw error;
    }
  }
  return agents.filter(agent => !conflicts.has(agent.sessionId));
}

export class DeliveryWorker {
  private stopped = false;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private nextErrorAt = 0;
  constructor(private store: Store, private client: PluginInput["client"], private directory: string,
    private discover: () => Promise<Agent[]> = () => inventory(store),
    private publish: ReturnType<typeof createSidebarPublisher> = createSidebarPublisher()) {}

  start() {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref(); void this.tick();
  }
  async dispose() { this.stopped = true; clearInterval(this.timer); await this.active; }
  async receipt(sessionId: string, id: string, expected: string): Promise<boolean> {
    const response = await this.client.session.message({ path: { id: sessionId, messageID: id }, query: { directory: this.directory }, signal: AbortSignal.timeout(5000) });
    if (response.response.status === 404) return false;
    if (response.error || !response.data) throw new Error("Message readback unavailable");
    return response.data.info.id === id && response.data.info.sessionID === sessionId && response.data.info.role === "user" &&
      response.data.parts.some(p => p.type === "text" && p.text === expected);
  }
  private options() {
    return { query: { directory: this.directory }, signal: AbortSignal.timeout(5000), throwOnError: true as const };
  }
  private async conversation(agent: Agent) {
    const conversation = await this.client.session.get({ ...this.options(), path: { id: agent.sessionId } });
    if (conversation.data?.id !== agent.sessionId || conversation.data.directory !== agent.directory) throw new Error("Conversation binding mismatch");
    return conversation.data;
  }
  private async idle(agent: Agent) {
    const status = await this.client.session.status(this.options());
    // The status endpoint omits idle sessions. An absent response is not an idle session.
    return !!status.data && (!status.data[agent.sessionId] || status.data[agent.sessionId].type === "idle");
  }
  private async settings(agent: Agent) {
    const conversation = await this.conversation(agent);
    if (!await this.idle(agent)) return;
    const nonblank = (value: unknown): value is string => typeof value === "string" && !!value.trim();
    const object = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session settings");
      return value as Record<string, unknown>;
    };
    // The plugin's v1 SDK omits these fields; the runtime/v2 session schema includes them.
    const current = object(conversation);
    let persona: string | undefined;
    let model: { providerID: string; modelID: string } | undefined;
    let variant: string | undefined;
    if (current.agent !== undefined) {
      if (!nonblank(current.agent)) throw new Error("Invalid session agent");
      persona = current.agent;
    }
    if (current.model !== undefined) {
      const selected = object(current.model);
      if (!nonblank(selected.providerID) || !nonblank(selected.id) ||
          (selected.variant !== undefined && typeof selected.variant !== "string")) throw new Error("Invalid session model");
      model = { providerID: selected.providerID, modelID: selected.id };
      variant = selected.variant as string | undefined;
    }
    if (!persona || !model) {
      const messages = await this.client.session.messages({ ...this.options(), path: { id: agent.sessionId } });
      if (!messages.data) throw new Error("Message history unavailable");
      const user = [...messages.data].reverse().find(m => m.info.role === "user")?.info;
      if (user?.role === "user") {
        if (!persona && nonblank(user.agent)) persona = user.agent;
        if (!model) {
          const selected = object(user.model);
          const selectedVariant = selected.variant ?? object(user).variant;
          if (!nonblank(selected.providerID) || !nonblank(selected.modelID) ||
              (selectedVariant !== undefined && typeof selectedVariant !== "string")) throw new Error("Invalid message model");
          model = { providerID: selected.providerID, modelID: selected.modelID };
          variant = selectedVariant as string | undefined;
        }
      } else if (!model && persona) {
        const config = await this.client.config.get(this.options());
        const configured = config.data?.model;
        const slash = configured?.indexOf("/") ?? -1;
        if (configured && slash > 0 && slash < configured.length - 1) {
          model = { providerID: configured.slice(0, slash), modelID: configured.slice(slash + 1) };
        }
      }
    }
    // A pane label is not a persona. Empty legacy sessions need an explicit host agent.
    if (!persona || !model) throw new Error("Session agent/model unavailable");
    return { agent: persona, model, variant };
  }
  private async live(expected?: Agent): Promise<Agent | undefined> {
    if (this.stopped || process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID || !process.env.HERDR_SOCKET_PATH) return;
    const agents = await this.discover();
    const candidates = agents.filter(a => a.socket === process.env.HERDR_SOCKET_PATH && a.paneId === process.env.HERDR_PANE_ID);
    if (candidates.length !== 1) return;
    const agent = candidates[0];
    if (agent.directory !== this.directory || agent.machineId !== this.store.machineId ||
        agents.filter(a => a.socket === agent.socket && (a.sessionId === agent.sessionId || a.terminalId === agent.terminalId)).length !== 1) return;
    const pinned = expected ?? this.store.agent(agent.id);
    if (["id", "machineId", "sessionId", "socket", "paneId", "terminalId", "workspaceId", "directory"].some(key =>
      agent[key as keyof Agent] !== pinned[key as keyof Agent])) return;
    return agent;
  }
  private report() {
    if (Date.now() < this.nextErrorAt) return;
    this.nextErrorAt = Date.now() + 30_000;
    // Transport errors can contain prompts or credentials. Never log their payloads.
    console.error("opencode-herdr: reconciliation deferred; binding, settings or transport unavailable");
  }
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.scan().catch(() => this.report())
      .finally(() => { this.active = undefined; });
    return this.active;
  }
  private async scan() {
    const agent = await this.live();
    if (!agent || this.stopped) return;
    try { const local = this.store.list(agent.sessionId); await this.publish(agent.paneId, agent.sessionId, { ...local, outbox: [...local.outbox, ...remoteOutbox(this.store, agent.sessionId)] }); }
    catch { this.report(); }
    const request = this.store.pending(agent.id);
    if (request) {
      const target = this.store.history(request.id, agent.sessionId).deliveries.find(d => d.id === request.deliveryId)?.target;
      if (!target || (Object.keys(target) as (keyof typeof target)[]).some(key => target[key] !== agent[key])) return;
    }
    if (request?.messageId && request.state === "unknown") {
      await this.conversation(agent);
      if (await this.receipt(agent.sessionId, request.messageId, requestPrompt(request))) this.store.submitted(request.id, request.messageId);
      return;
    } else if (request?.state === "queued" && ["idle", "done"].includes(agent.state)) {
      const settings = await this.settings(agent);
      const current = settings && await this.live(agent);
      if (current && ["idle", "done"].includes(current.state) && await this.idle(agent) && !this.stopped) {
        const id = messageId();
        if (this.store.attempt(request.id, request.generation, id)) {
          const text = requestPrompt(request);
          await this.client.session.promptAsync({ path: { id: agent.sessionId }, query: { directory: this.directory },
            body: { ...settings, messageID: id, parts: [{ type: "text", text }] }, signal: AbortSignal.timeout(15000), throwOnError: true });
          if (await this.receipt(agent.sessionId, id, text)) this.store.submitted(request.id, id);
        }
      }
      // Even a lost claim belongs to a competing worker's turn, not the notice outbox.
      return;
    }
    for (const notice of this.store.notices(agent.sessionId)) {
      if (notice.directory !== agent.directory) continue;
      if (notice.state === "unknown" && notice.messageId) {
        await this.conversation(agent);
        if (await this.receipt(agent.sessionId, notice.messageId, notice.text)) this.store.noticeDelivered(notice.id, notice.messageId);
        return;
      } else if (notice.state === "pending" && ["idle", "done"].includes(agent.state) && !this.stopped) {
        const settings = await this.settings(agent);
        const current = settings && await this.live(agent);
        if (!current || !["idle", "done"].includes(current.state) || !await this.idle(agent) || this.stopped) return;
        const id = messageId();
        if (!this.store.noticeAttempt(notice.id, id)) return;
        await this.client.session.promptAsync({ path: { id: agent.sessionId }, query: { directory: this.directory },
          body: { ...settings, messageID: id, parts: [{ type: "text", text: notice.text }] }, signal: AbortSignal.timeout(15000), throwOnError: true });
        if (await this.receipt(agent.sessionId, id, notice.text)) this.store.noticeDelivered(notice.id, id);
        break;
      }
    }
  }
}
