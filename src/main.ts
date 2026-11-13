import type { GameState, Input } from './combat';
import type { DirectorySignal, DirectoryState, OnlinePlayer, PublicRoom, RoomIdentity } from './directory';
import type { PeerRole, PeerState } from './peer';
import type { Hex } from './stake-wallet';
import { Combat, EMPTY_INPUT, isGameState, isInput, MAX_HEALTH, TICK_RATE } from './combat';
import { RoomDirectory } from './directory';
import { normalizeNickname } from './nickname';
import { createRoomId, PeerSession, readInviteRoomId } from './peer';
import { ArenaRenderer } from './render';
import { Stakes } from './stakes';

function element<T extends HTMLElement>(id: string): T {
  const item = document.getElementById(id);
  if (!item) throw new Error(`Элемент интерфейса отсутствует: ${id}`);
  return item as T;
}

const ui = {
  nicknameScreen: element('nickname-screen'),
  nicknameForm: element<HTMLFormElement>('nickname-form'),
  nicknameInput: element<HTMLInputElement>('nickname-input'),
  nicknameSubmit: element<HTMLButtonElement>('nickname-submit'),
  nicknameError: element('nickname-error'),
  nicknameStatus: element('nickname-status'),
  cancelNickname: element<HTMLButtonElement>('cancel-nickname'),
  playerNickname: element('player-nickname'),
  editNickname: element<HTMLButtonElement>('edit-nickname'),
  header: element('game-header'),
  layout: element('game-layout'),
  overlay: element('arena-overlay'),
  kicker: element('arena-kicker'),
  title: element('arena-title'),
  arenaMessage: element('arena-message'),
  rematch: element<HTMLButtonElement>('rematch'),
  health: [element('p1-health'), element('p2-health')],
  hp: [element('p1-hp'), element('p2-hp')],
  score: [element('p1-score'), element('p2-score')],
  timer: element('timer'),
  indicator: element('connection-indicator'),
  status: element('connection-status'),
  initial: element('lobby-initial'),
  createPublic: element<HTMLButtonElement>('create-public-room'),
  publicStatus: element('public-status'),
  publicRooms: element('public-rooms'),
  onlineStatus: element('online-status'),
  onlinePlayers: element('online-players'),
  challenge: element('lobby-challenge'),
  challengeTitle: element('challenge-title'),
  challengeMessage: element('challenge-message'),
  acceptChallenge: element<HTMLButtonElement>('accept-challenge'),
  declineChallenge: element<HTMLButtonElement>('decline-challenge'),
  publicWait: element('lobby-public-wait'),
  publicWaitTitle: element('public-wait-title'),
  publicWaitMessage: element('public-wait-message'),
  publicWaitRoomId: element('public-wait-room-id'),
  manualConnection: element<HTMLDetailsElement>('manual-connection'),
  exchange: element('lobby-exchange'),
  connected: element('lobby-connected'),
  useStun: element<HTMLInputElement>('use-stun'),
  create: element<HTMLButtonElement>('create-room'),
  join: element<HTMLFormElement>('join-form'),
  invite: element<HTMLTextAreaElement>('invite-input'),
  exchangeTitle: element('exchange-title'),
  instructions: element('exchange-instructions'),
  outgoingLabel: element('outgoing-label'),
  outgoing: element<HTMLTextAreaElement>('outgoing-code'),
  copy: element<HTMLButtonElement>('copy-code'),
  copyLink: element<HTMLButtonElement>('copy-link'),
  answerForm: element<HTMLFormElement>('answer-form'),
  answer: element<HTMLTextAreaElement>('answer-input'),
  acceptAnswer: element<HTMLButtonElement>('accept-answer'),
  roomId: element('room-id'),
  lobbyMessage: element('lobby-message'),
  leave: element<HTMLButtonElement>('leave-room'),
  touch: element('touch-controls'),
  mobileFighter: element('mobile-fighter'),
  mobileLeave: element<HTMLButtonElement>('mobile-leave'),
  mobileFullscreen: element<HTMLButtonElement>('mobile-fullscreen'),
};

const keyboardActions = {
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'jump',
  KeyS: 'block',
  KeyF: 'attack',
} as const;
const keyCaps = new Map(
  Array.from(document.querySelectorAll<HTMLElement>('#control-guide kbd[data-key-code]'), (key) => [
    key.dataset.keyCode,
    key,
  ]),
);
const keyFlashTimers = new Map<string, number>();

const fighters = ['RUST', 'VOLT'] as const;
const nicknameStorageKey = 'low-game.nickname';
const challengeWaitMs = 30_000;
const countdownTicks = 3 * TICK_RATE;
const tickMs = 1000 / TICK_RATE;
const game = new Combat();
const renderer = new ArenaRenderer(element<HTMLCanvasElement>('arena'));

type Mode = 'idle' | PeerRole;
type Scores = [number, number];
type Admission = { identity: RoomIdentity; requestId: string };
type PublicAttempt =
  | {
      role: 'host';
      roomId: string;
      nickname: string;
      listed: boolean;
      guest: Admission | null;
      awaitingAnswer: boolean;
    }
  | { role: 'guest'; roomId: string; host: Admission };

type Challenge = {
  direction: 'incoming' | 'outgoing';
  player: OnlinePlayer;
  roomId: string;
  requestId: string;
};

type Frame = {
  kind: 'frame';
  round: number;
  countdown: number;
  stakeKey?: Hex;
  scores: Scores;
  game: GameState;
};

let nickname: string | null = null;
let checkingNickname = false;
let mode: Mode = 'idle';
let peer: PeerSession | null = null;
let directory: RoomDirectory | null = null;
let directoryState: DirectoryState = 'connecting';
let publicAttempt: PublicAttempt | null = null;
let listedRooms: PublicRoom[] = [];
let listedPlayers: OnlinePlayer[] = [];
let challenge: Challenge | null = null;
let challengeTimer: number | undefined;
const cancelledChallenges = new Map<string, number>();
let publicTimer: number | undefined;
let linkOpen = false;
let reconnectTimer: number | undefined;
let connectTimer: number | undefined;
let match: Frame | null = null;
let snapshotTick = 0;
let matchDirty = false;
let rematchRequested = false;
let remoteInput: Readonly<Input> = EMPTY_INPUT;
let remoteJump = false;
let remoteAttack = false;
let sentInput = '';
const keys = new Set<string>();
const touchActions = new Map<number, { action: keyof Input; button: HTMLButtonElement }>();
let ownsMatchFullscreen = false;

