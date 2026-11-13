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
  fighterNames: () => readonly [string, string];
};
type PanelAction = readonly [label: string, run?: () => Promise<void>];

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
  private readonly form = find<HTMLFormElement>('stake-form');
  private readonly title = find('stake-title');
  private readonly note = find('stake-note');
  private readonly terms = find('stake-terms');
  private readonly network = find('stake-network');
  private readonly walletAddress = find('stake-account');
  private readonly walletBalance = find('stake-wallet-balance');
  private readonly lobbyBalance = find('lobby-wallet-balance');
  private readonly lobbyWalletStatus = find('lobby-wallet-status');
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
  private readonly hostResult = find('stake-result-host');
  private readonly guestResult = find('stake-result-guest');
  private readonly close = find<HTMLButtonElement>('stake-close');
  private readonly primary = find<HTMLButtonElement>('stake-primary');
  private readonly secondary = find<HTMLButtonElement>('stake-secondary');
  private readonly history = find<HTMLButtonElement>('stake-history');
  private readonly walletBack = find<HTMLButtonElement>('stake-wallet-back');
  private readonly recovery = find<HTMLButtonElement>('stake-recovery-open');
  private readonly triggers = [find<HTMLButtonElement>('stake-open'), find<HTMLButtonElement>('stake-mobile-open')];
  private session: Session | null = null;
  private account: Address | null = null;
  private viewed: StakeRecord | null = null;
  private busy = false;
  private submitAction: (() => Promise<void>) | undefined;
  private trigger: HTMLElement | null = null;
  private error = '';
  private readonly storageKey: string;
  private refreshVersion = 0;
  private watchingWallet = false;
  private lobbyVisible = false;

  constructor(private readonly options: Options) {
    this.storageKey = `low-game.stakes.${this.wallet.chainId}.${this.wallet.address?.toLowerCase() ?? 'unconfigured'}`;
    this.network.textContent = this.wallet.chainName;
    for (const trigger of this.triggers)
      trigger.addEventListener('click', () => this.open(trigger, this.session?.record ?? null));
    this.recovery.addEventListener('click', () => this.open(this.recovery, null));
    this.close.addEventListener('click', () => this.hide());
    this.walletBack.addEventListener('click', () => this.open(null, null));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.isOpen && !this.primary.hidden && this.submitAction) void this.run(this.submitAction);
    });
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
    this.showLobbyBalance(null);
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
    this.amountField.hidden = true;
    this.resultField.hidden = true;
    this.action(this.primary, '');
    this.action(this.secondary, '');
    this.action(this.history, '');
    this.walletBack.hidden = true;
    this.terms.textContent = '';
    this.note.dataset.state = '';
    this.note.textContent = 'Обновляем данные кошелька…';
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
    if (button.textContent !== label) button.textContent = label;
    button.disabled = this.busy;
    if (button === this.primary) {
      this.submitAction = run;
      return;
    }
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
    this.history.disabled = true;
    this.walletBack.disabled = true;
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
    this.walletAddress.hidden = this.account === null;
    if (this.walletAddress.textContent !== (this.account ?? '')) this.walletAddress.textContent = this.account ?? '';
  }

  private showLobbyBalance(balance: bigint | null): void {
    const value = balance === null ? (this.account ? '—' : '') : `${formatStake(balance)} ETH`;
    if (this.lobbyBalance.textContent !== value) this.lobbyBalance.textContent = value;
    this.lobbyBalance.title = balance === null ? this.wallet.chainName : `${value} · ${this.wallet.chainName}`;
    this.lobbyBalance.hidden = !this.account;
    const status = this.account ? this.wallet.chainName : 'Кошелёк не подключён';
    if (this.lobbyWalletStatus.textContent !== status) this.lobbyWalletStatus.textContent = status;
    this.lobbyWalletStatus.title = this.account ?? '';
    this.lobbyConnect.hidden = this.account !== null;
    this.lobbyTopUp.hidden = this.account === null;
    this.recovery.hidden = !this.account && this.saved().length === 0;
  }

  private async connectFromLobby(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.refreshVersion += 1;
    this.lobbyConnect.disabled = true;
    this.lobbyMessage('Подтвердите подключение в кошельке.');
    try {
      await this.connectWallet();
      this.lobbyMessage('');
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
    const showWallet = !session && !record;
    this.title.textContent = showWallet
      ? 'Тестовый кошелёк'
      : live || !record
        ? 'Ставка на дуэль'
        : 'Сохранённая ставка';
    this.note.dataset.state = this.error || readError ? 'error' : '';
    let terms = '';
    let note = '';
    let showAmount = false;
    let showResult = false;
    let primary: PanelAction = [''];
    let secondary: PanelAction = [''];
    let history: PanelAction = [''];

    const account = this.account;
    if (!account) {
      note = 'Подключите кошелёк и подтвердите выбор сети в нём.';
      primary = ['Подключить кошелёк', () => this.connectWallet()];
    } else if (!wallet.address) {
      note = 'Ставки и вывод сейчас недоступны. Пополнить тестовый баланс можно в лобби.';
    } else if (record && !sameAddress(account, record.account)) {
      note = 'Выберите в кошельке адрес, который использовали для этой ставки.';
    } else if (!record && session?.role === 'host' && session.opponent) {
      showAmount = true;
      terms = 'Оба игрока вносят одинаковую сумму. Бой начнётся после двух взносов.';
      primary = ['Предложить ставку и внести ETH', () => this.create(session)];
    } else if (!record) {
      note = showWallet
        ? 'Пополняйте баланс в лобби. Предложить ставку можно после подключения соперника.'
        : session?.role === 'host'
          ? 'Сопернику нужно открыть «Тестовая ставка» и подключить кошелёк.'
          : 'Кошелёк подключён. Создатель комнаты предложит сумму ставки.';
    } else if (!status) {
      note = 'Взнос ещё не найден в сети. Проверьте подтверждение транзакции в кошельке.';
      if (session?.role === 'host' && !session.record && session.opponent) {
        showAmount = true;
        primary = ['Предложить ставку и внести ETH', () => this.create(session)];
      }
    } else {
      terms = `${formatStake(status.stake)} ETH с игрока · банк ${formatStake(status.stake * 2n)} ETH`;
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
        primary = ['Вернуть ставки', () => wallet.refund(account, record.key)];
      } else if (!status.funded && record.role === 'guest') {
        note = live
          ? 'Создатель комнаты уже внёс ставку. Подтвердите свой взнос в кошельке, чтобы начать бой.'
          : 'Чтобы внести ставку, снова подключитесь к сопернику.';
        if (live) {
          primary = [
            'Принять и внести ставку',
            async () => {
              if (live !== this.session) throw new Error('Подключитесь к сопернику, чтобы внести ставку.');
              await wallet.fundMatch(account, record.key, status.stake);
              this.send('stake-update');
              this.hide();
            },
          ];
        }
      } else if (!status.funded) {
        note = 'Ваш взнос принят. Ждём взнос соперника.';
        if (live) this.send('stake-offer', { key: record.key });
      } else if (!live || live.result !== null) {
        const vote = record.role === 'host' ? status.creatorVote : status.opponentVote;
        if (vote) {
          note = 'Ваш итог записан. Ждём подтверждения соперника или возврата по тайм-ауту.';
        } else {
          showResult = true;
          const [host, guest] = this.options.fighterNames();
          const hostLabel = live ? `Победа: ${host}` : record.role === 'host' ? 'Ваша победа' : 'Победа создателя';
          const guestLabel = live ? `Победа: ${guest}` : record.role === 'guest' ? 'Ваша победа' : 'Победа соперника';
          if (this.hostResult.textContent !== hostLabel) this.hostResult.textContent = hostLabel;
          if (this.guestResult.textContent !== guestLabel) this.guestResult.textContent = guestLabel;
          if (this.result.dataset.selection !== record.key) this.result.value = live?.result ? String(live.result) : '';
          this.result.dataset.selection = record.key;
          note = 'Подтвердите итог в кошельке. При ничьей или разных решениях ставки возвращаются.';
          primary = [
            'Подтвердить итог',
            async () => {
              const outcome = Number(this.result.value);
              if (outcome !== 1 && outcome !== 2 && outcome !== 3) throw new Error('Выберите исход раунда.');
              await wallet.confirmResult(account, record.key, outcome);
              this.send('stake-update');
            },
          ];
        }
      } else {
        note = 'Оба взноса подтверждены. Сыграйте один раунд.';
      }
    }
    if (account && credit !== null && credit > 0n) {
      secondary = [`Вывести ${formatStake(credit)} ETH`, () => wallet.withdraw(account)];
    }
    const records = this.saved();
    if (!session && records.length) {
      if (!record) history = ['Сохранённые ставки', async () => this.open(null, records[records.length - 1])];
      else if (records.length > 1) {
        const index = records.findIndex(({ key }) => key === record.key);
        history = [
          `Следующая ставка (${index + 1} из ${records.length})`,
          async () => this.open(null, records[(index + 1) % records.length]),
        ];
      }
    }
    this.terms.textContent = terms;
    this.amountField.hidden = !showAmount;
    this.resultField.hidden = !showResult;
    this.action(this.primary, ...primary);
    this.action(this.secondary, ...secondary);
    this.action(this.history, ...history);
    this.walletBack.hidden = Boolean(session || !record);
    this.walletBack.disabled = this.busy;
    const message = this.error || readError || note;
    if (this.note.textContent !== message) this.note.textContent = message;
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
