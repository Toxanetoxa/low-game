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
  'reject',
  'cancel',
  'challenge',
  'challenge-accept',
  'challenge-decline',
  'challenge-cancel',
  'relay-please',
  'relay-offer',
  'relay-accept',
] as const;

export type DirectorySignal = SignalContext &
  (
    | { kind: (typeof signalKinds)[number] }
    | { kind: 'private-request'; relay?: true; inviteToken?: string }
    | { kind: 'relay-leave'; reason?: 'rematch-timeout' | 'rematch-declined' }
    | { kind: 'invite' | 'answer'; code: string }
  );

export type RelayPacket = { sequence: number; payload: unknown };
export type RelayPort = {
  send: (packet: RelayPacket, reliable: boolean) => Promise<void>;
  close: () => void;
};

type RelayData = SignalContext & RelayPacket & { kind: 'relay-data' };
type RelayBinding = {
  target: RoomIdentity;
  context: SignalContext;
  key: CryptoKey;
  abort: AbortController;
  onPacket: (packet: RelayPacket) => void;
};

interface DirectoryCallbacks {
  onState: (state: DirectoryState) => void;
  onRooms: (rooms: PublicRoom[]) => void;
  onPlayers: (players: OnlinePlayer[]) => void;
  onSignal: (sender: RoomIdentity, signal: DirectorySignal) => void;
  onNicknameLost: (nickname: string) => void;
}

type Listing = { room: PublicRoom; expiresAt: number };
type Envelope = { sender: RoomIdentity; iv: string; data: string; relay?: true };

const brokerUrl = 'wss://broker.emqx.io:8084/mqtt';
const namespace = 'low-game/52d8ac30/v1';
const roomsPrefix = `${namespace}/rooms/`;
const inboxPrefix = `${namespace}/inbox/`;
const roomLifetimeSeconds = 35;
const heartbeatMs = 10_000;
const signalLifetimeSeconds = 30;
const relayLifetimeSeconds = 5;
const frameLifetimeSeconds = 2;
const publishTimeoutMs = 2_500;
const maxRelayBytes = 4_096;
const maxRelayEncodedBytes = Math.ceil((maxRelayBytes + 16) / 3) * 4;
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

function isContext(value: unknown): value is SignalContext & Record<string, unknown> {
  return isRecord(value) && isUuid(value.roomId) && isUuid(value.requestId);
}

function sameContext(a: SignalContext, b: SignalContext): boolean {
  return a.roomId === b.roomId && a.requestId === b.requestId;
}

function isRelayPacket(value: unknown): value is RelayPacket {
  return (
    isRecord(value) &&
    typeof value.sequence === 'number' &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    Object.hasOwn(value, 'payload') &&
    value.payload !== undefined
  );
}

function isRelayData(value: unknown): value is RelayData {
  return isRecord(value) && value.kind === 'relay-data' && isContext(value) && isRelayPacket(value);
}

function isSignal(value: unknown): value is DirectorySignal {
  if (!isRecord(value) || !isContext(value)) return false;
  if (value.kind === 'private-request') {
    return (
      (value.relay === undefined || value.relay === true) &&
      (value.inviteToken === undefined ||
        (typeof value.inviteToken === 'string' && /^[0-9a-f]{32}$/.test(value.inviteToken)))
    );
  }
  if (value.kind === 'relay-leave') {
    return value.reason === undefined || value.reason === 'rematch-timeout' || value.reason === 'rematch-declined';
  }
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
    /^[A-Z0-9+/]+={0,2}$/i.test(value.data) &&
    (value.relay === undefined || value.relay === true)
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

function cipherParams(
  sender: RoomIdentity,
  recipient: RoomIdentity,
  iv: Uint8Array<ArrayBuffer>,
  relay?: SignalContext,
): AesGcmParams {
  const scope = [namespace, sender.id, sender.key, recipient.id, recipient.key];
  if (relay) scope.push('relay-data', relay.roomId, relay.requestId);
  return { name: 'AES-GCM', iv, additionalData: encoder.encode(scope.join('/')) };
}

async function sharedKey(privateKey: CryptoKey, target: RoomIdentity, relay?: SignalContext): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey('raw', fromHex(target.key), curve, false, []);
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const info = relay ? [namespace, 'relay-data', relay.roomId, relay.requestId].join('/') : namespace;
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(info) },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptEnvelope(
  message: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  sender: RoomIdentity,
  recipient: RoomIdentity,
  relay?: SignalContext,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(cipherParams(sender, recipient, iv, relay), key, message);
  const envelope: Envelope = {
    sender,
    iv: toHex(iv),
    data: encodeBytes(new Uint8Array(ciphertext)),
    relay: relay ? true : undefined,
  };
  return JSON.stringify(envelope);
}

