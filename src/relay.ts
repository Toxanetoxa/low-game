import type { RelayPacket, RelayPort } from './directory';
import type { PeerRole, PeerState } from './peer';

type Callbacks = { onData?: (data: unknown) => void; onState?: (state: PeerState) => void };
type Connect = (onPacket: (packet: RelayPacket) => void) => Promise<RelayPort>;
type Lane = 'heartbeat' | 'ack' | 'frame' | 'control';
type Queued = { packet: RelayPacket; sentAt: number };

const tickMs = 50;
const heartbeatMs = 3_000;
const disconnectMs = 12_000;
const retryMs = 1_250;
const maxQueue = 64;
const maxPayloadBytes = 3_800;
const encoder = new TextEncoder();
const heartbeatKind = 'relay-heartbeat';
const ackKind = 'relay-ack';

function classify(data: unknown): { lane: Lane; terminalRound: number } {
  if (data === null || typeof data !== 'object' || !('kind' in data)) return { lane: 'control', terminalRound: 0 };
  if (data.kind === heartbeatKind) return { lane: 'heartbeat', terminalRound: 0 };
  if (data.kind === ackKind) return { lane: 'ack', terminalRound: 0 };
  if (data.kind !== 'frame') return { lane: 'control', terminalRound: 0 };
  if ('round' in data && typeof data.round === 'number' && Number.isSafeInteger(data.round) && data.round > 0) {
    const game = 'game' in data ? data.game : null;
    if (game !== null && typeof game === 'object' && 'winner' in game) {
      if (game.winner === 0 || game.winner === 1 || game.winner === 'draw') {
        return { lane: 'control', terminalRound: data.round };
      }
    }
  }
  return { lane: 'frame', terminalRound: 0 };
}

export class RelaySession {
  private port: RelayPort | null = null;
  private preparing: Promise<void> | null = null;
  private state: PeerState = 'connecting';
  private started = false;
  private closed = false;
  private next = { heartbeat: 1, ack: 1, frame: 1, control: 1 };
  private seen = { heartbeat: 0, ack: 0, frame: 0, control: 0 };
  private readonly outgoing: Queued[] = [];
  private readonly incoming = new Map<number, unknown>();
  private incomingFrame: unknown = null;
  private sentTerminalRound = 0;
  private receivedTerminalRound = 0;
  private lastFrameAt = -Infinity;
  private lastPeerAt = 0;
  private heartbeatTimer: number | undefined;
  private retryTimer: number | undefined;
  private sending = false;
  private sendingFrame = false;
  private sendingHeartbeat = false;
  private sendingAck = false;

  constructor(
    readonly role: PeerRole,
    readonly roomId: string,
    private readonly callbacks: Callbacks,
    private readonly connect: Connect,
  ) {}

  prepare(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Подключение отменено.'));
    return (this.preparing ??= this.connect((packet) => this.receive(packet)).then((port) => {
      if (this.closed) {
        port.close();
        throw new Error('Подключение отменено.');
      }
      this.port = port;
    }));
  }

  start(): void {
    if (this.started || this.closed || !this.port) return;
    this.started = true;
    this.lastPeerAt = performance.now();
    this.setState('connected');
    this.deliverControls();
    if (this.incomingFrame !== null) {
      this.deliver(this.incomingFrame);
      this.incomingFrame = null;
    }
    if (this.closed) return;
    this.pulse();
    this.heartbeatTimer = window.setInterval(() => this.pulse(), heartbeatMs);
  }

