import type { Address, Hex, StakeMatch, StakeOutcome } from './stake-wallet';
import { createStakeWallet, formatStake, getAddress, parseStake } from './stake-wallet';

type Role = 'host' | 'guest';
type StakeRecord = { key: Hex; account: Address; role: Role };
type Session = {
  id: string;
  role: Role;
  opponent: Address | null;
  opponentReady: boolean;
  record: StakeRecord | null;
  match: StakeMatch | null;
  roundStarted: boolean;
  result: StakeOutcome | null;
};

type Options = {
  send: (packet: unknown) => boolean;
  startRound: (key: Hex) => void;
  clearInput: () => void;
};

const hexKey = /^0x[\da-f]{64}$/i;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const embeddedFaucetUrl = 'https://openfaucet.org/base-sepolia';

function find<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Элемент ставки отсутствует: ${id}`);
  return node as T;
}

export class Stakes {
  private readonly wallet = createStakeWallet();
  private readonly panel = find('stake-panel');
  private readonly title = find('stake-title');
  private readonly note = find('stake-note');
  private readonly terms = find('stake-terms');
  private readonly walletBalance = find('stake-wallet-balance');
  private readonly lobbyBalance = find('lobby-wallet-balance');
  private readonly lobbyConnect = find<HTMLButtonElement>('lobby-wallet-connect');
  private readonly lobbyTopUp = find<HTMLButtonElement>('lobby-wallet-topup');
  private readonly lobbyFeedback = find('lobby-wallet-feedback');
  private readonly faucetPanel = find<HTMLDialogElement>('base-faucet-panel');
  private readonly faucetFrame = find<HTMLIFrameElement>('base-faucet-frame');
  private readonly faucetAddress = find('base-faucet-address');
  private readonly faucetCopy = find<HTMLButtonElement>('base-faucet-copy');
  private readonly faucetCopyStatus = find('base-faucet-copy-status');
  private readonly withdrawableBalance = find('stake-withdrawable-balance');
  private readonly amountField = find('stake-amount-field');
  private readonly amount = find<HTMLInputElement>('stake-amount');
  private readonly resultField = find('stake-result-field');
  private readonly result = find<HTMLSelectElement>('stake-result');
  private readonly close = find<HTMLButtonElement>('stake-close');
  private readonly primary = find<HTMLButtonElement>('stake-primary');
  private readonly secondary = find<HTMLButtonElement>('stake-secondary');
  private readonly recovery = find<HTMLButtonElement>('stake-recovery-open');
  private readonly triggers = [find<HTMLButtonElement>('stake-open'), find<HTMLButtonElement>('stake-mobile-open')];
  private session: Session | null = null;
  private account: Address | null = null;
  private viewed: StakeRecord | null = null;
  private busy = false;
  private trigger: HTMLElement | null = null;
  private error = '';
  private readonly storageKey: string;
  private refreshVersion = 0;
  private watchingWallet = false;
  private lobbyVisible = false;

  constructor(private readonly options: Options) {
    this.storageKey = `low-game.stakes.${this.wallet.chainId}.${this.wallet.address?.toLowerCase() ?? 'unconfigured'}`;
    for (const trigger of this.triggers)
      trigger.addEventListener('click', () => this.open(trigger, this.session?.record ?? null));
    this.recovery.addEventListener('click', () => this.open(this.recovery, this.saved().at(-1) ?? null));
    this.close.addEventListener('click', () => this.hide());
    this.lobbyConnect.addEventListener('click', () => {
      void this.connectFromLobby();
    });
    this.lobbyTopUp.addEventListener('click', () => {
      if (this.wallet.usesEmbeddedFaucet) this.openEmbeddedFaucet();
      else void this.topUpFromLobby();
    });
    if (this.wallet.usesEmbeddedFaucet) this.lobbyTopUp.setAttribute('aria-haspopup', 'dialog');
    this.faucetCopy.addEventListener('click', () => {
      void this.copyFaucetAddress();
    });
    this.faucetPanel.addEventListener('close', () => {
      if (this.faucetPanel.open) return;
      this.faucetFrame.removeAttribute('src');
      this.faucetAddress.textContent = '';
      this.faucetCopyStatus.textContent = '';
      void this.refresh();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.isOpen) this.hide();
      if (event.key !== 'Tab' || !this.isOpen) return;
      const items = Array.from(this.panel.querySelectorAll<HTMLElement>('button:not(:disabled), input, select')).filter(
        (node) => node.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    window.setInterval(() => {
      if (this.lobbyVisible || this.session?.record || this.isOpen) void this.refresh();
    }, 2_500);
    this.recovery.hidden = false;
  }

  get isOpen(): boolean {
    return !this.panel.hidden;
  }
  get hasMatch(): boolean {
    return Boolean(this.session?.record && (this.session.match?.outcome ?? 0) === 0);
  }

  setLobbyVisible(visible: boolean): void {
    if (this.lobbyVisible === visible) return;
    this.lobbyVisible = visible;
    if (visible) void this.refresh();
    else this.faucetPanel.close();
  }

  connect(id: string, role: Role): void {
    if (!this.wallet.address) return;
    if (this.session?.id === id) return;
    this.session = {
      id,
      role,
      opponent: null,
      opponentReady: false,
      record: null,
      match: null,
      roundStarted: false,
      result: null,
    };
    for (const trigger of this.triggers) trigger.hidden = false;
    if (this.account) this.sendWallet();
  }

  disconnect(): void {
    this.session = null;
    for (const trigger of this.triggers) trigger.hidden = true;
    this.hide();
  }

  canPlay(key: Hex): boolean {
    const session = this.session;
    if (!session?.record || session.record.key !== key) return false;
    if (session.roundStarted) return true;
    if (!session.match?.funded || session.match.outcome !== 0) return false;
    session.roundStarted = true;
    this.hide();
    return true;
  }

  recordResult(key: Hex, winner: 0 | 1 | 'draw'): void {
    const session = this.session;
    if (!session?.record || session.record.key !== key || session.result !== null) return;
    session.roundStarted = true;
    session.result = winner === 'draw' ? 3 : winner === 0 ? 1 : 2;
    if (this.isOpen) void this.refresh();
    else this.open(null, session.record);
  }

  receive(packet: Record<string, unknown>): boolean {
    if (
      packet.kind !== 'stake-wallet' &&
      packet.kind !== 'stake-offer' &&
      packet.kind !== 'stake-update' &&
      packet.kind !== 'stake-ready'
    )
      return false;
    const session = this.session;
    if (
      !this.wallet.address ||
      !session ||
      packet.room !== session.id ||
      packet.chainId !== this.wallet.chainId ||
      typeof packet.contract !== 'string' ||
      !sameAddress(packet.contract, this.wallet.address)
    )
      return true;
    if (packet.kind === 'stake-wallet' && typeof packet.account === 'string') {
      try {
        const previous = session.opponent;
        session.opponent = getAddress(packet.account);
        if (this.account && !previous) this.sendWallet();
        if (session.role === 'host' && session.record) this.send('stake-offer', { key: session.record.key });
      } catch {
        return true;
      }
    }
    if (
      packet.kind === 'stake-offer' &&
      session.role === 'guest' &&
      this.account &&
      !session.record &&
      typeof packet.key === 'string' &&
      hexKey.test(packet.key)
    ) {
      void this.loadOffer(session, packet.key as Hex, this.account);
    }
    if (packet.kind === 'stake-ready' && session.role === 'host' && session.record?.key === packet.key) {
      session.opponentReady = true;
    }
    void this.refresh();
    return true;
  }

  private sendWallet(): void {
    if (this.account) this.send('stake-wallet', { account: this.account });
  }

  private send(kind: string, details: Record<string, unknown> = {}): void {
    if (!this.wallet.address || !this.session) return;
    this.options.send({
      kind,
      room: this.session.id,
      chainId: this.wallet.chainId,
      contract: this.wallet.address,
      ...details,
    });
  }

  private async loadOffer(session: Session, key: Hex, account: Address): Promise<void> {
    try {
      const wallet = this.wallet;
      if (!session.opponent || wallet.key(session.id, session.opponent) !== key) return;
      const match = await wallet.status(key);
      if (
        session !== this.session ||
        session.record ||
        !session.opponent ||
        !sameAddress(match.creator, session.opponent) ||
        !sameAddress(match.opponent, account) ||
        match.stake === 0n ||
        match.outcome !== 0
      )
        return;
      const record: StakeRecord = { key, account, role: 'guest' };
      this.save(record);
      session.record = record;
      session.match = match;
      this.open(null, record);
    } catch {
      // An unverifiable invitation must never trigger a wallet transaction.
    }
  }

  private saved(): StakeRecord[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.storageKey) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry) =>
          entry &&
          typeof entry.key === 'string' &&
          hexKey.test(entry.key) &&
          typeof entry.account === 'string' &&
          /^0x[\da-f]{40}$/i.test(entry.account) &&
          (entry.role === 'host' || entry.role === 'guest'),
      );
    } catch {
      return [];
    }
  }

  private save(record: StakeRecord): void {
    const previous = this.saved().filter(({ key }) => key !== record.key);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify([...previous, record]));
    } catch {
      throw new Error('Не удалось сохранить данные для возврата ставки. Разрешите хранилище браузера.');
    }
  }

  private open(trigger: HTMLElement | null, record: StakeRecord | null): void {
    if (!this.isOpen)
      this.trigger = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (this.viewed?.key !== record?.key) delete this.result.dataset.selection;
    this.viewed = record;
    this.error = '';
    this.options.clearInput();
    this.showBalances(null, null);
    this.panel.hidden = false;
    for (const id of ['game-header', 'game-layout', 'nickname-screen']) find(id).inert = true;
    this.close.focus();
    void this.refresh();
  }

  private hide(): void {
    if (!this.isOpen) return;
    this.panel.hidden = true;
    for (const id of ['game-header', 'game-layout', 'nickname-screen']) find(id).inert = false;
    this.trigger?.focus();
    this.trigger = null;
  }

  private action(button: HTMLButtonElement, label: string, run?: () => Promise<void>): void {
    button.hidden = !label;
    button.textContent = label;
    button.disabled = this.busy;
    button.onclick = run
      ? () => {
          void this.run(run);
        }
      : null;
  }

  private async run(run: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refreshVersion += 1;
    this.error = '';
    this.primary.disabled = true;
    this.secondary.disabled = true;
    this.note.dataset.state = '';
    this.note.textContent = 'Ждём подтверждения кошелька или сети…';
    try {
      await run();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Транзакция не подтверждена.';
    } finally {
      this.busy = false;
      void this.refresh();
    }
  }

  private showBalances(balance: bigint | null, credit: bigint | null): void {
    const wallet = balance === null ? '—' : `${formatStake(balance)} ETH`;
    const withdrawable = credit === null ? '—' : `${formatStake(credit)} ETH`;
    if (this.walletBalance.textContent !== wallet) this.walletBalance.textContent = wallet;
    if (this.withdrawableBalance.textContent !== withdrawable) this.withdrawableBalance.textContent = withdrawable;
  }

  private showLobbyBalance(balance: bigint | null): void {
    const value = balance === null ? '—' : `${formatStake(balance)} ETH`;
    if (this.lobbyBalance.textContent !== value) this.lobbyBalance.textContent = value;
    this.lobbyBalance.title = balance === null ? this.wallet.chainName : `${value} · ${this.wallet.chainName}`;
    this.lobbyConnect.hidden = this.account !== null;
    this.lobbyTopUp.hidden = this.account === null;
  }

  private async connectFromLobby(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refreshVersion += 1;
    this.lobbyConnect.disabled = true;
    this.lobbyMessage('');
    try {
      await this.connectWallet();
    } catch (error) {
      this.lobbyMessage(error instanceof Error ? error.message : 'Не удалось подключить кошелёк.', true);
    } finally {
      this.busy = false;
      this.lobbyConnect.disabled = false;
      void this.refresh();
    }
  }

  private lobbyMessage(message: string, error = false): void {
    this.lobbyFeedback.textContent = message;
    this.lobbyFeedback.dataset.state = error ? 'error' : '';
    this.lobbyFeedback.hidden = !message;
  }

  private openEmbeddedFaucet(): void {
    if (!this.account || this.busy || this.faucetPanel.open) return;
    this.faucetAddress.textContent = this.account;
    this.faucetCopyStatus.textContent = '';
    this.faucetPanel.showModal();
    this.faucetFrame.src = embeddedFaucetUrl;
  }

  private async copyFaucetAddress(): Promise<void> {
    const address = this.faucetAddress.textContent;
    if (!address || !this.faucetPanel.open) return;
    let message = 'Адрес скопирован.';
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      message = 'Выделите адрес и скопируйте его вручную.';
    }
    if (this.faucetPanel.open && this.faucetAddress.textContent === address) {
      this.faucetCopyStatus.textContent = message;
    }
  }

  private async topUpFromLobby(): Promise<void> {
    const account = this.account;
    if (!account || this.busy || this.lobbyTopUp.disabled) return;
    const local = this.wallet.usesLocalNetwork;
    this.lobbyTopUp.disabled = true;
    this.lobbyMessage(local ? 'Запрашиваем 1 тестовый ETH…' : 'Запрашиваем тестовые ETH в Base Sepolia…');
    const isCurrentAccount = () => this.account !== null && sameAddress(this.account, account);
    try {
      const hash = await this.wallet.requestTestFunds(account);
      if (local) {
        if (isCurrentAccount()) this.lobbyMessage('Кошелёк пополнен на 1 тестовый ETH.');
        return;
      }
      if (isCurrentAccount()) this.lobbyMessage('Перевод отправлен. Ждём подтверждения Base Sepolia…');
      const confirmed = await this.wallet.confirmBaseFunds(hash);
      if (!isCurrentAccount()) return;
      if (confirmed === true) this.lobbyMessage('Тестовые ETH зачислены.');
      else if (confirmed === false) this.lobbyMessage('Base Sepolia отклонила перевод. Попробуйте позже.', true);
      else this.lobbyMessage('Перевод отправлен. Подтверждение задерживается. Баланс обновится автоматически.');
    } catch (error) {
      if (isCurrentAccount()) {
        this.lobbyMessage(error instanceof Error ? error.message : 'Не удалось пополнить кошелёк.', true);
      }
    } finally {
      this.lobbyTopUp.disabled = false;
      void this.refresh();
    }
  }

  private async connectWallet(): Promise<void> {
    this.account = await this.wallet.connect();
    this.watchWallet();
    this.sendWallet();
  }

  private watchWallet(): void {
    if (this.watchingWallet) return;
    this.watchingWallet = true;
    this.wallet.watchContext(() => {
      this.refreshVersion += 1;
      this.account = null;
      this.faucetPanel.close();
      this.showBalances(null, null);
      this.showLobbyBalance(null);
      this.lobbyMessage('');
      this.primary.hidden = true;
      this.secondary.hidden = true;
      if (this.isOpen || this.lobbyVisible) void this.refresh();
    });
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    const wallet = this.wallet;
    const version = ++this.refreshVersion;
    const session = this.session;
    const viewed = this.viewed;
    const visible = this.isOpen;
    const lobbyVisible = this.lobbyVisible;
    const readBalance = visible || lobbyVisible;
    const record = visible ? (viewed ?? session?.record ?? null) : (session?.record ?? null);
    const isCurrent = () =>
      version === this.refreshVersion &&
      session === this.session &&
      !this.busy &&
      visible === this.isOpen &&
      lobbyVisible === this.lobbyVisible &&
      viewed === this.viewed;
    let status: StakeMatch | null = null;
    let balance: bigint | null = null;
    let credit: bigint | null = null;
    let time = 0n;
    let readError = '';

    try {
      const account = readBalance ? await wallet.account() : this.account;
      if (!isCurrent()) return;
      const previous = this.account;
      this.account = account;
      if (account) {
        this.watchWallet();
        if (!previous || !sameAddress(account, previous)) {
          this.showBalances(null, null);
          if (lobbyVisible) this.showLobbyBalance(null);
          this.sendWallet();
        }
        const [walletRead, creditRead, matchRead] = await Promise.allSettled([
          readBalance ? wallet.balance(account) : null,
          visible && wallet.address ? wallet.credits(account) : null,
          record && sameAddress(account, record.account)
            ? Promise.all([wallet.status(record.key), wallet.time()])
            : null,
        ]);
        if (!isCurrent()) return;
        if (walletRead.status === 'fulfilled') balance = walletRead.value;
        if (creditRead.status === 'fulfilled') credit = creditRead.value;
        if (matchRead.status === 'fulfilled' && matchRead.value) {
          [status, time] = matchRead.value;
          if (status.stake === 0n) status = null;
        }
        const failure = [walletRead, creditRead, matchRead].find((result) => result.status === 'rejected');
        if (failure)
          readError = failure.reason instanceof Error ? failure.reason.message : 'Не удалось обновить баланс.';
      }
    } catch (error) {
      if (!isCurrent()) return;
      this.account = null;
      readError = error instanceof Error ? error.message : 'Не удалось обновить баланс.';
    }

    if (!isCurrent()) return;
    if (session && record && session.record?.key === record.key && status) {
      session.match = status;
      if (session.role === 'guest' && status.funded && status.outcome === 0 && !session.roundStarted) {
        this.send('stake-ready', { key: record.key });
      }
      if (
        session.role === 'host' &&
        session.opponentReady &&
        status.funded &&
        status.outcome === 0 &&
        !session.roundStarted &&
        time + 75n < status.settlementDeadline
      ) {
        session.roundStarted = true;
        this.hide();
        this.options.startRound(record.key);
      }
    }
    if (lobbyVisible) this.showLobbyBalance(balance);
    if (!this.isOpen) return;
    this.showBalances(balance, credit);
    this.render(record, status, time, credit, readError);
  }

  private render(
    record: StakeRecord | null,
    status: StakeMatch | null,
    time: bigint,
    credit: bigint | null,
    readError: string,
  ): void {
    const wallet = this.wallet;
    const session = this.session;
    const live = record && session?.record?.key === record.key ? session : null;
    this.title.textContent = session ? 'Тестовая ставка' : 'Кошелёк и ставки';
    this.terms.textContent = `${wallet.chainName} · тестовые ETH`;
    this.amountField.hidden = true;
    this.resultField.hidden = true;
    this.action(this.primary, '');
    this.action(this.secondary, '');
    this.note.dataset.state = this.error || readError ? 'error' : '';
    let note = '';

    const account = this.account;
    if (!account) {
      note = 'Подключите кошелёк в тестовой сети, чтобы увидеть баланс.';
      this.action(this.primary, 'Подключить кошелёк', () => this.connectWallet());
    } else if (!wallet.address) {
      note = 'Тестовый контракт ставок не настроен.';
    } else if (record && !sameAddress(account, record.account)) {
      note = 'Для этой ставки выберите в кошельке адрес, которым внесли взнос.';
    } else if (!record && session?.role === 'host' && session.opponent) {
      this.amountField.hidden = false;
      note =
        'Оба вносят одинаковую сумму. После одного раунда подтвердите итог в кошельке. При разногласии, ничьей или тайм-ауте взносы возвращаются.';
      this.action(this.primary, 'Внести и предложить', async () => this.create(session));
    } else if (!record) {
      note = !session
        ? ''
        : session.role === 'host'
          ? 'Ждём, пока соперник подключит кошелёк.'
          : 'После подключения кошельков создатель комнаты сможет предложить сумму.';
    } else if (!status) {
      note = 'Взнос ещё не найден в сети. Проверьте подтверждение транзакции в кошельке.';
      if (session?.role === 'host' && !session.record && session.opponent) {
        this.amountField.hidden = false;
        this.action(this.primary, 'Внести и предложить', async () => this.create(session));
      }
    } else {
      this.terms.textContent = `${formatStake(status.stake)} тестовых ETH с игрока · банк ${formatStake(status.stake * 2n)} ETH`;
      const account = record.account;
      const deadline = status.funded ? status.settlementDeadline : status.fundingDeadline;
      if (status.outcome !== 0) {
        note =
          status.outcome === 4
            ? 'Контракт вернул каждому его взнос.'
            : status.outcome === 3
              ? 'Ничья. Контракт вернул взносы.'
              : 'Итог подтверждён. Банк начислен победителю.';
      } else if (time >= deadline) {
        note = 'Срок истёк. Можно вернуть взносы.';
        this.action(this.primary, 'Вернуть ставки', async () => wallet.refund(account, record.key));
      } else if (!status.funded && record.role === 'guest') {
        note = 'Проверьте сумму. Ваш взнос подтверждается в кошельке.';
        this.action(this.primary, 'Внести ставку', async () => {
          if (!live || live !== this.session) throw new Error('Подключитесь к сопернику, чтобы внести ставку.');
          await wallet.fundMatch(account, record.key, status.stake);
          this.send('stake-update');
          this.hide();
        });
      } else if (!status.funded) {
        note = 'Ваш взнос принят. Ждём взнос соперника.';
        if (live) this.send('stake-offer', { key: record.key });
      } else if (!live || live.result !== null) {
        const vote = record.role === 'host' ? status.creatorVote : status.opponentVote;
        if (vote) {
          note = 'Ваш итог записан. Ждём подтверждения соперника или возврата по тайм-ауту.';
        } else {
          this.resultField.hidden = false;
          if (this.result.dataset.selection !== record.key) this.result.value = live?.result ? String(live.result) : '';
          this.result.dataset.selection = record.key;
          note = 'Выберите исход. Оба кошелька должны подтвердить один итог, чтобы контракт распределил банк.';
          this.action(this.primary, 'Подтвердить итог', async () => {
            const outcome = Number(this.result.value);
            if (outcome !== 1 && outcome !== 2 && outcome !== 3) throw new Error('Выберите исход раунда.');
            await wallet.confirmResult(account, record.key, outcome);
            this.send('stake-update');
          });
        }
      } else {
        note = 'Оба взноса подтверждены. Сыграйте один раунд.';
      }
    }
    if (account && credit !== null && credit > 0n) {
      this.action(this.secondary, `Вывести ${formatStake(credit)} ETH`, () => wallet.withdraw(account));
    }
    const records = this.saved();
    if (!live && record && records.length > 1 && this.secondary.hidden) {
      this.action(this.secondary, 'Другая ставка', async () => {
        const index = records.findIndex(({ key }) => key === record.key);
        this.open(null, records[(index + 1) % records.length]);
      });
    }
    this.note.textContent = this.error || readError || note;
  }

  private async create(session: Session): Promise<void> {
    const wallet = this.wallet;
    const account = this.account;
    const opponent = session.opponent;
    const stake = parseStake(this.amount.value);
    if (!stake) throw new Error('Введите положительную сумму в ETH.');
    if (session !== this.session || !account || !opponent || session.record)
      throw new Error('Кошельки участников ещё не готовы.');
    if (sameAddress(account, opponent)) throw new Error('У игроков должны быть разные адреса кошельков.');
    const time = await wallet.time();
    if (session !== this.session || session.record) throw new Error('Соперник вышел из комнаты.');
    const record: StakeRecord = { key: wallet.key(session.id, account), account, role: 'host' };
    this.save(record);
    this.viewed = record;
    try {
      await wallet.createMatch(account, session.id, opponent, stake, time + 180n, time + 600n);
    } catch (error) {
      try {
        const recovered = await wallet.status(record.key);
        if (recovered.stake > 0n && session === this.session) session.record = record;
      } catch {
        // Keep the recovery record in case the transaction appears later.
      }
      throw error;
    }
    if (session !== this.session) return;
    session.record = record;
    this.send('stake-offer', { key: record.key });
  }
}
