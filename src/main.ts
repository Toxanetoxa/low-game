import type { GameState, Input } from './combat';
import type { DirectorySignal, DirectoryState, OnlinePlayer, PublicRoom, RoomIdentity } from './directory';
import type { PeerRole, PeerState } from './peer';
import type { Hex } from './stake-wallet';
import { Combat, EMPTY_INPUT, isGameState, isInput, MAX_HEALTH, predictWalk, TICK_RATE } from './combat';
import { RoomDirectory } from './directory';
import { normalizeNickname } from './nickname';
import { createRoomId, PeerSession, readInviteRoomId } from './peer';
import { privateInviteCode, readPrivateInvite } from './private-invite';
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
  roundActions: element('round-actions'),
  roundLobby: element<HTMLButtonElement>('round-lobby'),
  health: [element('p1-health'), element('p2-health')],
  hp: [element('p1-hp'), element('p2-hp')],
  healthLabel: [element('p1-health-label'), element('p2-health-label')],
  fighterName: [element('p1-name'), element('p2-name')],
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
  privateShare: element('private-share'),
  privateShareValue: element<HTMLInputElement>('private-share-value'),
  privateShareLabel: element('private-share-label'),
  privateShareCopy: element<HTMLButtonElement>('private-share-copy'),
  privateShareTelegram: element<HTMLAnchorElement>('private-share-telegram'),
  manualConnection: element<HTMLDetailsElement>('manual-connection'),
  exchange: element('lobby-exchange'),
  connected: element('lobby-connected'),
  useStun: element<HTMLInputElement>('use-stun'),
  create: element<HTMLButtonElement>('create-room'),
  createManual: element<HTMLButtonElement>('create-manual-room'),
  join: element<HTMLFormElement>('join-form'),
  invite: element<HTMLInputElement>('invite-input'),
  privateJoinError: element('private-join-error'),
  exchangeTitle: element('exchange-title'),
  instructions: element('exchange-instructions'),
  outgoingLabel: element('outgoing-label'),
  outgoing: element<HTMLTextAreaElement>('outgoing-code'),
  copy: element<HTMLButtonElement>('copy-code'),
  copyLink: element<HTMLButtonElement>('copy-link'),
  answerForm: element<HTMLFormElement>('answer-form'),
  answer: element<HTMLInputElement>('answer-input'),
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
      privateCode?: string;
      guest: Admission | null;
      awaitingAnswer: boolean;
    }
  | { role: 'guest'; roomId: string; host: Admission; privateRoom?: boolean };

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
let opponentNickname: string | null = null;
let checkingNickname = false;
let sharedInvite = new URLSearchParams(location.hash.slice(1)).get('invite');
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
let rematchReady = { local: false, opponent: false, sendFailed: false };
let remoteInput: Readonly<Input> = EMPTY_INPUT;
let remoteJump = false;
let remoteAttack = false;
let localJump = false;
let localAttack = false;
let sentInput = '';
let predictedGuestX: number | null = null;
const keys = new Set<string>();
const touchActions = new Map<number, { cluster: Element; button: HTMLButtonElement | null }>();
let ownsMatchFullscreen = false;

const stakes = new Stakes({
  send: (packet) => peer?.send(packet) ?? false,
  startRound: (key) => nextRound(key),
  clearInput: clearLocalInputs,
  fighterNames,
});

type LockableOrientation = ScreenOrientation & { lock?: (orientation: 'landscape') => Promise<void> };

function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

function fighterNames(): readonly [string, string] {
  const own = nickname ?? 'Вы';
  const opponent = opponentNickname ?? 'Соперник';
  return (peer?.role ?? mode) === 'guest' ? [opponent, own] : [own, opponent];
}