async function decryptEnvelope(
  envelope: Envelope,
  recipient: RoomIdentity,
  key: CryptoKey,
  relay?: SignalContext,
): Promise<unknown> {
  const plaintext = await crypto.subtle.decrypt(
    cipherParams(envelope.sender, recipient, fromHex(envelope.iv), relay),
    key,
    decodeBytes(envelope.data),
  );
  return parse(decoder.decode(plaintext));
}

export class RoomDirectory {
  private client: MqttClient | null = null;
  private ownIdentity: RoomIdentity | null = null;
  private privateKey: CryptoKey | null = null;
  private currentState: DirectoryState = 'connecting';
  private connectionEpoch = 0;
  private closed = false;
  private openRoom: PublicRoom | null = null;
  private relay: RelayBinding | null = null;
  private inboxReliable = false;
  private readonly pendingReliable = new Set<() => void>();
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
    const envelope = await encryptEnvelope(encoder.encode(JSON.stringify(signal)), key, sender, target);
    if (this.onlineClient() !== client || this.connectionEpoch !== epoch) {
      throw new Error('Связь с общим лобби потеряна.');
    }

    const topic = inboxPrefix + target.id;
    if (signal.kind.startsWith('relay-') || (signal.kind === 'private-request' && signal.relay)) {
      await this.publishReliable(client, topic, envelope, relayLifetimeSeconds);
    } else {
      await client.publishAsync(topic, envelope, {
        qos: 0,
        properties: { messageExpiryInterval: signalLifetimeSeconds },
      });
    }
  }

  async openRelay(
    target: RoomIdentity,
    context: SignalContext,
    onPacket: (packet: RelayPacket) => void,
  ): Promise<RelayPort> {
    const client = this.onlineClient();
    const own = this.ownIdentity;
    const privateKey = this.privateKey;
    if (!client || !own || !privateKey || !this.inboxReliable) throw new Error('Общее лобби недоступно.');
    if (!isRoomIdentity(target) || target.id === own.id || !isContext(context)) {
      throw new Error('Неверные данные комнаты.');
    }
    const epoch = this.connectionEpoch;
    const boundTarget = { id: target.id, key: target.key };
    const boundContext = { roomId: context.roomId, requestId: context.requestId };
    const key = await sharedKey(privateKey, boundTarget, boundContext);
    if (this.onlineClient() !== client || this.connectionEpoch !== epoch || this.relay) {
      throw new Error('Подключение к комнате изменилось.');
    }

    const relay: RelayBinding = {
      target: boundTarget,
      context: boundContext,
      key,
      abort: new AbortController(),
      onPacket,
    };
    this.relay = relay;
    return {
      send: (packet, reliable) => this.sendRelay(relay, own, packet, reliable),
      close: () => {
        if (this.relay !== relay) return;
        this.relay = null;
        relay.abort.abort();
      },
    };
  }

  private async sendRelay(
    relay: RelayBinding,
    own: RoomIdentity,
    packet: RelayPacket,
    reliable: boolean,
  ): Promise<void> {
    const client = this.onlineClient();
    const epoch = this.connectionEpoch;
    if (!client || !this.inboxReliable || this.relay !== relay) throw new Error('Связь с комнатой потеряна.');
    if (!isRelayPacket(packet)) throw new Error('Неверные данные дуэли.');
    const payload: RelayData = {
      ...relay.context,
      kind: 'relay-data',
      sequence: packet.sequence,
      payload: packet.payload,
    };
    const message = encoder.encode(JSON.stringify(payload));
    if (message.length > maxRelayBytes) throw new Error('Сообщение дуэли слишком большое.');
    const envelope = await encryptEnvelope(message, relay.key, own, relay.target, relay.context);
    if (this.onlineClient() !== client || this.connectionEpoch !== epoch || this.relay !== relay) {
      throw new Error('Связь с комнатой потеряна.');
    }

    const topic = inboxPrefix + relay.target.id;
    if (reliable) {
      await this.publishReliable(client, topic, envelope, relayLifetimeSeconds, relay.abort.signal);
    } else {
      await client.publishAsync(topic, envelope, {
        qos: 0,
        properties: { messageExpiryInterval: frameLifetimeSeconds },
      });
    }
  }

  private publishReliable(
    client: MqttClient,
    topic: string,
    envelope: string,
    lifetime: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let messageId: number | undefined;
      let settled = false;
      const cancel = () => finish(new Error('Не удалось доставить сообщение комнаты.'), true);
      const finish = (error?: Error | null, remove = false) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.pendingReliable.delete(cancel);
        signal?.removeEventListener('abort', cancel);
        // mqtt.js retries unacknowledged QoS 1 packets on reconnect unless explicitly removed.
        if (remove && messageId !== undefined) client.removeOutgoingMessage(messageId);
        if (error) reject(error);
        else resolve();
      };
      const timer = window.setTimeout(cancel, publishTimeoutMs);
      this.pendingReliable.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      client.publish(
        topic,
        envelope,
        {
          qos: 1,
          properties: { messageExpiryInterval: lifetime },
          cbStorePut() {
            messageId = client.getLastMessageId();
          },
        },
        (error) => finish(error),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    if (this.openRoom) this.withdraw(this.openRoom.id);
    this.presence.close();
    for (const waiter of this.onlineWaiters) waiter(false);
    this.closed = true;
    this.connectionEpoch += 1;
    this.relay?.abort.abort();
    this.relay = null;
    for (const cancel of this.pendingReliable) cancel();
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
      this.inboxReliable = false;
      for (const cancel of this.pendingReliable) cancel();
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
      const grants = await client.subscribeAsync({
        [`${roomsPrefix}+`]: { qos: 0 },
        [inbox]: { qos: 1, rap: true, rh: 2 },
      });
      if (this.closed || !client.connected || epoch !== this.connectionEpoch) return;
      if (grants.length !== 2 || grants.some((grant) => grant.qos > 2)) {
        this.setState('offline');
        return;
      }
      this.inboxReliable = grants.some((grant) => grant.topic === inbox && grant.qos === 1);
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

    if (envelope.relay) {
      await this.receiveRelay(envelope, own, epoch);
      return;
    }

    let signal: unknown;
    try {
      const key = await sharedKey(privateKey, envelope.sender);
      signal = await decryptEnvelope(envelope, own, key);
    } catch {
      return;
    }

    if (this.onlineClient() && epoch === this.connectionEpoch && isSignal(signal)) {
      this.callbacks.onSignal(envelope.sender, signal);
    }
  }

  private async receiveRelay(envelope: Envelope, own: RoomIdentity, epoch: number): Promise<void> {
    const relay = this.relay;
    if (
      !relay ||
      envelope.sender.id !== relay.target.id ||
      envelope.sender.key !== relay.target.key ||
      envelope.data.length > maxRelayEncodedBytes
    )
      return;

    let message: unknown;
    try {
      message = await decryptEnvelope(envelope, own, relay.key, relay.context);
    } catch {
      return;
    }

    if (
      this.onlineClient() &&
      epoch === this.connectionEpoch &&
      this.relay === relay &&
      isRelayData(message) &&
      sameContext(message, relay.context)
    ) {
      relay.onPacket({ sequence: message.sequence, payload: message.payload });
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
