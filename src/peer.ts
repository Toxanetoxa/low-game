export type PeerRole = 'host' | 'guest';
export type PeerState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

interface PeerCallbacks {
  onData?: (data: unknown) => void;
  onState?: (state: PeerState) => void;
}

interface PeerOptions {
  useStun?: boolean;
}

type SignalType = 'offer' | 'answer';

interface Signal {
  type: SignalType;
  roomId: string;
  sdp: string;
}

const CODE_PREFIX = 'LF1.';
const CHANNEL_LABEL = 'low-game';
const STUN_URL = 'stun:stun.l.google.com:19302';
const ICE_TIMEOUT_MS = 8_000;
const MAX_CODE_LENGTH = 32_768;
const MAX_MESSAGE_LENGTH = 16_384;
const MAX_BUFFERED_BYTES = 128_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createRoomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function encodeSignal(signal: Signal): string {
  const bytes = new TextEncoder().encode(JSON.stringify(signal));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const payload = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return CODE_PREFIX + payload;
}

function decodeSignal(code: string, expectedType: SignalType): Signal {
  const trimmed = code.trim();
  const invalidCode = 'Код повреждён. Скопируйте его целиком и попробуйте снова.';

  if (expectedType === 'offer' && UUID_V4.test(trimmed)) {
    throw new Error('Для входа нужен полный код приглашения, который создал друг.');
  }

  if (!trimmed.startsWith(CODE_PREFIX) || trimmed.length > MAX_CODE_LENGTH) {
    throw new Error(invalidCode);
  }

  const payload = trimmed.slice(CODE_PREFIX.length);
  if (!/^[\w-]+$/.test(payload)) throw new Error(invalidCode);

  let signal: Partial<Signal> | null;
  try {
    const binary = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    signal = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(invalidCode);
  }

  if (
    !signal ||
    typeof signal.roomId !== 'string' ||
    !UUID_V4.test(signal.roomId) ||
    typeof signal.sdp !== 'string' ||
    !signal.sdp.startsWith('v=0') ||
    !/^m=application /m.test(signal.sdp) ||
    (signal.type !== 'offer' && signal.type !== 'answer')
  ) {
    throw new Error(invalidCode);
  }

  if (signal.type !== expectedType) {
    throw new Error(expectedType === 'offer' ? 'Вставьте код приглашения.' : 'Вставьте ответ второго игрока.');
  }

  return { type: signal.type, roomId: signal.roomId, sdp: signal.sdp };
}

export function readInviteRoomId(code: string): string {
  return decodeSignal(code, 'offer').roomId;
}