const stakes = new Stakes({
  send: (packet) => peer?.send(packet) ?? false,
  startRound: (key) => nextRound(key),
  clearInput: clearLocalInputs,
});

type LockableOrientation = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> };

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function storedNickname(): string | null {
  try {
    return normalizeNickname(localStorage.getItem(nicknameStorageKey) ?? '');
  } catch {
    return null;
  }
}

function showNicknameScreen(name = nickname ?? '', focus = Boolean(nickname)): void {
  ui.nicknameInput.value = name;
  ui.cancelNickname.hidden = !nickname;
  setText(ui.nicknameSubmit, nickname ? 'Сохранить' : 'Войти в лобби');
  setNicknameError('');
  setNicknameStatus('');
  ui.nicknameScreen.hidden = false;
  ui.header.hidden = true;
  ui.layout.hidden = true;
  stakes.setLobbyVisible(false);
  directory?.setAvailable(false);
  if (focus) {
    ui.nicknameInput.focus();
    ui.nicknameInput.select();
  }
}

function showGame(name: string): void {
  const editing = nickname !== null && !ui.nicknameScreen.hidden;
  nickname = name;
  setText(ui.playerNickname, name);
  ui.nicknameScreen.hidden = true;
  ui.header.hidden = false;
  ui.layout.hidden = false;
  stakes.setLobbyVisible(!ui.initial.hidden);
  directory?.setAvailable(true);
  renderPublicRooms();
  renderOnlinePlayers();
  if (editing) ui.editNickname.focus();
}

function setNicknameError(text: string): void {
  setText(ui.nicknameError, text);
  ui.nicknameError.hidden = !text;
  ui.nicknameInput.setAttribute('aria-invalid', String(Boolean(text)));
}

function setNicknameStatus(text: string, checking = false): void {
  setText(ui.nicknameStatus, text);
  ui.nicknameStatus.dataset.state = checking ? 'checking' : '';
}

function setCheckingNickname(checking: boolean): void {
  checkingNickname = checking;
  ui.nicknameForm.setAttribute('aria-busy', String(checking));
  ui.nicknameInput.readOnly = checking;
  ui.nicknameSubmit.disabled = checking;
  ui.cancelNickname.disabled = checking;
  setNicknameStatus(checking ? 'Проверяем никнейм…' : '', checking);
}

async function claimNickname(name: string): Promise<void> {
  if (checkingNickname) return;
  setNicknameError('');
  setCheckingNickname(true);

  if (!directory) connectDirectory();
  const currentDirectory = directory;
  let result: 'claimed' | 'taken' | 'offline' = 'offline';
  try {
    result = (await currentDirectory?.claimNickname(name)) ?? 'offline';
  } catch {
    // A failed check leaves the form open for retry.
  }
  if (currentDirectory !== directory) return;
  setCheckingNickname(false);

  if (result === 'taken') {
    setNicknameError('Никнейм уже занят игроком онлайн. Выберите другой.');
    ui.nicknameInput.focus();
    return;
  }
  if (result === 'offline') {
    setNicknameStatus('Не удалось проверить никнейм. Попробуйте ещё раз.');
    return;
  }
  try {
    localStorage.setItem(nicknameStorageKey, name);
  } catch {
    // The nickname remains available until the page closes.
  }
  showGame(name);
}

function saveNickname(event: SubmitEvent): void {
  event.preventDefault();
  const name = normalizeNickname(ui.nicknameInput.value);
  if (!name) {
    setNicknameError('Введите никнейм из 1–24 символов без знаков < и >.');
    ui.nicknameInput.focus();
    return;
  }
  void claimNickname(name);
}

function onNicknameLost(name: string): void {
  if (!nickname || nickname !== name) return;
  const lost = nickname;
  nickname = null;
  closeRoom('', false, true);
  showNicknameScreen(lost);
  setNicknameError('Никнейм уже занят игроком онлайн. Выберите другой.');
}

function message(text: string, isError = false): void {
  setText(ui.lobbyMessage, text);
  ui.lobbyMessage.dataset.error = String(isError);
  ui.lobbyMessage.hidden = text === '';
}

function connection(text: string, state: 'idle' | 'pending' | 'connected' | 'error'): void {
  setText(ui.status, text);
  ui.indicator.dataset.state = state;
}

function overlay(title: string, kicker: string, text: string, rematch = false): void {
  ui.overlay.hidden = title === '';
  setText(ui.title, title);
  setText(ui.kicker, kicker);
  setText(ui.arenaMessage, text);
  ui.kicker.hidden = kicker === '';
  ui.arenaMessage.hidden = text === '';
  ui.rematch.hidden = !rematch;
}

function clearLocalInputs(): void {
  keys.clear();
  for (const { button } of touchActions.values()) button.classList.remove('is-pressed');
  touchActions.clear();
}

function clearInputs(): void {
  clearLocalInputs();
  remoteInput = EMPTY_INPUT;
  remoteJump = false;
  remoteAttack = false;
}

function resetMatch(): void {
  mode = 'idle';
  match = null;
  game.reset();
  clearInputs();
  ui.touch.hidden = true;
  delete document.body.dataset.mobileMatch;
  delete document.body.dataset.mobileFighter;
  void exitMatchFullscreen();
  ui.rematch.disabled = false;
}

function updateFullscreenButton(): void {
  if (!document.fullscreenElement) ownsMatchFullscreen = false;
  const label = ownsMatchFullscreen ? 'Свернуть' : 'На весь экран';
  ui.mobileFullscreen.setAttribute('aria-label', label);
  ui.mobileFullscreen.title = label;
}

async function exitMatchFullscreen(): Promise<void> {
  if (!ownsMatchFullscreen || document.fullscreenElement !== document.documentElement) return;
  try {
    await document.exitFullscreen();
  } catch {
    // The browser may already be exiting fullscreen.
  }
  updateFullscreenButton();
}

