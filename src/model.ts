export type Agent = {
  id: string
  machineId: string
  sessionId: string
  socket: string
  paneId: string
  terminalId: string
  workspaceId: string
  directory: string
  label: string
  state: string
  lastSeen: number
  management: 'managed' | 'independent'
  managerSessionId?: string
}

export type RequestState = 'queued' | 'unknown' | 'submitted' | 'accepted' | 'paused' | 'completed' | 'failed' | 'cancelled'

export type Request = {
  id: string
  originSessionId: string
  originDirectory: string
  recipientId: string
  kind: 'task' | 'instruction'
  text: string
  executionPolicy: 'advisory' | 'code_change'
  revision: number
  generation: number
  sequence: number
  deliveryId: string
  state: RequestState
  createdAt: number
  updatedAt: number
  messageId?: string
  attemptedAt?: number
  mayContinue?: boolean
  summary?: string
  validation?: string
}

export type Item = Request & { recipientLabel?: string; sender?: string }

export type Notice = {
  id: string
  sessionId: string
  directory: string
  text: string
  state: 'pending' | 'unknown' | 'delivered' | 'superseded'
  messageId?: string
}

export type Outcome = {
  outcome: 'completed' | 'paused' | 'failed'
  summary: string
  checks: string[]
  risks: string[]
  evidence?: string[]
}

export type TaskResult = Required<Outcome> & {
  requestId: string
  generation: number
  sessionId: string
  createdAt: number
  validation: 'not_required' | 'pending'
}

export type Question = {
  id: string
  requestId: string
  generation: number
  sessionId: string
  text: string
  state: 'open' | 'answered' | 'withdrawn'
  createdAt: number
  reply?: { sessionId: string; text: string; at: number }
}

export type Delivery = {
  id: string
  requestId: string
  generation: number
  sequence: number
  state: 'queued' | 'unknown' | 'submitted' | 'accepted' | 'cancelled'
  messageId?: string
  attemptedAt?: number
  acceptedAt?: number
  submittedAt?: number
  target: Pick<Agent, 'sessionId' | 'socket' | 'paneId' | 'terminalId' | 'workspaceId' | 'directory'>
}

export type History = {
  request: Request
  generations: { generation: number; text: string; createdAt: number }[]
  deliveries: Delivery[]
  results: TaskResult[]
  questions: Question[]
  audit: AuditEvent[]
}

export type AuditEvent = {
  id: number
  entityId: string
  transition: string
  sessionId: string
  createdAt: number
}

export type Operation = {
  id: string
  kind: string
  originSessionId: string
  state: string
  payload: Record<string, unknown>
  result?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}
