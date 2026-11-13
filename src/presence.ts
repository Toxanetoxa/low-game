import type { IPublishPacket, MqttClient } from 'mqtt';
import { normalizeNickname } from './nickname';
import { createRoomId } from './peer';

export type RoomIdentity = Readonly<{ id: string; key: string }>;
export type OnlinePlayer = Readonly<{ identity: RoomIdentity; nickname: string; available: boolean }>;

type ClaimResult = 'claimed' | 'taken' | 'offline';
type Presence = { active: string | null; candidate: string | null; previous?: string | null };
type PresenceRecord = Presence & { expiresAt: number; player?: OnlinePlayer };
type PresenceCallbacks = {
  onLost: (nickname: string) => void;
  onPlayers: (players: OnlinePlayer[]) => void;
};

const prefix = 'low-game/52d8ac30/v1/presence/';
const ownerPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identityIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const publicKeyPattern = /^04[0-9a-f]{128}$/;
const leaseSeconds = 45;
const heartbeatMs = 10_000;
const snapshotMs = 350;
const electionMs = 650;
const confirmationMs = 300;
const brokerAckMs = 1_800;

function key(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

function readNickname(value: unknown): string | null {
  return typeof value === 'string' ? normalizeNickname(value) : null;
}

export function isRoomIdentity(value: unknown): value is RoomIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const identity = value as { id?: unknown; key?: unknown };
  return (
    typeof identity.id === 'string' &&
    identityIdPattern.test(identity.id) &&
    typeof identity.key === 'string' &&
    publicKeyPattern.test(identity.key)
  );
}