async function toggleMatchFullscreen(): Promise<void> {
  if (ownsMatchFullscreen) {
    await exitMatchFullscreen();
    return;
  }
  if (mode === 'idle' || document.fullscreenElement || !document.fullscreenEnabled) return;

  const session = peer;
  ui.mobileFullscreen.disabled = true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    ownsMatchFullscreen = document.fullscreenElement === document.documentElement;
    if (session !== peer) {
      await exitMatchFullscreen();
      return;
    }
    updateFullscreenButton();
    const orientation = screen.orientation as LockableOrientation | undefined;
    await orientation?.lock?.('landscape');
  } catch {
    // The landscape layout also works inside the normal browser viewport.
  } finally {
    ui.mobileFullscreen.disabled = false;
  }
}

function nextRound(stakeKey?: Hex): void {
  const scores = match?.scores ?? [0, 0];
  const round = (match?.round ?? 0) + 1;
  game.reset();
  match = { kind: 'frame', game: game.state, scores, round, countdown: countdownTicks, stakeKey };
  matchDirty = true;
  rematchRequested = false;
  ui.rematch.disabled = false;
}

function startMatch(nextMode: PeerRole): void {
  resetMatch();
  mode = nextMode;
  const fighter = fighters[nextMode === 'guest' ? 1 : 0];
  ui.layout.scrollTop = 0;
  document.body.dataset.mobileMatch = 'true';
  document.body.dataset.mobileFighter = fighter.toLowerCase();
  ui.touch.hidden = false;
  ui.touch.setAttribute('aria-label', `Управление ${fighter}`);
  setText(ui.mobileFighter, `Вы — ${fighter}`);
  sentInput = '';
  if (nextMode === 'host') nextRound();
}

function canShareLink(): boolean {
  return (
    (location.protocol === 'https:' || location.protocol === 'http:') &&
    !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  );
}

