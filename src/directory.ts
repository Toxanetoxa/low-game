import type { MqttClient } from 'mqtt';
import type { OnlinePlayer, RoomIdentity } from './presence';
import mqtt from 'mqtt';
import { normalizeNickname } from './nickname';
import { createRoomId } from './peer';
import { isRoomIdentity, NicknamePresence } from './presence';

export type { OnlinePlayer, RoomIdentity } from './presence';
export type PublicRoom = Readonly<{ id: string; host: RoomIdentity; nickname?: string }>;
export type DirectoryState = 'connecting' | 'online' | 'offline' | 'unsupported';

type SignalContext = { roomId: string; requestId: string };
const signalKinds = [
  'request',
  'private-request',
  'reject',
  'cancel',
  'challenge',
  'challenge-accept',
  'challenge-decline',
  'challenge-cancel',
] as const;

export type DirectorySignal = SignalContext &
  ({ kind: (typeof signalKinds)[number] } | { kind: 'invite' | 'answer'; code: string });

interface DirectoryCallbacks {
  onState: (state: DirectoryState) => void;
  onRooms: (rooms: PublicRoom[]) => void;
  onPlayers: (players: OnlinePlayer[]) => void;
  onSignal: (sender: RoomIdentity, signal: DirectorySignal) => void;
  onNicknameLost: (nickname: string) => void;
}

type Listing = { room: PublicRoom; expiresAt: number };
type Envelope = { sender: RoomIdentity; iv: string; data: string };

const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
const namespace = 'low-game/52d8ac30/v1';
const roomsPrefix = `${namespace}/rooms/`;
const inboxPrefix = `${namespace}/inbox/`;
const roomLifetimeSeconds = 35;
const heartbeatMs = 10_000;
const signalLifetimeSeconds = 30;
const maxCodeLength = 32_768;
const maxEnvelopeLength = 45_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const curve = { name: 'ECDH', namedCurve: 'P-256' };
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

function isSignal(value: unknown): value is DirectorySignal {
  if (!isRecord(value) || !isUuid(value.roomId) || !isUuid(value.requestId)) return false;
  if (signalKinds.includes(value.kind as (typeof signalKinds)[number])) return true;
  return (
    (value.kind === 'invite' || value.kind === 'answer') &&
    typeof value.code === 'string' &&
    value.code.length <= maxCodeLength
  );
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    isRecord(value) &&
    isRoomIdentity(value.sender) &&
    typeof value.iv === 'string' &&
    /^[0-9a-f]{24}$/.test(value.iv) &&
    typeof value.data === 'string' &&
    /^[A-Z0-9+/]+={0,2}$/i.test(value.data)
  );
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function encodeBytes(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function decodeBytes(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0));
}

function cipherParams(sender: RoomIdentity, recipient: RoomIdentity, iv: Uint8Array<ArrayBuffer>): AesGcmParams {
  return {
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode([namespace, sender.id, sender.key, recipient.id, recipient.key].join('/')),
  };
}