function samePlayer(a: OnlinePlayer | undefined, b: OnlinePlayer | undefined): boolean {
  return (
    a?.nickname === b?.nickname &&
    a?.available === b?.available &&
    a?.identity.id === b?.identity.id &&
    a?.identity.key === b?.identity.key
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class NicknamePresence {
  private readonly owner = createRoomId();
  readonly topic = prefix + this.owner;

  private client: MqttClient | null = null;
  private identity: RoomIdentity | null = null;
  private available = true;
  private ready = false;
  private closed = false;
  private active: string | null = null;
  private activeUntil = 0;
  private pending: object | null = null;
  private heartbeat: number | undefined;
  private expiry: number | undefined;
  private connection = {};
  private readonly records = new Map<string, PresenceRecord>();
  private players: OnlinePlayer[] = [];

  constructor(private readonly callbacks: PresenceCallbacks) {}

  get isActive(): boolean {
    return this.ready && this.client?.connected === true && this.active !== null && Date.now() < this.activeUntil;
  }

  setAvailable(available: boolean): void {
    if (available === this.available) return;
    this.available = available;
    const client = this.client;
    if (client && this.isActive && !this.pending) {
      void this.refreshActive(client, this.connection).catch(() => {});
    }
  }

  async attach(client: MqttClient, identity: RoomIdentity): Promise<void> {
    this.detach();
    if (this.closed) return;
    this.client = client;
    this.identity = identity;
    const connection = this.connection;
    client.on('message', this.receive);
    const grants = await client.subscribeAsync(`${prefix}+`, { qos: 1 });
    if (grants.length !== 1 || grants[0].qos > 2) throw new Error('Не удалось получить список онлайн-игроков.');

    // MQTT acknowledges the subscription before its retained records arrive.
    await delay(snapshotMs);
    if (!this.connected(client, connection)) return;

    if (this.active && this.hasActiveOwner(this.active)) {
      this.loseActive();
    } else if (this.active) {
      await this.refreshActive(client, connection);
    }

    if (!this.connected(client, connection)) return;
    this.ready = true;
    this.reconcile();
    this.emitPlayers();
    this.expiry = window.setInterval(() => this.expireRecords(), 1_000);
    this.heartbeat = window.setInterval(() => {
      if (!this.active || this.pending || !this.connected(client, connection)) return;
      if (Date.now() >= this.activeUntil && this.hasActiveOwner(this.active)) {
        this.loseActive();
        return;
      }
      void this.refreshActive(client, connection).catch(() => {});
    }, heartbeatMs);
  }

  detach(): void {
    this.ready = false;
    this.connection = {};
    this.pending = null;
    window.clearInterval(this.heartbeat);
    window.clearInterval(this.expiry);
    this.client?.removeListener('message', this.receive);
    this.client = null;
    this.identity = null;
    this.records.clear();
    this.emitPlayers();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    if (client?.connected) {
      // Write immediately so a caller can then close the MQTT connection.
      client.publish(this.topic, '', { qos: 0, retain: true });
    }
    this.detach();
    this.active = null;
    this.activeUntil = 0;
  }

  async claim(name: string): Promise<ClaimResult> {
    const nickname = normalizeNickname(name);
    const client = this.client;
    if (!nickname || !client || !this.ready || !client.connected || this.pending) return 'offline';
    if (this.active === nickname && this.isActive) return 'claimed';
    if (this.hasActiveOwner(nickname)) return 'taken';

    const attempt = {};
    this.pending = attempt;
    try {
      await this.publish(client, { active: this.active, candidate: nickname });
      await delay(electionMs);
      if (!this.isPending(attempt)) return 'offline';
      if (this.hasActiveOwner(nickname) || this.hasEarlierCandidate(nickname)) return 'taken';

      await this.publish(client, { active: nickname, candidate: null, previous: this.active });
      await delay(confirmationMs);
      if (!this.isPending(attempt)) return 'offline';
      if (this.hasEarlierActiveOwner(nickname)) return 'taken';

      this.active = nickname;
      this.activeUntil = Date.now() + leaseSeconds * 1000;
      this.pending = null;
      // Publish the committed name only once the election and confirmation are complete.
      void this.refreshActive(client, this.connection).catch(() => {});
      return 'claimed';
    } catch {
      return 'offline';
    } finally {
      if (this.isPending(attempt)) {
        this.pending = null;
        // The old name remains reserved when a rename fails.
        if (this.active) void this.refreshActive(client, this.connection).catch(() => {});
        else void this.publish(client, { active: null, candidate: null }).catch(() => {});
      }
    }
  }

  private async refreshActive(client: MqttClient, connection: object): Promise<void> {
    const active = this.active;
    if (!active) return;
    const activeUntil = Date.now() + leaseSeconds * 1000;
    await this.publish(client, { active, candidate: null });
    if (this.active === active && this.connected(client, connection)) this.activeUntil = activeUntil;
  }

  private connected(client: MqttClient, connection: object): boolean {
    return !this.closed && this.client === client && this.connection === connection && client.connected;
  }

  private isPending(attempt: object): boolean {
    return this.pending === attempt && this.ready && this.client?.connected === true;
  }

  private hasActiveOwner(name: string): boolean {
    return this.matchingOwners(name, 'active').length > 0;
  }

  private hasEarlierActiveOwner(name: string): boolean {
    return this.matchingOwners(name, 'active').some((owner) => owner < this.owner);
  }

  private hasEarlierCandidate(name: string): boolean {
    return this.matchingOwners(name, 'candidate').some((owner) => owner < this.owner);
  }

  private matchingOwners(name: string, slot: keyof Presence): string[] {
    this.expireRecords();
    const target = key(name);
    const matches: string[] = [];
    for (const [owner, record] of this.records) {
      const other = record[slot];
      const previous = slot === 'active' ? record.previous : null;
      if ((other && key(other) === target) || (previous && key(previous) === target)) matches.push(owner);
    }
    return matches;
  }

  private expireRecords(): void {
    const now = Date.now();
    let playersChanged = false;
    for (const [owner, record] of this.records) {
      if (record.expiresAt > now) continue;
      this.records.delete(owner);
      playersChanged ||= record.player !== undefined;
    }
    if (playersChanged) this.emitPlayers();
  }

  private emitPlayers(): void {
    const byName = new Map<string, { owner: string; player: OnlinePlayer }>();
    if (this.ready) {
      for (const [owner, record] of this.records) {
        if (!record.player) continue;
        const name = key(record.player.nickname);
        const previous = byName.get(name);
        if (!previous || owner < previous.owner) {
          byName.set(name, { owner, player: record.player });
        }
      }
    }

    const players = Array.from(byName.values(), ({ player }) => player).sort(
      (a, b) => a.nickname.localeCompare(b.nickname) || a.identity.id.localeCompare(b.identity.id),
    );
    if (
      players.length === this.players.length &&
      players.every((player, index) => samePlayer(player, this.players[index]))
    ) {
      return;
    }
    this.players = players;
    this.callbacks.onPlayers(players);
  }

  private reconcile(): void {
    if (!this.ready || !this.active || !this.hasEarlierActiveOwner(this.active)) return;
    this.loseActive();
  }

  private loseActive(): void {
    const nickname = this.active;
    if (!nickname) return;
    this.active = null;
    this.activeUntil = 0;
    this.pending = null;
    if (this.client?.connected) {
      void this.publish(this.client, { active: null, candidate: null }).catch(() => {});
    }
    this.callbacks.onLost(nickname);
  }

  private publish(client: MqttClient, presence: Presence): Promise<void> {
    if (!client.connected || client !== this.client || this.closed) {
      return Promise.reject(new Error('Соединение с лобби потеряно.'));
    }
    const committed = presence.previous ?? presence.active;
    const profile =
      committed && committed === this.active && this.identity
        ? { identity: this.identity, available: this.available }
        : undefined;
    const payload = presence.active || presence.candidate ? JSON.stringify({ ...presence, profile }) : '';
    return new Promise((resolve, reject) => {
      let messageId: number | undefined;
      const timer = window.setTimeout(() => {
        if (messageId) client.removeOutgoingMessage(messageId);
        reject(new Error('Сервис лобби не подтвердил никнейм.'));
      }, brokerAckMs);
      client.publish(
        this.topic,
        payload,
        {
          qos: 1,
          retain: true,
          properties: { messageExpiryInterval: leaseSeconds },
          cbStorePut: () => {
            messageId = client.getLastMessageId();
          },
        },
        (error) => {
          window.clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  private readonly receive = (
    topic: string,
    payload: { length: number; toString: () => string },
    packet: IPublishPacket,
  ): void => {
    if (!topic.startsWith(prefix) || topic === this.topic || payload.length > 512) return;
    const owner = topic.slice(prefix.length);
    if (!ownerPattern.test(owner)) return;
    const oldRecord = this.records.get(owner);
    if (payload.length === 0) {
      this.records.delete(owner);
      if (oldRecord?.player) this.emitPlayers();
      return;
    }
    const remaining = packet.properties?.messageExpiryInterval;
    if (typeof remaining !== 'number' || remaining <= 0) return;
    try {
      const value: unknown = JSON.parse(payload.toString());
      if (typeof value !== 'object' || value === null) return;
      const slots = value as {
        active?: unknown;
        candidate?: unknown;
        previous?: unknown;
        profile?: { identity?: unknown; available?: unknown };
      };
      const active = readNickname(slots.active);
      const candidate = readNickname(slots.candidate);
      const previous = readNickname(slots.previous);
      if (!active && !candidate) return;
      const nickname = previous ?? active;
      const identity = slots.profile?.identity;
      const available = slots.profile?.available;
      const player =
        nickname && isRoomIdentity(identity) && identity.id !== this.identity?.id && typeof available === 'boolean'
          ? { nickname, identity, available }
          : undefined;
      this.records.set(owner, {
        active,
        candidate,
        previous,
        player,
        expiresAt: Date.now() + Math.min(remaining, leaseSeconds) * 1000,
      });
      this.reconcile();
      if (!samePlayer(oldRecord?.player, player)) this.emitPlayers();
    } catch {
      // Ignore payloads written by other clients on the public broker.
    }
  };
}