function inviteFrom(text: string): string {
  const value = text.trim();
  if (!/^https?:\/\//i.test(value)) return value;
  const url = new URL(value);
  return new URLSearchParams(url.hash.slice(1)).get('invite') ?? value;
}

function setLobby(step: 'initial' | 'exchange' | 'public' | 'challenge' | 'connected'): void {
  ui.initial.hidden = step !== 'initial';
  stakes.setLobbyVisible(step === 'initial' && !ui.layout.hidden);
  ui.exchange.hidden = step !== 'exchange';
  ui.publicWait.hidden = step !== 'public';
  ui.challenge.hidden = step !== 'challenge';
  ui.connected.hidden = step !== 'connected';
  const incoming = step === 'challenge' && challenge?.direction === 'incoming';
  ui.leave.hidden = step === 'initial' || incoming;
  setText(ui.leave, step === 'challenge' ? 'Отменить вызов' : 'Покинуть комнату');
  ui.editNickname.disabled = step !== 'initial';
  directory?.setAvailable(step === 'initial' && !ui.layout.hidden && nickname !== null);
}

function closeRoom(note = '', isError = false, notifyPeer = false): void {
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(connectTimer);
  window.clearTimeout(publicTimer);
  const pendingChallenge = takeChallenge();
  if (pendingChallenge && notifyPeer) {
    sendChallengeNotice(
      pendingChallenge,
      pendingChallenge.direction === 'incoming' ? 'challenge-decline' : 'challenge-cancel',
    );
  }
  const attempt = publicAttempt;
  publicAttempt = null;
  if (attempt?.role === 'host' && attempt.listed) directory?.withdraw(attempt.roomId);
  if (attempt && notifyPeer) {
    const admission = attempt.role === 'host' ? attempt.guest : attempt.host;
    if (admission) sendPublicNotice(admission, attempt.roomId, attempt.role === 'host' ? 'reject' : 'cancel');
  }
  const closing = peer;
  peer = null;
  linkOpen = false;
  stakes.disconnect();
  if (notifyPeer && closing?.send({ kind: 'leave' })) {
    window.setTimeout(() => closing.close(), 250);
  } else {
    closing?.close();
  }
  resetMatch();
  ui.outgoing.value = '';
  ui.answer.value = '';
  ui.acceptAnswer.disabled = false;
  ui.leave.disabled = false;
  setLobby('initial');
  renderOnlinePlayers();
  connection(isError ? 'Связь прервана' : 'Нет соединения', isError ? 'error' : 'idle');
  message(note, isError);
}

function peerState(session: PeerSession, state: PeerState): void {
  if (session !== peer) return;
  if (state === 'connected') {
    window.clearTimeout(reconnectTimer);
    window.clearTimeout(connectTimer);
    window.clearTimeout(publicTimer);
    linkOpen = true;
    ui.roomId.textContent = session.roomId;
    setLobby('connected');
    connection('P2P · соединено', 'connected');
    message(`Ваш боец — ${fighters[session.role === 'host' ? 0 : 1]}.`);
    if (mode !== session.role) startMatch(session.role);
    if (session.roomId) stakes.connect(session.roomId, session.role);
    matchDirty = true;
    return;
  }

  if (state === 'disconnected' && mode === session.role) {
    linkOpen = false;
    clearInputs();
    sentInput = '';
    connection('Восстанавливаем связь', 'pending');
    message('Соединение прервалось. Пробуем восстановить связь.');
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(() => {
      if (session === peer && !linkOpen) {
        closeRoom('Связь потеряна. Создайте новую комнату.', true);
      }
    }, 12_000);
    return;
  }

  if (state === 'failed') {
    if (!linkOpen && mode === 'idle' && publicAttempt?.role === 'host' && publicAttempt.listed) {
      void reopenPublicRoom(publicAttempt, 'Прямое соединение с соперником недоступно.');
      return;
    }
    closeRoom(
      publicAttempt
        ? 'Прямое соединение недоступно. Попробуйте подключиться из одной сети.'
        : 'Прямое соединение недоступно. Проверьте коды или попробуйте подключиться из одной сети.',
      true,
      true,
    );
  } else if (state === 'closed' && (publicAttempt || mode === session.role || !ui.outgoing.disabled)) {
    closeRoom('Игрок покинул комнату.', true);
  }
}

function isScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFrame(value: Record<string, unknown>): value is Frame {
  return (
    value.kind === 'frame' &&
    isScore(value.round) &&
    value.round > 0 &&
    isScore(value.countdown) &&
    value.countdown <= countdownTicks &&
    Array.isArray(value.scores) &&
    value.scores.length === 2 &&
    value.scores.every(isScore) &&
    isGameState(value.game)
  );
}

function receive(session: PeerSession, data: unknown): void {
  if (session !== peer || data === null || typeof data !== 'object') return;
  const packet = data as Record<string, unknown>;
  if (packet.kind === 'leave') {
    closeRoom('Игрок покинул комнату.');
    return;
  }

  if (stakes.receive(packet)) return;
  if (session.role === 'host') {
    if (packet.kind === 'input' && isInput(packet.input)) {
      remoteJump ||= packet.input.jump && !remoteInput.jump;
      remoteAttack ||= packet.input.attack && !remoteInput.attack;
      remoteInput = packet.input;
    } else if (
      packet.kind === 'rematch' &&
      match &&
      match.game.winner !== null &&
      packet.round === match.round &&
      !stakes.hasMatch
    ) {
      nextRound();
    }
  } else if (isFrame(packet) && (!match || packet.round >= match.round)) {
    if (packet.stakeKey && !stakes.canPlay(packet.stakeKey)) return;
    if (packet.round !== match?.round) {
      rematchRequested = false;
      ui.rematch.disabled = false;
    }
    match = packet;
    if (packet.stakeKey && packet.game.winner !== null) stakes.recordResult(packet.stakeKey, packet.game.winner);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось подключиться. Попробуйте ещё раз.';
}

function attachPeer(role: PeerRole, useStun: boolean): PeerSession {
  const session = new PeerSession(
    role,
    {
      onState: (state) => peerState(session, state),
      onData: (data) => receive(session, data),
    },
    { useStun },
  );
  peer = session;
  return session;
}

function sameIdentity(a: RoomIdentity, b: RoomIdentity): boolean {
  return a.id === b.id && a.key === b.key;
}

function renderPublicRooms(): void {
  const online = directoryState === 'online';
  const canPlay = online && directory?.hasNickname === true;
  ui.createPublic.disabled = !canPlay;
  const unavailable =
    directoryState === 'unsupported'
      ? 'Общее лобби доступно в браузере на HTTPS или при открытии HTML-файла.'
      : 'Связь с общим лобби потеряна. Пробуем подключиться снова.';
  const status = online
    ? 'Открытых комнат пока нет.'
    : directoryState === 'connecting'
      ? 'Подключаемся к общему лобби…'
      : unavailable;
  setText(ui.publicStatus, status);
  ui.publicStatus.hidden = online && listedRooms.length > 0;
  ui.publicRooms.hidden = !online || listedRooms.length === 0;

  const items = listedRooms.map((room) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const label = document.createElement('span');
    const action = document.createElement('span');
    button.type = 'button';
    button.className = 'public-room';
    button.disabled = !canPlay;
    button.title = room.id;
    label.className = 'public-room-id';
    label.textContent = room.nickname ?? `Комната ${room.id.slice(0, 8)}`;
    action.className = 'public-room-action';
    action.textContent = 'Войти';
    button.append(label, action);
    button.addEventListener('click', () => {
      void joinPublicRoom(room);
    });
    item.append(button);
    return item;
  });
  ui.publicRooms.replaceChildren(...items);
}

function canChallenge(): boolean {
  return Boolean(nickname && !ui.layout.hidden && directory?.hasNickname && !peer && !publicAttempt && !challenge);
}

function renderOnlinePlayers(): void {
  const online = directoryState === 'online';
  const available = canChallenge();
  const status = online
    ? 'Других игроков онлайн пока нет.'
    : directoryState === 'connecting'
      ? 'Подключаемся к общему лобби…'
      : 'Список игроков временно недоступен.';
  setText(ui.onlineStatus, status);
  ui.onlineStatus.hidden = online && listedPlayers.length > 0;
  ui.onlinePlayers.hidden = !online || listedPlayers.length === 0;

  const items = listedPlayers.map((player) => {
    const item = document.createElement('li');
    item.className = 'online-player';
    const label = document.createElement('span');
    label.className = 'online-player-name';
    label.dir = 'auto';
    label.textContent = player.nickname;
    if (player.available) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-secondary online-challenge';
      button.textContent = 'Вызвать';
      button.setAttribute('aria-label', `Вызвать ${player.nickname} на бой`);
      button.disabled = !available;
      button.addEventListener('click', () => {
        void sendChallenge(player);
      });
      item.append(label, button);
    } else {
      const status = document.createElement('span');
      status.className = 'online-player-state';
      status.textContent = 'Занят';
      item.append(label, status);
    }
    return item;
  });
  ui.onlinePlayers.replaceChildren(...items);
}

function connectDirectory(): void {
  directoryState = 'connecting';
  listedRooms = [];
  listedPlayers = [];
  renderPublicRooms();
  renderOnlinePlayers();
  directory = new RoomDirectory({
    onState(state) {
      directoryState = state;
      renderPublicRooms();
      renderOnlinePlayers();
      if (state === 'offline' && challenge) closeRoom('Связь с общим лобби потеряна. Отправьте вызов ещё раз.', true);
      if (publicAttempt?.role === 'host' && publicAttempt.listed && !publicAttempt.guest) {
        setText(
          ui.publicWaitMessage,
          state === 'online' ? 'Комната видна в общем лобби.' : 'Восстанавливаем связь с общим лобби…',
        );
      }
    },
    onRooms(rooms) {
      if (
        rooms.length === listedRooms.length &&
        rooms.every((room, index) => {
          const previous = listedRooms[index];
          return (
            room.id === previous.id && room.nickname === previous.nickname && sameIdentity(room.host, previous.host)
          );
        })
      )
        return;
      listedRooms = rooms;
      renderPublicRooms();
    },
    onPlayers(players) {
      listedPlayers = players;
      renderOnlinePlayers();
    },
    onSignal(sender, signal) {
      if (
        signal.kind === 'challenge' ||
        signal.kind === 'challenge-accept' ||
        signal.kind === 'challenge-decline' ||
        signal.kind === 'challenge-cancel'
      ) {
        void receiveChallenge(sender, { ...signal, kind: signal.kind });
      } else {
        void receivePublicSignal(sender, signal);
      }
    },
    onNicknameLost,
  });
}