async function sharedKey(privateKey: CryptoKey, target: RoomIdentity): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey('raw', fromHex(target.key), curve, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(namespace) },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export class RoomDirectory {
  private client: MqttClient | null = null;
  private ownIdentity: RoomIdentity | null = null;
  private privateKey: CryptoKey | null = null;
  private currentState: DirectoryState = 'connecting';
  private connectionEpoch = 0;
  private closed = false;
  private openRoom: PublicRoom | null = null;
  private readonly rooms = new Map<string, Listing>();
  private readonly withdrawals = new Map<string, number>();
  private heartbeatTimer: number | undefined;
  private expiryTimer: number | undefined;
  private readonly presence: NicknamePresence;
  private readonly onlineWaiters = new Set<(available: boolean) => void>();

  constructor(private readonly callbacks: DirectoryCallbacks) {
    this.presence = new NicknamePresence({
      onLost: callbacks.onNicknameLost,
      onPlayers: callbacks.onPlayers,
    });
    void this.start();
  }

  get identity(): RoomIdentity | null {
    return this.ownIdentity;
  }

  get state(): DirectoryState {
    return this.currentState;
  }

  get hasNickname(): boolean {
    return this.presence.isActive && this.onlineClient() !== null;
  }

  setAvailable(available: boolean): void {
    this.presence.setAvailable(available);
  }

  async claimNickname(name: string): Promise<'claimed' | 'taken' | 'offline'> {
    if (!this.onlineClient() && !(await this.waitForOnline())) return 'offline';
    return this.presence.claim(name);
  }

  private waitForOnline(): Promise<boolean> {
    if (this.closed || this.currentState === 'unsupported') return Promise.resolve(false);
    return new Promise((resolve) => {
      const complete = (available: boolean) => {
        window.clearTimeout(timer);
        this.onlineWaiters.delete(complete);
        resolve(available);
      };
      const timer = window.setTimeout(() => complete(false), 9_000);
      this.onlineWaiters.add(complete);
    });
  }

  async announce(roomId: string, nickname: string): Promise<void> {
    if (!isUuid(roomId)) throw new Error('Неверный UUID комнаты.');
    if (!this.onlineClient() || !this.ownIdentity) throw new Error('Общее лобби недоступно. Попробуйте позже.');
    const normalized = normalizeNickname(nickname);
    if (!normalized) throw new Error('Введите никнейм длиной от 1 до 24 символов.');
    if (this.openRoom && this.openRoom.id !== roomId) throw new Error('Сначала закройте текущую комнату.');
    this.withdrawals.delete(roomId);
    const room: PublicRoom = { id: roomId, host: this.ownIdentity, nickname: normalized };
    this.openRoom = room;
    try {
      await this.publishRoom(room);
    } catch (error) {
      if (this.openRoom === room) this.withdraw(roomId);
      throw error;
    }
  }

  withdraw(roomId: string): void {
    if (this.openRoom?.id !== roomId) return;
    this.openRoom = null;
    this.withdrawals.set(roomId, Date.now() + roomLifetimeSeconds * 1000);
    void this.flushWithdrawals();
  }

  async send(target: RoomIdentity, signal: DirectorySignal): Promise<void> {
    const client = this.onlineClient();
    const sender = this.ownIdentity;
    const privateKey = this.privateKey;
    if (!client || !sender || !privateKey) throw new Error('Связь с общим лобби потеряна.');
    const epoch = this.connectionEpoch;
    if (!isRoomIdentity(target) || !isSignal(signal)) throw new Error('Неверные данные подключения.');

    const key = await sharedKey(privateKey, target);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      cipherParams(sender, target, iv),
      key,
      encoder.encode(JSON.stringify(signal)),
    );
    if (this.onlineClient() !== client || this.connectionEpoch !== epoch) {
      throw new Error('Связь с общим лобби потеряна.');
    }

    const envelope: Envelope = {
      sender,
      iv: toHex(iv),
      data: encodeBytes(new Uint8Array(ciphertext)),
    };
    await client.publishAsync(inboxPrefix + target.id, JSON.stringify(envelope), {
      qos: 0,
      properties: { messageExpiryInterval: signalLifetimeSeconds },
    });
  }

  close(): void {
    if (this.closed) return;
    if (this.openRoom) this.withdraw(this.openRoom.id);
    this.presence.close();
    for (const waiter of this.onlineWaiters) waiter(false);
    this.closed = true;
    this.connectionEpoch += 1;
    window.clearInterval(this.heartbeatTimer);
    window.clearInterval(this.expiryTimer);
    this.client?.end();
    this.client = null;
  }

  private async start(): Promise<void> {
    if (!globalThis.crypto?.subtle) {
      this.setState('unsupported');
      return;
    }

    try {
      const pair = await crypto.subtle.generateKey(curve, false, ['deriveBits']);
      const key = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      if (this.closed) return;
      const identity = { id: createRoomId(), key: toHex(key) };
      this.ownIdentity = identity;
      this.privateKey = pair.privateKey;
      this.startClient(identity);
    } catch {
      this.setState('unsupported');
    }
  }

  private startClient(identity: RoomIdentity): void {
    const client = mqtt.connect(brokerUrl, {
      protocolVersion: 5,
      clientId: `lg-${createRoomId().replaceAll('-', '').slice(0, 20)}`,
      clean: true,
      keepalive: 20,
      connectTimeout: 8_000,
      reconnectPeriod: 3_000,
      queueQoSZero: false,
      resubscribe: false,
      properties: { maximumPacketSize: 65_536 },
      will: { topic: this.presence.topic, payload: '', qos: 1, retain: true },
      manualConnect: true,
    });
    this.client = client;

    const inbox = inboxPrefix + identity.id;
    client.on('connect', () => {
      void this.subscribe(client, identity, inbox);
    });
    client.on('close', () => {
      this.connectionEpoch += 1;
      if (this.closed) return;
      this.presence.detach();
      this.setState('offline');
      if (this.rooms.size > 0) {
        this.rooms.clear();
        this.emitRooms();
      }
    });
    client.on('error', () => {
      if (!client.connected) this.setState('offline');
    });
    client.on('message', (topic, payload, packet) => {
      if (this.closed || payload.length > maxEnvelopeLength) return;
      if (topic === inbox) {
        if (!packet.retain && this.currentState === 'online') {
          void this.receiveSignal(payload.toString());
        }
      } else if (topic.startsWith(roomsPrefix)) {
        this.receiveRoom(topic.slice(roomsPrefix.length), payload.toString(), packet.properties?.messageExpiryInterval);
      }
    });

    this.heartbeatTimer = window.setInterval(() => {
      if (this.openRoom && this.onlineClient()) {
        void this.publishRoom(this.openRoom).catch(() => {});
      }
      void this.flushWithdrawals();
    }, heartbeatMs);
    this.expiryTimer = window.setInterval(() => this.removeExpiredRooms(), 1000);
    client.connect();
  }

  private async subscribe(client: MqttClient, identity: RoomIdentity, inbox: string): Promise<void> {
    const epoch = ++this.connectionEpoch;
    try {
      const grants = await client.subscribeAsync([`${roomsPrefix}+`, inbox]);
      if (this.closed || !client.connected || epoch !== this.connectionEpoch) return;
      if (grants.length !== 2 || grants.some((grant) => grant.qos > 2)) {
        this.setState('offline');
        return;
      }
      await this.presence.attach(client, identity);
      if (this.closed || !client.connected || epoch !== this.connectionEpoch) return;
      this.setState('online');
      await this.flushWithdrawals();
      if (this.openRoom && this.onlineClient()) await this.publishRoom(this.openRoom);
    } catch {
      if (epoch === this.connectionEpoch) this.setState('offline');
    }
  }

  private onlineClient(): MqttClient | null {
    return !this.closed && this.currentState === 'online' && this.client?.connected ? this.client : null;
  }

  private async publishRoom(room: PublicRoom): Promise<void> {
    const client = this.onlineClient();
    if (!client) throw new Error('Связь с общим лобби потеряна.');
    await client.publishAsync(roomsPrefix + room.id, JSON.stringify(room), {
      qos: 0,
      retain: true,
      properties: { messageExpiryInterval: roomLifetimeSeconds },
    });
  }

  private async flushWithdrawals(): Promise<void> {
    const client = this.onlineClient();
    for (const [roomId, expiresAt] of this.withdrawals) {
      if (expiresAt <= Date.now()) {
        this.withdrawals.delete(roomId);
      } else if (client) {
        try {
          await client.publishAsync(roomsPrefix + roomId, '', { qos: 0, retain: true });
          if (this.withdrawals.get(roomId) === expiresAt) this.withdrawals.delete(roomId);
        } catch {
          // Retain the removal until the client reconnects or the listing expires.
        }
      }
    }
  }

  private receiveRoom(id: string, text: string, remaining: number | undefined): void {
    if (!isUuid(id)) return;
    if (text === '') {
      if (this.rooms.delete(id)) this.emitRooms();
      return;
    }
    if (text.length > 512 || typeof remaining !== 'number' || remaining <= 0) return;
    const room = parse(text);
    if (!isRecord(room) || room.id !== id || !isRoomIdentity(room.host) || room.host.id === this.ownIdentity?.id) {
      return;
    }

    const previous = this.rooms.get(id)?.room;
    const nickname = typeof room.nickname === 'string' ? (normalizeNickname(room.nickname) ?? undefined) : undefined;
    this.rooms.set(id, {
      room: { id, host: room.host, nickname },
      expiresAt: Date.now() + Math.min(remaining, roomLifetimeSeconds) * 1000,
    });
    if (previous?.host.id !== room.host.id || previous.host.key !== room.host.key || previous.nickname !== nickname) {
      this.emitRooms();
    }
  }

  private removeExpiredRooms(): void {
    let changed = false;
    const now = Date.now();
    for (const [id, listing] of this.rooms) {
      if (listing.expiresAt > now) continue;
      this.rooms.delete(id);
      changed = true;
    }
    if (changed) this.emitRooms();
  }

  private async receiveSignal(text: string): Promise<void> {
    const own = this.ownIdentity;
    const privateKey = this.privateKey;
    const epoch = this.connectionEpoch;
    const envelope = parse(text);
    if (!own || !privateKey || !isEnvelope(envelope) || envelope.sender.id === own.id) return;

    let signal: unknown;
    try {
      const key = await sharedKey(privateKey, envelope.sender);
      const plaintext = await crypto.subtle.decrypt(
        cipherParams(envelope.sender, own, fromHex(envelope.iv)),
        key,
        decodeBytes(envelope.data),
      );
      signal = parse(decoder.decode(plaintext));
    } catch {
      return;
    }

    if (this.onlineClient() && epoch === this.connectionEpoch && isSignal(signal)) {
      this.callbacks.onSignal(envelope.sender, signal);
    }
  }

  private setState(state: DirectoryState): void {
    if (this.closed || state === this.currentState) return;
    this.currentState = state;
    if (state === 'online' || state === 'unsupported') {
      for (const waiter of this.onlineWaiters) waiter(state === 'online');
    }
    this.callbacks.onState(state);
  }

  private emitRooms(): void {
    this.callbacks.onRooms(
      Array.from(this.rooms.values(), (listing) => listing.room).sort((first, second) =>
        first.id.localeCompare(second.id),
      ),
    );
  }
}