function updateFighterNames(): void {
  const names = fighterNames();
  for (const slot of [0, 1] as const) {
    setText(ui.fighterName[slot], names[slot]);
    ui.fighterName[slot].title = names[slot];
    setText(ui.healthLabel[slot], `Здоровье · ${names[slot]} `);
  }
  const localFighter = mode === 'idle' ? null : nickname;
  ui.touch.setAttribute('aria-label', localFighter ? `Управление бойцом ${localFighter}` : 'Управление бойцом');
  setText(ui.mobileFighter, localFighter ? `Вы — ${localFighter}` : '');
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
  setText(ui.nicknameSubmit, nickname ? 'Сохранить' : sharedInvite ? 'Войти по приглашению' : 'Войти в лобби');
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
  updateFighterNames();
  ui.nicknameScreen.hidden = true;
  ui.header.hidden = false;
  ui.layout.hidden = false;
  stakes.setLobbyVisible(!ui.initial.hidden);
  directory?.setAvailable(true);
  renderPublicRooms();
  renderOnlinePlayers();
  if (editing) ui.editNickname.focus();
  if (sharedInvite) void joinSharedInvite();
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

function overlay(title: string, kicker: string, text: string): void {
  ui.overlay.hidden = title === '';
  setText(ui.title, title);
  setText(ui.kicker, kicker);
  setText(ui.arenaMessage, text);
  ui.kicker.hidden = kicker === '';
  ui.arenaMessage.hidden = text === '';
}

function clearLocalInputs(): void {
  keys.clear();
  for (const { button } of touchActions.values()) button?.classList.remove('is-pressed');
  touchActions.clear();
  localJump = false;
  localAttack = false;
  sendGuestInput();
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
  rematchReady = { local: false, opponent: false, sendFailed: false };
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
  localJump = false;
  localAttack = false;
  remoteJump = false;
  remoteAttack = false;
  snapshotTick = 0;
  match = { kind: 'frame', game: game.state, scores, round, countdown: countdownTicks, stakeKey };
  matchDirty = true;
  rematchReady = { local: false, opponent: false, sendFailed: false };
}

function startMatch(nextMode: PeerRole): void {
  resetMatch();
  mode = nextMode;
  ui.layout.scrollTop = 0;
  document.body.dataset.mobileMatch = 'true';
  document.body.dataset.mobileFighter = nextMode === 'guest' ? 'volt' : 'rust';
  ui.touch.hidden = false;
  updateFighterNames();
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
  if (!/^(?:https?|file):\/\//i.test(value)) return value;
  const { hash } = new URL(value);
  return new URLSearchParams(hash.slice(1)).get('invite') ?? value;
}

function inviteLink(code: string): string {
  const url = new URL(location.href);
  url.hash = new URLSearchParams({ invite: code }).toString();
  return url.href;
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
  const failedPrivateJoin = isError && !linkOpen && attempt?.role === 'guest' && attempt.privateRoom;
  publicAttempt = null;
  if (attempt?.role === 'host' && attempt.listed) directory?.withdraw(attempt.roomId);
  if (attempt && notifyPeer) {
    const admission = attempt.role === 'host' ? attempt.guest : attempt.host;
    if (admission) sendPublicNotice(admission, attempt.roomId, attempt.role === 'host' ? 'reject' : 'cancel');
  }
  const closing = peer;
  peer = null;
  opponentNickname = null;
  linkOpen = false;
  stakes.disconnect();
  if (notifyPeer && closing?.send({ kind: 'leave' })) {
    window.setTimeout(() => closing.close(), 250);
  } else {
    closing?.close();
  }
  resetMatch();
  updateFighterNames();
  ui.outgoing.value = '';
  ui.answer.value = '';
  ui.acceptAnswer.disabled = false;
  ui.leave.disabled = false;
  setLobby('initial');
  renderOnlinePlayers();
  connection(isError ? 'Связь прервана' : 'Нет соединения', isError ? 'error' : 'idle');
  if (failedPrivateJoin) {
    message('');
    showPrivateJoinError(note);
  } else {
    message(note, isError);
  }
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
    message(opponentNickname ? `Соперник · ${opponentNickname}` : '');
    if (mode !== session.role) startMatch(session.role);
    if (nickname) session.send({ kind: 'player-profile', nickname });
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
    if (
      !linkOpen &&
      mode === 'idle' &&
      publicAttempt?.role === 'host' &&
      (publicAttempt.listed || publicAttempt.privateCode)
    ) {
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

  if (packet.kind === 'player-profile' && typeof packet.nickname === 'string') {
    const name = normalizeNickname(packet.nickname);
    if (name) {
      opponentNickname = name;
      if (linkOpen) message(`Соперник · ${name}`);
      updateFighterNames();
    }
    return;
  }

  if (packet.kind === 'rematch-ready') {
    if (match && packet.round === match.round && (session.role === 'guest' || match.game.winner !== null)) {
      rematchReady.opponent = true;
    }
    return;
  }

  if (stakes.receive(packet)) return;
  if (session.role === 'host') {
    if (packet.kind === 'input' && isInput(packet.input)) {
      remoteJump ||= packet.jumpPressed === true || (packet.input.jump && !remoteInput.jump);
      remoteAttack ||= packet.attackPressed === true || (packet.input.attack && !remoteInput.attack);
      remoteInput = packet.input;
    }
  } else if (isFrame(packet) && (!match || packet.round >= match.round)) {
    if (packet.stakeKey && !stakes.canPlay(packet.stakeKey)) return;
    if (packet.round !== match?.round) {
      if (match && !packet.stakeKey && !(rematchReady.local && rematchReady.opponent)) {
        return;
      }
      localJump = false;
      localAttack = false;
      predictedGuestX = null;
      rematchReady = { local: false, opponent: false, sendFailed: false };
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
  ui.create.disabled = !canPlay;
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
      } else if (publicAttempt?.role === 'host' && publicAttempt.privateCode && !publicAttempt.guest) {
        showPrivateWait(publicAttempt.privateCode);
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
  ui.privateShare.hidden = true;
  connection('Общее лобби', 'pending');
  message('');
}

function showPrivateWait(code: string): void {
  const online = directoryState === 'online';
  const asLink = canShareLink();
  const invitation = asLink ? inviteLink(code) : code;
  setText(ui.publicWaitTitle, 'Закрытая комната');
  setText(
    ui.publicWaitMessage,
    online
      ? `Отправьте ${asLink ? 'ссылку' : 'код'} другу. Игра начнётся, когда он подключится.`
      : 'Восстанавливаем связь с лобби…',
  );
  setText(ui.privateShareLabel, asLink ? 'Ссылка для друга' : 'Код для друга');
  setText(ui.privateShareCopy, asLink ? 'Скопировать ссылку' : 'Скопировать код');
  ui.privateShareValue.value = invitation;
  ui.privateShareTelegram.hidden = !asLink || !online;
  if (ui.privateShareTelegram.hidden) {
    ui.privateShareTelegram.removeAttribute('href');
  } else {
    const telegram = new URL('https://t.me/share/url');
    telegram.searchParams.set('url', invitation);
    telegram.searchParams.set('text', 'Сыграем в LOW GAME?');
    ui.privateShareTelegram.href = telegram.href;
  }
  ui.privateShare.hidden = false;
  ui.publicWaitRoomId.hidden = true;
  ui.privateShareCopy.disabled = !online;
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

function createPrivateRoom(): void {
  if (!nickname || peer || publicAttempt || challenge) return;
  const host = directory?.identity;
  if (!host || !directory?.hasNickname) {
    message('Ждём подключения к лобби. Попробуйте ещё раз.', true);
    return;
  }
  const roomId = createRoomId();
  const code = privateInviteCode(roomId, host);
  openPublicWait(
    { role: 'host', roomId, nickname, listed: false, privateCode: code, guest: null, awaitingAnswer: false },
    'Закрытая комната',
    '',
  );
  showPrivateWait(code);
  ui.privateShareCopy.focus();
}

async function joinPublicRoom(room: PublicRoom, privateRoom = false): Promise<void> {
  if (!nickname || peer || publicAttempt || challenge) return;
  if (!directory?.hasNickname) {
    if (privateRoom) showPrivateJoinError('Ждём подключения к лобби. Попробуйте ещё раз.');
    return;
  }
  if (directory.identity && sameIdentity(directory.identity, room.host)) {
    if (privateRoom) showPrivateJoinError('Это ваше приглашение. Отправьте его другу.');
    return;
  }
  const requestId = createRoomId();
  const attempt: PublicAttempt = {
    role: 'guest',
    roomId: room.id,
    host: { identity: room.host, requestId },
    privateRoom,
  };
  openPublicWait(
    attempt,
    privateRoom ? 'Входим в закрытую комнату' : 'Подключаемся',
    privateRoom ? 'Связываемся с создателем комнаты…' : 'Ждём ответа создателя комнаты.',
  );
  if (privateRoom) ui.publicWaitRoomId.hidden = true;
  publicTimer = window.setTimeout(
    () => {
      if (publicAttempt !== attempt || linkOpen) return;
      closeRoom(
        privateRoom
          ? 'Комната не ответила. Убедитесь, что друг оставил её открытой, и попробуйте снова.'
          : 'Комната не ответила. Выберите другую или попробуйте ещё раз.',
        true,
        true,
      );
    },
    privateRoom ? 14_000 : 42_000,
  );
  try {
    await directory.send(room.host, { kind: privateRoom ? 'private-request' : 'request', roomId: room.id, requestId });
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
  if (attempt.privateCode) {
    showPrivateWait(attempt.privateCode);
    connection('Ждём соперника', 'pending');
    message(note, note !== '');
    return;
  }
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
  ui.privateShare.hidden = true;
  setText(ui.publicWaitTitle, 'Соперник найден');
  setText(ui.publicWaitMessage, 'Устанавливаем прямое соединение…');
  message('');
  publicTimer = window.setTimeout(() => {
    if (publicAttempt !== attempt || attempt.guest !== admission) return;
    if (attempt.listed || attempt.privateCode)
      void reopenPublicRoom(attempt, 'Подключение заняло слишком много времени.');
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
    if (attempt.listed || attempt.privateCode) await reopenPublicRoom(attempt, errorText(error));
    else closeRoom(errorText(error), true, true);
  }
}

async function receivePublicSignal(sender: RoomIdentity, signal: DirectorySignal): Promise<void> {
  const attempt = publicAttempt;
  if (
    signal.kind === 'private-request' &&
    (attempt?.role !== 'host' || !attempt.privateCode || signal.roomId !== attempt.roomId)
  ) {
    sendPublicNotice({ identity: sender, requestId: signal.requestId }, signal.roomId, 'reject');
    return;
  }
  if (!attempt || signal.roomId !== attempt.roomId) return;
  const requestsRoom = signal.kind === 'request' || signal.kind === 'private-request';
  if (mode !== 'idle') {
    const opponent = opponentInRoom(attempt);
    if (attempt.role === 'host' && requestsRoom) {
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
  if (attempt.role === 'host' && requestsRoom) {
    if (signal.kind === 'request' && !attempt.listed) return;
    await admitPublicGuest(attempt, { identity: sender, requestId: signal.requestId });
    return;
  }

  const admission = attempt.role === 'host' ? attempt.guest : attempt.host;
  if (!admission || !sameIdentity(sender, admission.identity) || signal.requestId !== admission.requestId) return;

  try {
    if (attempt.role === 'host') {
      if (signal.kind === 'cancel') {
        if (attempt.listed || attempt.privateCode) await reopenPublicRoom(attempt, '');
        else closeRoom('Соперник отменил подключение.');
      } else if (signal.kind === 'answer' && peer && attempt.awaitingAnswer) {
        attempt.awaitingAnswer = false;
        await peer.acceptAnswer(signal.code);
      }
    } else if (signal.kind === 'reject') {
      closeRoom(
        attempt.privateRoom
          ? 'Комната закрыта или занята. Попросите друга прислать новое приглашение.'
          : 'Соперник закрыл комнату или отменил подключение.',
        true,
      );
    } else if (signal.kind === 'invite' && !peer && directory) {
      if (readInviteRoomId(signal.code) !== attempt.roomId) throw new Error('Приглашение относится к другой комнате.');
      if (attempt.privateRoom) {
        window.clearTimeout(publicTimer);
        publicTimer = window.setTimeout(() => {
          if (publicAttempt === attempt && !linkOpen) closeRoom('Прямое подключение не удалось.', true, true);
        }, 30_000);
      }
      const session = attachPeer('guest', true);
      setText(ui.publicWaitMessage, 'Устанавливаем прямое соединение…');
      const code = await session.acceptInvite(signal.code);
      if (publicAttempt !== attempt || session !== peer) return;
      await directory.send(sender, { kind: 'answer', roomId: signal.roomId, requestId: signal.requestId, code });
    }
  } catch (error) {
    if (publicAttempt !== attempt) return;
    if (attempt.role === 'host' && attempt.guest === admission && (attempt.listed || attempt.privateCode)) {
      await reopenPublicRoom(attempt, errorText(error));
    } else {
      closeRoom(errorText(error), true, true);
    }
  }
}

async function joinInvite(text: string): Promise<void> {
  clearPrivateJoinError();
  message('');
  try {
    const code = inviteFrom(text);
    const room = readPrivateInvite(code);
    if (room) {
      await joinPublicRoom(room, true);
    } else {
      readInviteRoomId(code);
      await openManualRoom('guest', code);
    }
  } catch (error) {
    showPrivateJoinError(errorText(error));
  }
}

function showPrivateJoinError(text: string): void {
  ui.manualConnection.open = true;
  setText(ui.privateJoinError, text);
  ui.invite.setAttribute('aria-invalid', 'true');
  ui.invite.focus();
}

function clearPrivateJoinError(): void {
  setText(ui.privateJoinError, '');
  ui.invite.removeAttribute('aria-invalid');
}

async function joinSharedInvite(): Promise<void> {
  const code = sharedInvite;
  if (!code || !nickname || checkingNickname || ui.layout.hidden) return;
  sharedInvite = null;
  const url = new URL(location.href);
  const params = new URLSearchParams(url.hash.slice(1));
  params.delete('invite');
  url.hash = params.toString();
  if (location.protocol !== 'file:') history.replaceState(history.state, '', url);
  ui.manualConnection.open = true;
  ui.invite.value = code;
  if (peer || publicAttempt || challenge) {
    message('Покиньте текущую комнату, чтобы войти по новому приглашению.');
    return;
  }
  await joinInvite(code);
}

async function openManualRoom(role: PeerRole, invite = ''): Promise<void> {
  if (!nickname || peer || publicAttempt || challenge) return;
  if (!directory?.hasNickname) {
    message('Ждём подключения к общему лобби для проверки никнейма.', true);
    return;
  }
  let session: PeerSession | undefined;
  try {
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
  const value = ui.outgoing.value;
  if (value) await copyInvite(asLink ? inviteLink(value) : value, ui.outgoing, asLink);
}

async function copyInvite(
  value: string,
  field: HTMLInputElement | HTMLTextAreaElement,
  asLink: boolean,
): Promise<void> {
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
      field.focus();
      field.select();
      message(asLink ? 'Скопируйте выделенную ссылку вручную.' : 'Скопируйте выделенный код вручную.');
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
  for (const { button } of touchActions.values()) {
    if (button) input[button.dataset.action as keyof Input] = true;
  }
  return input;
}

function inputPressed(action: keyof Input): void {
  if (!match || match.countdown > 0 || match.game.winner !== null) return;
  if (action === 'jump') localJump = true;
  if (action === 'attack') localAttack = true;
}

function sendGuestInput(): void {
  if (mode !== 'guest' || !linkOpen) return;
  const input = keyInput();
  const signature = JSON.stringify(input);
  if (signature === sentInput && !localJump && !localAttack) return;
  if (
    peer?.send({ kind: 'input', input, jumpPressed: localJump || undefined, attackPressed: localAttack || undefined })
  ) {
    sentInput = signature;
    localJump = false;
    localAttack = false;
  }
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
  if (keys.has(event.code)) return;
  inputPressed(keyboardActions[event.code as keyof typeof keyboardActions]);
  keys.add(event.code);
  sendGuestInput();
}

function simulate(): void {
  if (mode === 'idle' || !linkOpen) return;
  if (mode === 'guest') {
    sendGuestInput();
    return;
  }
  if (!match) return;

  if (match.game.winner !== null && rematchReady.local && rematchReady.opponent && !stakes.hasMatch) {
    nextRound();
    return;
  }

  if (match.countdown > 0) {
    match.countdown -= 1;
    remoteJump = false;
    remoteAttack = false;
    matchDirty = true;
  } else if (match.game.winner === null) {
    const first = { ...keyInput(), jumpPressed: localJump, attackPressed: localAttack };
    const second = {
      ...remoteInput,
      jumpPressed: remoteJump,
      attackPressed: remoteAttack,
    };
    game.step([first, second]);
    localJump = false;
    localAttack = false;
    remoteJump = false;
    remoteAttack = false;
    if (match.game.winner === 0 || match.game.winner === 1) match.scores[match.game.winner] += 1;
    if (match.stakeKey && match.game.winner !== null) stakes.recordResult(match.stakeKey, match.game.winner);
    matchDirty = true;
  }
  snapshotTick += 1;
  if (matchDirty && (match.countdown === 0 || snapshotTick % 2 === 0) && peer?.send(match, 2_048)) {
    matchDirty = false;
  }
}

function renderGame(elapsed: number): GameState {
  const state = match?.game ?? game.state;
  const [host, guest] = state.fighters;
  if (mode !== 'guest' || !linkOpen || !match || match.countdown > 0 || state.winner !== null) {
    predictedGuestX = null;
    return state;
  }
  if (guest.hitTicks || guest.blockHitTicks || guest.attackTicks || guest.blocking) {
    predictedGuestX = guest.x;
    return state;
  }

  const input = keyInput();
  const previousX = predictedGuestX ?? guest.x;
  const ticks = elapsed / tickMs;
  const moving = !input.block && input.left !== input.right;
  const x = moving
    ? predictWalk(guest, host, previousX, input, ticks)
    : previousX + (guest.x - previousX) * Math.min(1, elapsed / 30);
  predictedGuestX = x;
  return { ...state, fighters: [host, { ...guest, x, moving: moving && x !== previousX }] };
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

  const roundEnded = Boolean(match && state.winner !== null);
  ui.roundActions.hidden = mode === 'idle' || (!roundEnded && linkOpen);
  ui.rematch.hidden = !roundEnded || !linkOpen || stakes.hasMatch;
  ui.rematch.disabled = rematchReady.local;
  setText(ui.rematch, rematchReady.opponent && !rematchReady.local ? 'Принять реванш' : 'Реванш');

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
    const winner = state.winner === 'draw' ? 'Ничья' : `Победа · ${fighterNames()[state.winner]}`;
    let detail = seconds === 0 ? 'Время вышло' : 'Нокаут';
    if (stakes.hasMatch) detail = 'Реванш доступен после расчёта ставки.';
    else if (rematchReady.sendFailed) detail = 'Не удалось отправить. Нажмите ещё раз.';
    else if (rematchReady.local) {
      detail = rematchReady.opponent ? 'Начинаем реванш…' : 'Ждём подтверждения соперника…';
    } else if (rematchReady.opponent) detail = 'Соперник предлагает реванш.';
    overlay(winner, `РАУНД ${match.round} ЗАВЕРШЁН`, detail);
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
ui.create.addEventListener('click', createPrivateRoom);
ui.createManual.addEventListener('click', () => {
  void openManualRoom('host');
});
ui.join.addEventListener('submit', (event) => {
  event.preventDefault();
  void joinInvite(ui.invite.value);
});
ui.invite.addEventListener('input', clearPrivateJoinError);
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
ui.privateShareCopy.addEventListener('click', () => {
  void copyInvite(ui.privateShareValue.value, ui.privateShareValue, canShareLink());
});
for (const button of [ui.leave, ui.mobileLeave, ui.roundLobby]) {
  button.addEventListener('click', () => closeRoom('', false, true));
}
ui.mobileFullscreen.hidden =
  !document.fullscreenEnabled || typeof document.documentElement.requestFullscreen !== 'function';
ui.mobileFullscreen.addEventListener('click', () => {
  void toggleMatchFullscreen();
});
document.addEventListener('fullscreenchange', updateFullscreenButton);
ui.rematch.addEventListener('click', () => {
  if (!linkOpen || !match || match.game.winner === null || stakes.hasMatch || rematchReady.local) return;
  rematchReady.local = peer?.send({ kind: 'rematch-ready', round: match.round }) ?? false;
  rematchReady.sendFailed = !rematchReady.local;
});

document.addEventListener('keydown', pressKey);
document.addEventListener('keyup', (event) => {
  if (keys.delete(event.code)) sendGuestInput();
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
window.addEventListener('hashchange', () => {
  sharedInvite = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (nickname) {
    void joinSharedInvite();
  } else {
    setText(ui.nicknameSubmit, sharedInvite ? 'Войти по приглашению' : 'Войти в лобби');
  }
});

function touchButton(node: Element | null): HTMLButtonElement | null {
  return node?.closest<HTMLButtonElement>('button[data-action]') ?? null;
}

function updateTouch(
  pointer: { cluster: Element; button: HTMLButtonElement | null },
  button: HTMLButtonElement | null,
): void {
  const previous = pointer.button;
  if (previous === button) return;
  const wasHeld = Array.from(touchActions.values()).some((touch) => touch.button === button);
  pointer.button = button;
  if (previous && !Array.from(touchActions.values()).some((touch) => touch.button === previous)) {
    previous.classList.remove('is-pressed');
  }
  if (button) {
    button.classList.add('is-pressed');
    if (!wasHeld) inputPressed(button.dataset.action as keyof Input);
  }
  sendGuestInput();
}

ui.touch.addEventListener('pointerdown', (event) => {
  if (!linkOpen || stakes.isOpen || event.button !== 0 || !(event.target instanceof Element)) return;
  const button = touchButton(event.target);
  const cluster = button?.closest('.touch-cluster');
  if (!button || !cluster) return;
  event.preventDefault();
  button.setPointerCapture(event.pointerId);
  const pointer = { cluster, button: null };
  touchActions.set(event.pointerId, pointer);
  updateTouch(pointer, button);
});

ui.touch.addEventListener('pointermove', (event) => {
  const pointer = touchActions.get(event.pointerId);
  if (!pointer) return;
  const button = touchButton(document.elementFromPoint(event.clientX, event.clientY));
  updateTouch(pointer, pointer.cluster.contains(button) ? button : null);
});

function releaseTouch(event: PointerEvent): void {
  const pointer = touchActions.get(event.pointerId);
  if (!pointer) return;
  updateTouch(pointer, null);
  touchActions.delete(event.pointerId);
}

ui.touch.addEventListener('pointerup', releaseTouch);
ui.touch.addEventListener('pointercancel', releaseTouch);
ui.touch.addEventListener('lostpointercapture', releaseTouch);
ui.touch.addEventListener('contextmenu', (event) => {
  if (event.target instanceof Element && touchButton(event.target)) event.preventDefault();
});

if (sharedInvite) {
  setText(ui.nicknameSubmit, 'Войти по приглашению');
}
const previousNickname = storedNickname();
if (previousNickname) {
  ui.nicknameInput.value = previousNickname;
  void claimNickname(previousNickname);
}

let lastTime = performance.now();
let accumulated = 0;
function animate(time: number): void {
  const elapsed = Math.min(100, Math.max(0, time - lastTime));
  accumulated += elapsed;
  lastTime = time;
  while (accumulated >= tickMs) {
    simulate();
    accumulated -= tickMs;
  }
  if (!ui.layout.hidden) {
    renderer.draw(renderGame(elapsed), time);
    updateScreen();
  }
  requestAnimationFrame(animate);
}

requestAnimationFrame(animate);