function openPublicWait(attempt: PublicAttempt, title: string, text: string): void {
  publicAttempt = attempt;
  resetMatch();
  setLobby('public');
  setText(ui.publicWaitTitle, title);
  setText(ui.publicWaitMessage, text);
  setText(ui.publicWaitRoomId, attempt.roomId);
  ui.publicWaitRoomId.hidden = false;
  connection('Общее лобби', 'pending');
  message('');
}

type ChallengeKind = 'challenge' | 'challenge-accept' | 'challenge-decline' | 'challenge-cancel';

function showChallenge(next: Challenge): void {
  challenge = next;
  const incoming = next.direction === 'incoming';
  setLobby('challenge');
  setText(ui.challengeTitle, incoming ? 'Вызов на бой' : 'Вызов отправлен');
  setText(
    ui.challengeMessage,
    incoming ? `${next.player.nickname} вызывает вас на бой.` : `Ждём ответа от ${next.player.nickname}.`,
  );
  ui.acceptChallenge.hidden = !incoming;
  ui.declineChallenge.hidden = !incoming;
  connection('Вызов на бой', 'pending');
  message('');
  challengeTimer = window.setTimeout(() => {
    if (challenge === next) closeRoom('Время ожидания ответа истекло.', false, true);
  }, challengeWaitMs);
}

function takeChallenge(): Challenge | null {
  window.clearTimeout(challengeTimer);
  const previous = challenge;
  challenge = null;
  return previous;
}

function sendChallengeNotice(pending: Challenge, kind: ChallengeKind): void {
  void directory
    ?.send(pending.player.identity, {
      kind,
      roomId: pending.roomId,
      requestId: pending.requestId,
    })
    .catch(() => {});
}

async function sendChallenge(player: OnlinePlayer): Promise<void> {
  const rooms = directory;
  if (!rooms || !canChallenge()) return;
  if (!listedPlayers.some((other) => other.available && sameIdentity(other.identity, player.identity))) {
    message('Игрок сейчас недоступен.', true);
    return;
  }
  const next: Challenge = {
    direction: 'outgoing',
    player,
    roomId: createRoomId(),
    requestId: createRoomId(),
  };
  showChallenge(next);
  try {
    await rooms.send(player.identity, { kind: 'challenge', roomId: next.roomId, requestId: next.requestId });
  } catch (error) {
    if (challenge === next) closeRoom(errorText(error), true);
  }
}

function opponentInRoom(attempt: PublicAttempt): Admission | null {
  return attempt.role === 'host' ? attempt.guest : attempt.host;
}

async function acceptChallenge(): Promise<void> {
  const incoming = challenge;
  const rooms = directory;
  if (incoming?.direction !== 'incoming' || !rooms?.hasNickname) return;

  takeChallenge();
  const attempt: PublicAttempt = {
    role: 'guest',
    roomId: incoming.roomId,
    host: { identity: incoming.player.identity, requestId: incoming.requestId },
  };
  openPublicWait(attempt, 'Подключаемся', 'Устанавливаем прямое соединение…');
  publicTimer = window.setTimeout(() => {
    if (publicAttempt === attempt && !linkOpen) closeRoom('Подключение заняло слишком много времени.', true, true);
  }, 42_000);
  try {
    await rooms.send(incoming.player.identity, {
      kind: 'challenge-accept',
      roomId: incoming.roomId,
      requestId: incoming.requestId,
    });
  } catch (error) {
    if (publicAttempt === attempt) closeRoom(errorText(error), true, true);
  }
}

async function receiveChallenge(
  sender: RoomIdentity,
  signal: { kind: ChallengeKind; roomId: string; requestId: string },
): Promise<void> {
  const current = challenge;
  const challengeKey = `${sender.id}/${signal.roomId}/${signal.requestId}`;
  const now = Date.now();
  for (const [id, expires] of cancelledChallenges) {
    if (expires <= now) cancelledChallenges.delete(id);
  }
  if (signal.kind === 'challenge-cancel') cancelledChallenges.set(challengeKey, now + challengeWaitMs);
  if (signal.kind === 'challenge') {
    if (cancelledChallenges.has(challengeKey)) return;
    if (
      current?.direction === 'incoming' &&
      current.roomId === signal.roomId &&
      current.requestId === signal.requestId &&
      sameIdentity(sender, current.player.identity)
    )
      return;

    const player = listedPlayers.find((other) => sameIdentity(sender, other.identity));
    if (!player) {
      void directory?.send(sender, { ...signal, kind: 'challenge-decline' }).catch(() => {});
      return;
    }
    const incoming: Challenge = { direction: 'incoming', player, roomId: signal.roomId, requestId: signal.requestId };
    if (!canChallenge()) {
      const isReciprocal = current?.direction === 'outgoing' && sameIdentity(sender, current.player.identity);
      if (!isReciprocal) {
        sendChallengeNotice(incoming, 'challenge-decline');
        return;
      }
      // Pick the same invitation on both sides if both players click at once.
      if (!directory?.identity || directory.identity.id < sender.id) return;
      takeChallenge();
    }
    showChallenge(incoming);
    return;
  }

  if (
    !current ||
    !sameIdentity(sender, current.player.identity) ||
    signal.roomId !== current.roomId ||
    signal.requestId !== current.requestId
  ) {
    const attempt = publicAttempt;
    const opponent = attempt && opponentInRoom(attempt);
    const sameAttempt =
      attempt?.roomId === signal.roomId &&
      opponent?.requestId === signal.requestId &&
      sameIdentity(sender, opponent.identity);
    if (signal.kind === 'challenge-cancel' && !linkOpen && attempt?.role === 'guest' && sameAttempt) {
      closeRoom('Соперник отменил вызов.');
    } else if (signal.kind === 'challenge-accept' && !sameAttempt) {
      void directory?.send(sender, { ...signal, kind: 'reject' }).catch(() => {});
    }
    return;
  }

  if (signal.kind === 'challenge-decline' && current.direction === 'outgoing') {
    closeRoom(`${current.player.nickname} не принял вызов.`);
  } else if (signal.kind === 'challenge-cancel' && current.direction === 'incoming') {
    closeRoom('Соперник отменил вызов.');
  } else if (signal.kind === 'challenge-accept' && current.direction === 'outgoing' && nickname) {
    takeChallenge();
    const attempt: PublicAttempt = {
      role: 'host',
      roomId: current.roomId,
      nickname,
      listed: false,
      guest: null,
      awaitingAnswer: false,
    };
    openPublicWait(attempt, 'Вызов принят', 'Устанавливаем прямое соединение…');
    await admitPublicGuest(attempt, { identity: sender, requestId: signal.requestId });
  }
}