function waitForIce(connection: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (connection.iceGatheringState === 'complete') return Promise.resolve();

  return new Promise((resolve, reject) => {
    const cleanUp = () => {
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', onGathering);
      signal.removeEventListener('abort', onAbort);
    };

    const finish = () => {
      cleanUp();
      resolve();
    };

    const onGathering = () => {
      if (connection.iceGatheringState === 'complete') finish();
    };

    const onAbort = () => {
      cleanUp();
      reject(signal.reason);
    };

    // Use the candidates already collected when an external STUN server is slow.
    const timer = setTimeout(finish, ICE_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', onGathering);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class PeerSession {
  private readonly connection: RTCPeerConnection;
  private readonly abort = new AbortController();
  private channel: RTCDataChannel | null = null;
  private id: string | null = null;
  private state: PeerState | null = null;
  private negotiating = false;

  constructor(
    readonly role: PeerRole,
    private readonly callbacks: PeerCallbacks = {},
    { useStun = true }: PeerOptions = {},
  ) {
    if (typeof RTCPeerConnection === 'undefined') {
      throw new TypeError('В этом браузере WebRTC недоступен. Откройте игру в другом браузере.');
    }

    this.connection = new RTCPeerConnection({
      iceServers: useStun ? [{ urls: STUN_URL }] : [],
    });

    this.connection.ondatachannel = ({ channel }) => {
      if (this.role === 'guest') this.bindChannel(channel);
      else channel.close();
    };

    this.connection.onconnectionstatechange = () => this.updateConnectionState();
  }

  get roomId(): string | null {
    return this.id;
  }

  async createInvite(roomId = createRoomId()): Promise<string> {
    if (this.role !== 'host' || this.id) throw new Error('Создайте новую дуэль для приглашения.');
    this.beginNegotiation();

    try {
      this.bindChannel(this.connection.createDataChannel(CHANNEL_LABEL, { ordered: true }));
      await this.connection.setLocalDescription(await this.connection.createOffer());
      const code = await this.createCode('offer', roomId);
      this.id = roomId;
      return code;
    } catch (error) {
      this.dispose();
      if (error instanceof DOMException) {
        throw new TypeError('Не удалось создать приглашение. Попробуйте ещё раз.', { cause: error });
      }
      throw error;
    } finally {
      this.negotiating = false;
    }
  }

  async acceptInvite(code: string): Promise<string> {
    if (this.role !== 'guest' || this.id) throw new Error('Выйдите из текущей дуэли перед входом.');
    const invite = decodeSignal(code, 'offer');
    this.beginNegotiation();

    try {
      await this.connection.setRemoteDescription({ type: 'offer', sdp: invite.sdp });
      await this.connection.setLocalDescription(await this.connection.createAnswer());
      const answer = await this.createCode('answer', invite.roomId);
      this.id = invite.roomId;
      return answer;
    } catch (error) {
      this.dispose();
      if (error instanceof DOMException) {
        throw new TypeError('Не удалось открыть приглашение. Запросите у друга новый код.', { cause: error });
      }
      throw error;
    } finally {
      this.negotiating = false;
    }
  }

  async acceptAnswer(code: string): Promise<void> {
    if (this.role !== 'host' || !this.id) throw new Error('Сначала создайте приглашение.');
    const answer = decodeSignal(code, 'answer');
    if (answer.roomId !== this.id) throw new Error('Этот ответ относится к другой дуэли.');
    if (this.connection.signalingState !== 'have-local-offer') {
      throw new Error('Для этой дуэли уже принят ответ. Создайте новую дуэль.');
    }

    this.beginNegotiation();
    try {
      await this.connection.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      this.updateConnectionState();
    } catch (error) {
      throw new Error('Не удалось принять ответ. Попросите друга проверить код.', { cause: error });
    } finally {
      this.negotiating = false;
    }
  }

  send(data: unknown): boolean {
    const channel = this.channel;
    if (channel?.readyState !== 'open' || channel.bufferedAmount > MAX_BUFFERED_BYTES) {
      return false;
    }

    try {
      const message = JSON.stringify(data);
      if (!message || message.length > MAX_MESSAGE_LENGTH) return false;
      channel.send(message);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (this.abort.signal.aborted) return;
    this.dispose();
    this.setState('closed');
  }

  private dispose(): void {
    if (this.abort.signal.aborted) return;

    this.abort.abort(new Error('Подключение отменено.'));
    this.connection.onconnectionstatechange = null;
    this.connection.ondatachannel = null;

    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }

    this.connection.close();
  }

  private beginNegotiation(): void {
    if (this.abort.signal.aborted) throw new Error('Создайте новое подключение.');
    if (this.negotiating) throw new Error('Подождите завершения предыдущего действия.');
    this.negotiating = true;
  }

  private async createCode(type: SignalType, roomId: string): Promise<string> {
    await waitForIce(this.connection, this.abort.signal);
    const description = this.connection.localDescription;
    if (!description || !/^a=candidate:/m.test(description.sdp)) {
      throw new Error('Не найден сетевой адрес. Проверьте подключение и попробуйте снова.');
    }

    return encodeSignal({ type, roomId, sdp: description.sdp });
  }

  private bindChannel(channel: RTCDataChannel): void {
    if (this.channel || channel.label !== CHANNEL_LABEL) {
      channel.close();
      return;
    }

    this.channel = channel;
    channel.onopen = () => this.setState('connected');
    channel.onclose = () => this.close();
    channel.onerror = () => this.setState('failed');
    channel.onmessage = ({ data }) => {
      if (typeof data !== 'string' || data.length > MAX_MESSAGE_LENGTH) return;

      let message: unknown;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      this.callbacks.onData?.(message);
    };
  }

  private updateConnectionState(): void {
    switch (this.connection.connectionState) {
      case 'new':
        if (this.connection.remoteDescription) this.setState('connecting');
        break;
      case 'connecting':
        this.setState('connecting');
        break;
      case 'connected':
        if (this.channel?.readyState === 'open') this.setState('connected');
        break;
      case 'disconnected':
        this.setState('disconnected');
        break;
      case 'failed':
        this.setState('failed');
        break;
      case 'closed':
        this.close();
        break;
    }
  }

  private setState(state: PeerState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState?.(state);
  }
}