  send(data: unknown, _bufferLimit?: number): boolean {
    if (!this.started || this.closed || this.state !== 'connected' || !this.port) return false;
    const { lane, terminalRound } = classify(data);
    if (lane === 'heartbeat' || lane === 'ack') return false;
    if (terminalRound > 0 && terminalRound <= this.sentTerminalRound) return true;
    if (lane === 'frame' && (this.sendingFrame || performance.now() - this.lastFrameAt < tickMs)) return false;
    if (lane === 'control' && this.outgoing.length >= maxQueue) return false;

    let payload: unknown;
    try {
      const text = JSON.stringify(data);
      if (!text || encoder.encode(text).length > maxPayloadBytes) return false;
      // Model snapshots can change again before the broker encrypts them.
      payload = JSON.parse(text);
    } catch {
      return false;
    }
    const packet = { sequence: this.next[lane]++, payload };
    if (lane === 'control') {
      this.sentTerminalRound = Math.max(this.sentTerminalRound, terminalRound);
      this.outgoing.push({ packet, sentAt: -Infinity });
      void this.flush();
    } else {
      this.lastFrameAt = performance.now();
      this.sendingFrame = true;
      void this.port
        .send(packet, false)
        .catch(() => {})
        .finally(() => (this.sendingFrame = false));
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearInterval(this.heartbeatTimer);
    window.clearTimeout(this.retryTimer);
    this.outgoing.length = 0;
    this.incoming.clear();
    this.incomingFrame = null;
    this.port?.close();
    this.port = null;
    this.setState('closed');
  }

  private async flush(): Promise<void> {
    const port = this.port;
    if (!port || this.sending || this.closed) return;
    window.clearTimeout(this.retryTimer);
    this.sending = true;
    try {
      let entry = this.outgoing.find(({ sentAt }) => sentAt === -Infinity);
      // Retry the head if the other player was offline while MQTT accepted the publication.
      const head = this.outgoing[0];
      if (head && performance.now() - head.sentAt >= retryMs) entry = head;
      while (!this.closed && entry) {
        entry.sentAt = performance.now();
        await port.send(entry.packet, true);
        entry = this.outgoing.find(({ sentAt }) => sentAt === -Infinity);
      }
    } catch {
      // The peer keeps its last confirmed sequence across the broker's reconnect.
    } finally {
      this.sending = false;
      if (!this.closed && this.outgoing.length) {
        const nextRetry = this.outgoing[0].sentAt + retryMs;
        this.retryTimer = window.setTimeout(() => void this.flush(), Math.max(100, nextRetry - performance.now()));
      }
    }
  }

  private pulse(): void {
    if (!this.port || this.closed) return;
    if (performance.now() - this.lastPeerAt >= disconnectMs) this.setState('disconnected');
    if (!this.port || this.closed || this.sendingHeartbeat) return;
    this.sendingHeartbeat = true;
    const packet = {
      sequence: this.next.heartbeat++,
      payload: { kind: heartbeatKind, received: this.seen.control },
    };
    void this.port
      .send(packet, true)
      .catch(() => {})
      .finally(() => (this.sendingHeartbeat = false));
  }

  private receive({ sequence, payload }: RelayPacket): void {
    if (this.closed || !Number.isSafeInteger(sequence) || sequence <= 0) return;
    const { lane } = classify(payload);
    if (sequence <= this.seen[lane]) {
      if (lane === 'control') this.acknowledge();
      return;
    }
    if (lane === 'control') {
      if (sequence > this.seen.control + maxQueue || this.incoming.has(sequence)) return;
      this.incoming.set(sequence, payload);
      if (this.started) this.deliverControls();
    } else {
      this.seen[lane] = sequence;
      if (lane === 'frame') {
        if (this.started) this.deliver(payload);
        else this.incomingFrame = payload;
      } else if (payload !== null && typeof payload === 'object' && 'received' in payload) {
        this.acknowledged(payload.received);
      }
    }
    this.lastPeerAt = performance.now();
    if (lane === 'heartbeat' && this.started && !this.closed) this.setState('connected');
  }

  private deliverControls(): void {
    const previous = this.seen.control;
    while (!this.closed && this.incoming.has(this.seen.control + 1)) {
      const sequence = ++this.seen.control;
      const payload = this.incoming.get(sequence);
      this.incoming.delete(sequence);
      this.deliver(payload);
    }
    if (this.seen.control > previous) this.acknowledge();
  }

  private acknowledge(): void {
    if (!this.port || !this.started || this.closed || this.sendingAck) return;
    this.sendingAck = true;
    const received = this.seen.control;
    const packet = { sequence: this.next.ack++, payload: { kind: ackKind, received } };
    void this.port
      .send(packet, false)
      .catch(() => {})
      .finally(() => {
        this.sendingAck = false;
        if (this.seen.control > received) this.acknowledge();
      });
  }

  private acknowledged(received: unknown): void {
    if (typeof received !== 'number' || !Number.isSafeInteger(received) || received >= this.next.control) return;
    while (this.outgoing.length && this.outgoing[0].packet.sequence <= received) this.outgoing.shift();
  }

  private deliver(payload: unknown): void {
    if (this.closed) return;
    if (payload !== null && typeof payload === 'object' && 'kind' in payload && payload.kind === 'frame') {
      if ('round' in payload && typeof payload.round === 'number' && payload.round <= this.receivedTerminalRound)
        return;
      this.receivedTerminalRound = Math.max(this.receivedTerminalRound, classify(payload).terminalRound);
    }
    this.callbacks.onData?.(payload);
  }

  private setState(state: PeerState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState?.(state);
  }
}