async function createPublicRoom(): Promise<void> {
  if (!nickname || peer || publicAttempt || challenge || !directory?.hasNickname) return;
  const attempt: PublicAttempt = {
    role: 'host',
    roomId: createRoomId(),
    nickname,
    listed: true,
    guest: null,
    awaitingAnswer: false,
  };
  openPublicWait(attempt, 'Ждём соперника', 'Публикуем комнату…');
  try {
    await directory.announce(attempt.roomId, attempt.nickname);
    if (!attempt.guest && publicAttempt === attempt) {
      setText(ui.publicWaitMessage, 'Комната видна в общем лобби.');
    }
  } catch (error) {
    if (publicAttempt === attempt) closeRoom(errorText(error), true);
  }
}

async function joinPublicRoom(room: PublicRoom): Promise<void> {
  if (!nickname || peer || publicAttempt || challenge || !directory?.hasNickname) return;
  const requestId = createRoomId();
  const attempt: PublicAttempt = { role: 'guest', roomId: room.id, host: { identity: room.host, requestId } };
  openPublicWait(attempt, 'Подключаемся', 'Ждём ответа создателя комнаты.');
  publicTimer = window.setTimeout(() => {
    if (publicAttempt === attempt && !linkOpen) {
      closeRoom('Комната не ответила. Выберите другую или попробуйте ещё раз.', true, true);
    }
  }, 42_000);
  try {
    await directory.send(room.host, { kind: 'request', roomId: room.id, requestId });
  } catch (error) {
    if (publicAttempt === attempt) closeRoom(errorText(error), true, true);
  }
}

function sendPublicNotice(admission: Admission, roomId: string, kind: 'reject' | 'cancel'): void {
  void directory?.send(admission.identity, { kind, roomId, requestId: admission.requestId }).catch(() => {});
}

async function reopenPublicRoom(attempt: Extract<PublicAttempt, { role: 'host' }>, note: string): Promise<void> {
  if (publicAttempt !== attempt || mode !== 'idle') return;
  const admission = attempt.guest;
  attempt.guest = null;
  attempt.awaitingAnswer = false;
  window.clearTimeout(publicTimer);
  const closing = peer;
  peer = null;
  closing?.close();
  if (admission) sendPublicNotice(admission, attempt.roomId, 'reject');
  setText(ui.publicWaitTitle, 'Ждём соперника');
  setText(ui.publicWaitMessage, 'Публикуем комнату…');
  connection('Общее лобби', 'pending');
  message(note, note !== '');
  try {
    if (!directory) throw new Error('Общее лобби недоступно.');
    await directory.announce(attempt.roomId, attempt.nickname);
    if (publicAttempt === attempt && !attempt.guest) setText(ui.publicWaitMessage, 'Комната видна в общем лобби.');
  } catch (error) {
    if (publicAttempt === attempt) closeRoom(errorText(error), true);
  }
}

async function admitPublicGuest(
  attempt: Extract<PublicAttempt, { role: 'host' }>,
  admission: Admission,
): Promise<void> {
  if (attempt.guest) {
    if (!sameIdentity(attempt.guest.identity, admission.identity) || attempt.guest.requestId !== admission.requestId) {
      sendPublicNotice(admission, attempt.roomId, 'reject');
    }
    return;
  }
  const rooms = directory;
  if (!rooms) return;
  attempt.guest = admission;
  if (attempt.listed) rooms.withdraw(attempt.roomId);
  setText(ui.publicWaitTitle, 'Соперник найден');
  setText(ui.publicWaitMessage, 'Устанавливаем прямое соединение…');
  message('');
  publicTimer = window.setTimeout(() => {
    if (publicAttempt !== attempt || attempt.guest !== admission) return;
    if (attempt.listed) void reopenPublicRoom(attempt, 'Подключение заняло слишком много времени.');
    else closeRoom('Подключение заняло слишком много времени.', true, true);
  }, 38_000);
  try {
    const session = attachPeer('host', true);
    const code = await session.createInvite(attempt.roomId);
    if (publicAttempt !== attempt || attempt.guest !== admission || session !== peer) return;
    attempt.awaitingAnswer = true;
    await rooms.send(admission.identity, {
      kind: 'invite',
      roomId: attempt.roomId,
      requestId: admission.requestId,
      code,
    });
  } catch (error) {
    if (publicAttempt !== attempt || attempt.guest !== admission) return;
    if (attempt.listed) await reopenPublicRoom(attempt, errorText(error));
    else closeRoom(errorText(error), true, true);
  }
}

