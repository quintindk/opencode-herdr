import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";

export interface Request {
  id: string;
  originSessionId: string;
  originDirectory: string;
  recipientId: string;
  kind: "task" | "instruction";
  text: string;
  generation: number;
  sequence: number;
  deliveryId: string;
  state: "queued" | "unknown" | "submitted" | "accepted" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  messageId?: string;
  attemptedAt?: number;
  mayContinue?: boolean;
  summary?: string;
  validation?: unknown;
}

export interface QueueProjection {
  inbox: Request[];
  outbox: Request[];
}

export function requestPresentation(request: Pick<Request, "state" | "kind" | "validation">): {
  label: string;
  colour: keyof Pick<TuiThemeCurrent, "primary" | "accent" | "warning" | "error" | "success" | "textMuted">;
  prefix: "blocked" | "active" | "queued" | "done" | "idle";
} {
  const validation = typeof request.validation === "object" && request.validation !== null && "status" in request.validation
    ? request.validation.status : request.validation;
  switch (request.state) {
    case "queued": return { label: "Queued", colour: "primary", prefix: "queued" };
    case "submitted": return { label: "Submitted", colour: "primary", prefix: "active" };
    case "unknown": return { label: "Delivery unknown", colour: "warning", prefix: "blocked" };
    case "paused": return { label: "Paused", colour: "warning", prefix: "blocked" };
    case "failed": return { label: "Failed", colour: "error", prefix: "blocked" };
    case "cancelled": return { label: "Cancelled", colour: "textMuted", prefix: "idle" };
    case "accepted": return request.kind === "instruction"
      ? { label: "Acknowledged", colour: "accent", prefix: "done" }
      : { label: "Awaiting result", colour: "accent", prefix: "active" };
    case "completed":
      if (validation === "pending") return { label: "Needs review", colour: "warning", prefix: "blocked" };
      if (validation === "rejected") return { label: "Validation rejected", colour: "error", prefix: "blocked" };
      return { label: "Completed", colour: "success", prefix: "done" };
  }
}

export function queueTokens({ inbox, outbox }: QueueProjection): Record<"herdr_inbox" | "herdr_outbox" | "herdr_wait", string> {
  const token = (requests: Request[]) => {
    const states = new Set(requests.map((request) => requestPresentation(request).prefix));
    const priority = ["blocked", "active", "queued", "done", "idle"] as const;
    const prefix = priority.find((state) => states.has(state)) ?? "idle";
    return `${prefix} ${requests.length}`;
  };
  // Only accepted tasks await a result. Instructions never create a handback obligation.
  const waiting = outbox.filter((request) => request.kind === "task" && request.state === "accepted");
  return { herdr_inbox: token(inbox), herdr_outbox: token(outbox), herdr_wait: token(waiting) };
}

type Runner = (file: string, args: string[], options: { timeout: number }) => Promise<unknown>;

/** Call from the host's poll loop. Unchanged tokens refresh after 10 seconds. */
export function createSidebarPublisher(run: Runner = promisify(execFile)) {
  const published = new Map<string, { sessionId: string; tokens: string; at: number }>();
  const inFlight = new Set<string>();
  return async (paneId: string, sessionId: string, projection: QueueProjection): Promise<boolean> => {
    if (!paneId || !sessionId || inFlight.has(paneId)) return false;
    const tokens = queueTokens(projection);
    const serialised = JSON.stringify(tokens);
    const previous = published.get(paneId);
    if (previous?.sessionId === sessionId && previous.tokens === serialised && Date.now() - previous.at < 10_000) return true;
    inFlight.add(paneId);
    try {
      await run("herdr", [
        "pane", "report-metadata", paneId,
        "--source", "opencode-herdr", "--agent", "opencode",
        "--applies-to-source", "herdr:opencode", "--ttl-ms", "30000",
        ...Object.entries(tokens).flatMap(([name, value]) => ["--token", `${name}=${value}`]),
      ], { timeout: 2_000 });
      published.set(paneId, { sessionId, tokens: serialised, at: Date.now() });
      return true;
    } catch {
      // Display availability must never change request or agent lifecycle state.
      return false;
    } finally {
      inFlight.delete(paneId);
    }
  };
}