async function receivePublicSignal(sender: RoomIdentity, signal: DirectorySignal): Promise<void> {
  const attempt = publicAttempt;
  if (!attempt || signal.roomId !== attempt.roomId) return;
  if (mode !== 'idle') {
    const opponent = opponentInRoom(attempt);
    if (attempt.role === 'host' && signal.kind === 'request') {
      sendPublicNotice({ identity: sender, requestId: signal.requestId }, attempt.roomId, 'reject');
    } else if (
      opponent &&
      sameIdentity(sender, opponent.identity) &&
      signal.requestId === opponent.requestId &&
      signal.kind === (attempt.role === 'host' ? 'cancel' : 'reject')
    ) {
      closeRoom('Игрок покинул комнату.');
    }
    return;
  }
  if (attempt.role === 'host' && signal.kind === 'request') {
    if (!attempt.listed) return;
    await admitPublicGuest(attempt, { identity: sender, requestId: signal.requestId });
    return;
  }

  const admission = attempt.role === 'host' ? attempt.guest : attempt.host;
  if (!admission || !sameIdentity(sender, admission.identity) || signal.requestId !== admission.requestId) return;

  try {
    if (attempt.role === 'host') {
      if (signal.kind === 'cancel') {
        if (attempt.listed) await reopenPublicRoom(attempt, '');
        else closeRoom('Соперник отменил подключение.');
      } else if (signal.kind === 'answer' && peer && attempt.awaitingAnswer) {
        attempt.awaitingAnswer = false;
        await peer.acceptAnswer(signal.code);
      }
    } else if (signal.kind === 'reject') {
      closeRoom('Соперник закрыл комнату или отменил подключение.', true);
    } else if (signal.kind === 'invite' && !peer && directory) {
      if (readInviteRoomId(signal.code) !== attempt.roomId) throw new Error('Приглашение относится к другой комнате.');
      const session = attachPeer('guest', true);
      setText(ui.publicWaitMessage, 'Устанавливаем прямое соединение…');
      const code = await session.acceptInvite(signal.code);
      if (publicAttempt !== attempt || session !== peer) return;
      await directory.send(sender, { kind: 'answer', roomId: signal.roomId, requestId: signal.requestId, code });
    }
  } catch (error) {
    if (publicAttempt !== attempt) return;
    if (attempt.role === 'host' && attempt.guest === admission && attempt.listed) {
      await reopenPublicRoom(attempt, errorText(error));
    } else {
      closeRoom(errorText(error), true, true);
    }
  }
}

async function openRoom(role: PeerRole): Promise<void> {
  if (!nickname || peer || publicAttempt || challenge) return;
  if (!directory?.hasNickname) {
    message('Ждём подключения к общему лобби для проверки никнейма.', true);
    return;
  }
  let invite = '';
  let session: PeerSession | undefined;
  try {
    if (role === 'guest') {
      invite = inviteFrom(ui.invite.value);
      readInviteRoomId(invite);
    }
    session = attachPeer(role, ui.useStun.checked);
    resetMatch();

    ui.outgoing.value = '';
    ui.outgoing.disabled = true;
    ui.copy.disabled = true;
    ui.copyLink.hidden = true;
    ui.answerForm.hidden = true;
    ui.exchangeTitle.textContent = role === 'host' ? 'Пригласите друга' : 'Отправьте ответ';
    ui.outgoingLabel.textContent = role === 'host' ? 'Код приглашения' : 'Код ответа';
    ui.instructions.textContent = 'Готовим данные подключения…';
    setLobby('exchange');
    connection('Подготовка', 'pending');
    message('');

    const code = await (role === 'host' ? session.createInvite() : session.acceptInvite(invite));
    if (session !== peer || linkOpen) return;
    ui.outgoing.value = code;
    ui.outgoing.disabled = false;
    ui.copy.disabled = false;
    ui.copyLink.hidden = role !== 'host' || !canShareLink();
    ui.answerForm.hidden = role !== 'host';
    ui.instructions.textContent =
      role === 'host'
        ? 'Отправьте приглашение другу и вставьте его ответ.'
        : 'Передайте этот код создателю комнаты. Игра начнётся после того, как он вставит ответ.';
    connection(role === 'host' ? 'Ждём ответ' : 'Ждём игрока', 'pending');
  } catch (error) {
    if (!session) {
      message(errorText(error), true);
    } else if (session === peer) {
      closeRoom(errorText(error), true);
    }
  }
}

async function acceptAnswer(): Promise<void> {
  const session = peer;
  if (session?.role !== 'host') return;
  ui.acceptAnswer.disabled = true;
  message('');
  try {
    await session.acceptAnswer(ui.answer.value);
    if (session === peer && !linkOpen) {
      connection('Устанавливаем связь', 'pending');
      message('Подключаемся напрямую…');
      connectTimer = window.setTimeout(() => {
        if (session === peer && !linkOpen) {
          closeRoom('Прямое соединение недоступно. Попробуйте подключиться из одной сети.', true);
        }
      }, 25_000);
    }
  } catch (error) {
    if (session === peer && !linkOpen) {
      ui.acceptAnswer.disabled = false;
      message(errorText(error), true);
    }
  }
}

async function copyCode(asLink: boolean): Promise<void> {
  let value = ui.outgoing.value;
  if (!value) return;
  if (asLink) {
    const url = new URL(location.href);
    url.hash = new URLSearchParams({ invite: value }).toString();
    value = url.href;
  }
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const temporary = document.createElement('textarea');
    temporary.value = value;
    temporary.style.position = 'fixed';
    temporary.style.opacity = '0';
    document.body.append(temporary);
    temporary.select();
    const copied = document.execCommand('copy');
    temporary.remove();
    if (!copied) {
      ui.outgoing.focus();
      ui.outgoing.select();
      message('Скопируйте выделенный код вручную.');
      return;
    }
  }
  message(asLink ? 'Ссылка скопирована.' : 'Код скопирован.');
}

function keyInput(): Input {
  const input = { ...EMPTY_INPUT };
  for (const [key, action] of Object.entries(keyboardActions)) {
    if (keys.has(key)) input[action] = true;
  }
  for (const { action } of touchActions.values()) input[action] = true;
  return input;
}

function flashKey(code: string): void {
  const key = keyCaps.get(code);
  if (!key) return;

  window.clearTimeout(keyFlashTimers.get(code));
  key.classList.add('is-pressed');
  keyFlashTimers.set(
    code,
    window.setTimeout(() => {
      key.classList.remove('is-pressed');
      keyFlashTimers.delete(code);
    }, 160),
  );
}

function pressKey(event: KeyboardEvent): void {
  if (!Object.hasOwn(keyboardActions, event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea, input, select'))) return;

  if (!event.repeat) flashKey(event.code);
  if (!linkOpen || stakes.isOpen) return;

  event.preventDefault();
  keys.add(event.code);
}

function simulate(): void {
  if (mode === 'idle' || !linkOpen) return;
  if (mode === 'guest') {
    const input = keyInput();
    const signature = JSON.stringify(input);
    if (signature !== sentInput && peer?.send({ kind: 'input', input })) sentInput = signature;
    return;
  }
  if (!match) return;

  if (match.countdown > 0) {
    match.countdown -= 1;
    matchDirty = true;
  } else if (match.game.winner === null) {
    const first = keyInput();
    const second = {
      ...remoteInput,
      jump: remoteInput.jump || remoteJump,
      attack: remoteInput.attack || remoteAttack,
    };
    game.step([first, second]);
    remoteJump = false;
    remoteAttack = false;
    if (match.game.winner === 0 || match.game.winner === 1) match.scores[match.game.winner] += 1;
    if (match.stakeKey && match.game.winner !== null) stakes.recordResult(match.stakeKey, match.game.winner);
    matchDirty = true;
  }
  snapshotTick += 1;
  if (matchDirty && snapshotTick % 2 === 0 && peer?.send(match)) {
    matchDirty = false;
  }
}

function updateScreen(): void {
  const state = match?.game ?? game.state;
  for (const index of [0, 1] as const) {
    const health = state.fighters[index].health;
    const width = `${(health / MAX_HEALTH) * 100}%`;
    if (ui.health[index].style.width !== width) ui.health[index].style.width = width;
    setText(ui.hp[index], String(health));
    setText(ui.score[index], String(match?.scores[index] ?? 0));
  }
  const seconds = Math.ceil(state.ticksRemaining / TICK_RATE);
  setText(ui.timer, String(seconds).padStart(2, '0'));

  if (mode === 'idle') {
    if (peer || publicAttempt || challenge) {
      overlay('Ждём соперника', 'СЕТЕВОЙ МАТЧ', 'Завершите подключение в лобби.');
    } else {
      overlay('К бою!', '', 'Создайте комнату или выберите соперника в лобби.');
    }
  } else if (!linkOpen) {
    overlay('Пауза', 'НЕТ СВЯЗИ', 'Ждём восстановления соединения.');
  } else if (!match) {
    overlay('На арену', 'СЕТЕВОЙ МАТЧ', 'Ждём начала раунда.');
  } else if (match.countdown > 0) {
    overlay(String(Math.ceil(match.countdown / TICK_RATE)), `РАУНД ${match.round}`, '');
  } else if (state.winner !== null) {
    const winner = state.winner === 'draw' ? 'Ничья' : `${fighters[state.winner]} победил`;
    const reason = seconds === 0 ? 'Время вышло' : 'Нокаут';
    overlay(
      winner,
      `РАУНД ${match.round} ЗАВЕРШЁН`,
      rematchRequested ? 'Ждём начала раунда…' : reason,
      !stakes.hasMatch,
    );
  } else {
    overlay('', '', '');
  }
}

ui.nicknameForm.addEventListener('submit', saveNickname);
ui.nicknameInput.addEventListener('input', () => setNicknameError(''));
ui.editNickname.addEventListener('click', () => {
  if (!peer && !publicAttempt && !challenge) showNicknameScreen();
});
ui.cancelNickname.addEventListener('click', () => {
  if (nickname) showGame(nickname);
});
ui.acceptChallenge.addEventListener('click', () => {
  void acceptChallenge();
});
ui.declineChallenge.addEventListener('click', () => closeRoom('Вызов отклонён.', false, true));
ui.createPublic.addEventListener('click', () => {
  void createPublicRoom();
});
ui.create.addEventListener('click', () => {
  void openRoom('host');
});
ui.join.addEventListener('submit', (event) => {
  event.preventDefault();
  void openRoom('guest');
});
ui.answerForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void acceptAnswer();
});
ui.copy.addEventListener('click', () => {
  void copyCode(false);
});
ui.copyLink.addEventListener('click', () => {
  void copyCode(true);
});
ui.leave.addEventListener('click', () => closeRoom('', false, true));
ui.mobileLeave.addEventListener('click', () => closeRoom('', false, true));
ui.mobileFullscreen.hidden =
  !document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function';
ui.mobileFullscreen.addEventListener('click', () => {
  void toggleMatchFullscreen();
});
document.addEventListener('fullscreenchange', updateFullscreenButton);
ui.rematch.addEventListener('click', () => {
  if (!match || match.game.winner === null || stakes.hasMatch) return;
  ui.rematch.blur();
  if (mode === 'host') {
    nextRound();
  } else if (mode === 'guest' && peer?.send({ kind: 'rematch', round: match.round })) {
    rematchRequested = true;
    ui.rematch.disabled = true;
  }
});

document.addEventListener('keydown', pressKey);
document.addEventListener('keyup', (event) => {
  keys.delete(event.code);
});
window.addEventListener('blur', clearLocalInputs);
document.addEventListener('visibilitychange', clearLocalInputs);
window.addEventListener('pagehide', () => {
  if (peer || publicAttempt || challenge) closeRoom('', false, true);
  directory?.close();
  directory = null;
  setCheckingNickname(false);
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || directory) return;
  const previous = nickname ?? storedNickname();
  nickname = null;
  showNicknameScreen(previous ?? '');
  if (previous) void claimNickname(previous);
});

for (const button of ui.touch.querySelectorAll<HTMLButtonElement>('button[data-action]')) {
  const action = button.dataset.action as keyof Input;
  button.addEventListener('pointerdown', (event) => {
    if (!linkOpen || event.button !== 0) return;
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    touchActions.set(event.pointerId, { action, button });
    button.classList.add('is-pressed');
  });
  function release(event: PointerEvent): void {
    touchActions.delete(event.pointerId);
    const stillPressed = Array.from(touchActions.values()).some((touch) => touch.button === button);
    if (!stillPressed) button.classList.remove('is-pressed');
  }
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
}

const sharedInvite = new URLSearchParams(location.hash.slice(1)).get('invite');
if (sharedInvite) {
  ui.manualConnection.open = true;
  ui.invite.value = sharedInvite;
}
const previousNickname = storedNickname();
if (previousNickname) {
  ui.nicknameInput.value = previousNickname;
  void claimNickname(previousNickname);
}

let lastTime = performance.now();
let accumulated = 0;
function animate(time: number): void {
  accumulated += Math.min(100, Math.max(0, time - lastTime));
  lastTime = time;
  while (accumulated >= tickMs) {
    simulate();
    accumulated -= tickMs;
  }
  if (!ui.layout.hidden) {
    renderer.draw(match?.game ?? game.state, time);
    updateScreen();
  }
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
