import type { Hex, StakeOutcome } from './stake-wallet';
import { SolanaStakeWallet } from './solana-stake-wallet';
import { solanaFaucetUrl } from './solana-test-wallet';
import { createStakeWallet } from './stake-wallet';

type Role = 'host' | 'guest';
type Asset = 'ETH' | 'SOL';
type Wallet = ReturnType<typeof createStakeWallet> | SolanaStakeWallet;
type StakeMatch = Awaited<ReturnType<Wallet['status']>>;
type StakeRecord = { key: Hex; account: string; role: Role };
type Session = {
  id: string;
  role: Role;
  opponents: Partial<Record<Asset, string>>;
  asset: Asset | null;
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
const refreshInterval = { ETH: 2_500, SOL: 5_000 };

const hexKey = /^0x[\da-f]{64}$/i;
function sameAddress(a: string, b: string): boolean {
  return /^0x[\da-f]{40}$/i.test(a) && /^0x[\da-f]{40}$/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const embeddedFaucetUrl = 'https://openfaucet.org/base-sepolia';

function find<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Элемент ставки отсутствует: ${id}`);
  return node as T;
}

export class Stakes {
  private readonly eth = createStakeWallet();
  private readonly sol = new SolanaStakeWallet();
  private asset: Asset = 'ETH';
  private readonly lobbyAsset = find<HTMLSelectElement>('lobby-wallet-asset');
  private readonly stakeAsset = find<HTMLSelectElement>('stake-asset');
  private readonly stakeAssetField = find('stake-asset-field');
  private readonly storageNote = find('stake-storage-note');
  private readonly creditField = find('stake-withdrawable-field');
  private readonly amountLabel = find('stake-amount-label');
  private readonly external = find<HTMLButtonElement>('lobby-wallet-external');
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
  private account: string | null = null;
  private viewed: StakeRecord | null = null;
  private busy = false;
  private sendingTopUp = false;
  private submitAction: (() => Promise<void>) | undefined;
  private trigger: HTMLElement | null = null;
  private error = '';
  private refreshVersion = 0;
  private watchingWallet = false;
  private lobbyVisible = false;

  constructor(private readonly options: Options) {
    this.lobbyAsset.addEventListener('change', () => this.selectAsset(this.lobbyAsset.value));
    this.stakeAsset.addEventListener('change', () => this.selectAsset(this.stakeAsset.value));
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
      void this.connectFromLobby(false);
    });
    this.external.addEventListener('click', () => {
      void this.connectFromLobby(true);
    });
    this.lobbyTopUp.addEventListener('click', () => {
      if (this.asset === 'ETH' && this.eth.usesEmbeddedFaucet) this.openEmbeddedFaucet();
      else if (this.asset === 'SOL' && !this.sol.accountWallet.canRequestFunds) this.openSolanaFaucet();
      else void this.topUpFromLobby();
    });
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
      if (this.asset === 'ETH' && this.shouldPoll()) void this.refresh();
    }, refreshInterval.ETH);
    window.setInterval(() => {
      if (this.asset === 'SOL' && this.shouldPoll()) void this.refresh();
    }, refreshInterval.SOL);
    this.showLobbyBalance(null);
  }

  private shouldPoll(): boolean {
    const session = this.session;
    const inSolanaRound = this.asset === 'SOL' && session?.roundStarted && session.result === null;
    return this.lobbyVisible || this.isOpen || Boolean(session?.record && !inSolanaRound);
  }

  private get wallet(): Wallet {
    return this.asset === 'ETH' ? this.eth : this.sol;
  }

  private storageKey(wallet: Wallet): string {
    const contract = wallet.symbol === 'ETH' ? wallet.address?.toLowerCase() : wallet.address;
    return `low-game.stakes.${wallet.chainId}.${contract ?? 'unconfigured'}`;
  }

  private selectAsset(value: string): void {
    if ((value !== 'ETH' && value !== 'SOL') || this.busy || this.sendingTopUp || this.session?.asset || this.viewed) {
      this.lobbyAsset.value = this.asset;
      this.stakeAsset.value = this.asset;
      return;
    }
    this.setAsset(value);
    void this.refresh();
  }

  private setAsset(asset: Asset): void {
    if (asset === this.asset) return;
    this.asset = asset;
    this.lobbyAsset.value = asset;
    this.stakeAsset.value = asset;
    this.account = null;
    this.refreshVersion += 1;
    this.error = '';
    this.amount.value = '';
    this.showLobbyBalance(null);
    this.showBalances(null, null);
    this.lobbyMessage('');
    if (this.isOpen) {
      this.amountField.hidden = true;
      this.resultField.hidden = true;
      this.action(this.primary, '');
      this.action(this.secondary, '');
      this.action(this.history, '');
      this.note.textContent = 'Обновляем данные кошелька…';
    }
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
    if (!this.eth.address && !this.sol.address) return;
    if (this.session?.id === id) return;
    this.session = {
      id,
      role,
      opponents: {},
      asset: null,
      opponentReady: false,
      record: null,
      match: null,
      roundStarted: false,
      result: null,
    };
    for (const trigger of this.triggers) trigger.hidden = false;
    this.viewed = null;
    void this.sendWallets();
  }

  disconnect(): void {
    this.session = null;
    this.viewed = null;
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
    const wallet = [this.eth, this.sol].find(
      (candidate) =>
        candidate.address &&
        candidate.chainId === packet.chainId &&
        typeof packet.contract === 'string' &&
        sameAddress(candidate.address, packet.contract),
    );
    if (!session || !wallet || packet.room !== session.id) return true;
    const asset = wallet.symbol;
    if (packet.kind === 'stake-wallet' && typeof packet.account === 'string') {
      try {
        const previous = session.opponents[asset];
        const account = wallet.normalizeAccount(packet.account);
        if (previous === account) return true;
        session.opponents[asset] = account;
        if (!previous) void this.sendWallets();
        if (session.role === 'host' && session.record && session.asset === asset) {
          this.send('stake-offer', { key: session.record.key });
        }
      } catch {
        return true;
      }
    }
    if (packet.kind === 'stake-offer') {
      if (session.role === 'guest' && !session.record && typeof packet.key === 'string' && hexKey.test(packet.key)) {
        void this.loadOffer(session, wallet, packet.key as Hex);
      }
      return true;
    }
    if (packet.kind === 'stake-ready') {
      if (session.role !== 'host' || session.asset !== asset || session.record?.key !== packet.key) return true;
      if (session.opponentReady) return true;
      session.opponentReady = true;
    }
    void this.refresh();
    return true;
  }

  private async sendWallets(): Promise<void> {
    const session = this.session;
    if (!session) return;
    await Promise.allSettled(
      [this.eth, this.sol].map(async (wallet) => {
        if (!wallet.address) return;
        const account = await wallet.account();
        if (account && this.session === session) this.send('stake-wallet', { account }, wallet);
      }),
    );
  }

  private send(kind: string, details: Record<string, unknown> = {}, wallet = this.wallet): void {
    if (!wallet.address || !this.session) return;
    this.options.send({
      kind,
      room: this.session.id,
      chainId: wallet.chainId,
      contract: wallet.address,
      ...details,
    });
  }

  private async loadOffer(session: Session, wallet: Wallet, key: Hex): Promise<void> {
    try {
      const account = await wallet.account();
      const opponent = session.opponents[wallet.symbol];
      if (!account || !opponent || (await wallet.key(session.id, opponent)) !== key) return;
      const match = await wallet.status(key);
      if (
        session !== this.session ||
        session.record ||
        session.opponents[wallet.symbol] !== opponent ||
        !sameAddress(match.creator, opponent) ||
        !sameAddress(match.opponent, account) ||
        match.stake === 0n ||
        match.outcome !== 0
      )
        return;
      const record: StakeRecord = { key, account, role: 'guest' };
      this.save(record, wallet);
      session.asset = wallet.symbol;
      this.setAsset(wallet.symbol);
      session.record = record;
      session.match = match;
      this.open(null, record);
    } catch {
      // An unverifiable invitation must never trigger a wallet transaction.
    }
  }

  private saved(wallet = this.wallet): StakeRecord[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.storageKey(wallet)) ?? '[]');
      if (!Array.isArray(value)) return [];
      return value.filter(
        (entry) =>
          entry &&
          typeof entry.key === 'string' &&
          hexKey.test(entry.key) &&
          typeof entry.account === 'string' &&
          (wallet.symbol === 'ETH' ? /^0x[\da-f]{40}$/i : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/).test(entry.account) &&
          (entry.role === 'host' || entry.role === 'guest'),
      );
    } catch {
      return [];
    }
  }

  private save(record: StakeRecord, wallet = this.wallet): void {
    const previous = this.saved(wallet).filter(({ key }) => key !== record.key);
    try {
      localStorage.setItem(this.storageKey(wallet), JSON.stringify([...previous, record]));
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
    this.viewed = null;
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
    if (this.busy || this.sendingTopUp) return;
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
    const { formatStake, symbol, chainName, directPayout } = this.wallet;
    const wallet = balance === null ? '—' : `${formatStake(balance)} ${symbol}`;
    const withdrawable = credit === null ? '—' : `${formatStake(credit)} ${symbol}`;
    if (this.walletBalance.textContent !== wallet) this.walletBalance.textContent = wallet;
    if (this.withdrawableBalance.textContent !== withdrawable) this.withdrawableBalance.textContent = withdrawable;
    this.network.textContent = chainName;
    this.creditField.hidden = directPayout;
    this.walletAddress.hidden = this.account === null;
    this.storageNote.hidden = !this.account || (symbol === 'ETH' && !this.eth.usesTemporaryWallet);
    if (this.walletAddress.textContent !== (this.account ?? '')) this.walletAddress.textContent = this.account ?? '';
  }

  private showLobbyBalance(balance: bigint | null): void {
    const { formatStake, symbol, chainName } = this.wallet;
    const value = balance === null ? (this.account ? '—' : '') : `${formatStake(balance)} ${symbol}`;
    if (this.lobbyBalance.textContent !== value) this.lobbyBalance.textContent = value;
    this.lobbyBalance.title = balance === null ? chainName : `${value} · ${chainName}`;
    this.lobbyBalance.hidden = !this.account;
    const status = this.account ? chainName : 'Кошелёк ещё не создан';
    if (this.lobbyWalletStatus.textContent !== status) this.lobbyWalletStatus.textContent = status;
    this.lobbyWalletStatus.title = this.account ?? '';
    this.lobbyConnect.hidden = Boolean(this.account && (symbol === 'SOL' || this.eth.usesTemporaryWallet));
    this.lobbyConnect.textContent =
      symbol === 'ETH' && this.eth.temporaryAddress ? 'Встроенный ETH' : 'Создать кошелёк';
    this.external.hidden =
      symbol !== 'ETH' ||
      typeof (window as Window & { ethereum?: unknown }).ethereum !== 'object' ||
      Boolean(this.account && !this.eth.usesTemporaryWallet);
    this.lobbyTopUp.hidden = this.account === null;
    if (symbol === 'ETH' && this.eth.usesEmbeddedFaucet) this.lobbyTopUp.setAttribute('aria-haspopup', 'dialog');
    else this.lobbyTopUp.removeAttribute('aria-haspopup');
    this.recovery.hidden = !this.account && this.saved().length === 0;
  }

  private async connectFromLobby(external: boolean): Promise<void> {
    if (this.busy || this.sendingTopUp) return;
    this.busy = true;
    this.refreshVersion += 1;
    this.lobbyAsset.disabled = true;
    this.lobbyConnect.disabled = true;
    this.external.disabled = true;
    this.lobbyMessage(external ? 'Подтвердите подключение в кошельке.' : 'Создаём тестовый кошелёк…');
    try {
      await this.connectWallet(external);
      this.lobbyMessage('');
    } catch (error) {
      this.lobbyMessage(error instanceof Error ? error.message : 'Не удалось открыть кошелёк.', true);
    } finally {
      this.busy = false;
      this.lobbyAsset.disabled = false;
      this.lobbyConnect.disabled = false;
      this.external.disabled = false;
      void this.refresh();
    }
  }

  private openSolanaFaucet(): void {
    if (!this.account) return;
    const address = this.account;
    const link = document.createElement('a');
    link.href = solanaFaucetUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Открыть кран Solana';
    const showAddress = (copied: boolean) => {
      if (this.asset !== 'SOL' || this.account !== address) return;
      this.lobbyMessage(copied ? 'Адрес скопирован. Вставьте его в кран.' : `Адрес для крана Solana · ${address}`);
      this.lobbyFeedback.append(' ', link);
    };
    showAddress(false);
    window.open(solanaFaucetUrl, '_blank', 'noopener,noreferrer');
    void navigator.clipboard?.writeText(address).then(
      () => showAddress(true),
      () => {},
    );
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
    const wallet = this.wallet;
    this.sendingTopUp = true;
    this.lobbyTopUp.disabled = true;
    this.lobbyAsset.disabled = true;
    this.lobbyMessage(`Запрашиваем тестовые ${wallet.symbol}…`);
    const isCurrentAccount = () =>
      this.wallet === wallet && this.account !== null && sameAddress(this.account, account);
    try {
      let confirmed: boolean | null;
      if (wallet.symbol === 'SOL') {
        const signature = await wallet.accountWallet.requestTestFunds();
        confirmed = await wallet.accountWallet.confirmFunds(signature);
      } else {
        const hash = await wallet.requestTestFunds(wallet.normalizeAccount(account));
        confirmed = wallet.usesLocalNetwork ? true : await wallet.confirmBaseFunds(hash);
      }
      if (!isCurrentAccount()) return;
      if (confirmed === true) this.lobbyMessage(`Тестовые ${wallet.symbol} зачислены.`);
      else if (confirmed === false) this.lobbyMessage(`${wallet.chainName} отклонила перевод. Попробуйте позже.`, true);
      else this.lobbyMessage('Перевод отправлен. Подтверждение задерживается. Баланс обновится автоматически.');
    } catch (error) {
      if (isCurrentAccount()) {
        this.lobbyMessage(error instanceof Error ? error.message : 'Не удалось пополнить кошелёк.', true);
        if (wallet.symbol === 'SOL' && !wallet.local) {
          const fallback = document.createElement('a');
          fallback.href = solanaFaucetUrl;
          fallback.target = '_blank';
          fallback.rel = 'noopener noreferrer';
          fallback.textContent = 'Кран Solana Devnet';
          this.lobbyFeedback.append(' ', fallback, ` · ${account}`);
        }
      }
    } finally {
      this.sendingTopUp = false;
      this.lobbyTopUp.disabled = false;
      this.lobbyAsset.disabled = false;
      void this.refresh();
    }
  }

  private async connectWallet(external = false): Promise<void> {
    const wallet = this.wallet;
    const account =
      wallet.symbol === 'SOL'
        ? await wallet.accountWallet.create()
        : external
          ? await wallet.connect()
          : await wallet.createTemporary();
    if (wallet === this.wallet) this.account = account;
    this.watchWallet();
    void this.sendWallets();
  }

  private watchWallet(): void {
    if (this.watchingWallet) return;
    this.watchingWallet = true;
    this.eth.watchContext(() => {
      void this.sendWallets();
      if (this.asset !== 'ETH') return;
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
          void this.sendWallets();
        }
        const [walletRead, creditRead, matchRead] = await Promise.allSettled([
          readBalance ? wallet.balance(account) : null,
          visible && wallet.symbol === 'ETH' && wallet.address ? wallet.credits(account) : null,
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
    const { symbol, formatStake } = wallet;
    const session = this.session;
    const opponent = session?.opponents[symbol];
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
    this.stakeAssetField.hidden = Boolean(record || session?.asset);
    this.stakeAsset.disabled = this.busy;
    this.stakeAsset.value = symbol;
    this.amountLabel.textContent = `Сумма с каждого игрока, ${symbol}`;
    if (!account) {
      note = 'Встроенный кошелёк хранится в этом браузере. Используйте только тестовые средства.';
      primary = ['Создать кошелёк', () => this.connectWallet()];
    } else if (!wallet.address) {
      note = `Ставки в ${symbol} пока недоступны. Для этой сети нужно подключить программу ставок.`;
    } else if (record && !sameAddress(account, record.account)) {
      note = 'Выберите в кошельке адрес, который использовали для этой ставки.';
    } else if (!record && session?.role === 'host' && opponent) {
      showAmount = true;
      terms = 'Оба игрока вносят одинаковую сумму. Бой начнётся после двух взносов.';
      primary = [`Предложить ставку и внести ${symbol}`, () => this.create(session)];
    } else if (!record) {
      note = showWallet
        ? 'Пополняйте баланс в лобби. Предложить ставку можно после подключения соперника.'
        : session?.role === 'host'
          ? `Сопернику нужно создать кошелёк ${symbol}.`
          : 'Кошелёк подключён. Создатель комнаты предложит сумму ставки.';
    } else if (!status) {
      note = 'Взнос ещё не найден в сети. Проверьте подтверждение транзакции в кошельке.';
      if (session?.role === 'host' && !session.record && opponent) {
        showAmount = true;
        primary = [`Предложить ставку и внести ${symbol}`, () => this.create(session)];
      }
    } else {
      terms = `${formatStake(status.stake)} ${symbol} с игрока · банк ${formatStake(status.stake * 2n)} ${symbol}`;
      const account = record.account;
      const deadline = status.funded ? status.settlementDeadline : status.fundingDeadline;
      if (status.outcome !== 0) {
        note =
          status.outcome === 4
            ? 'Каждый участник получил свой взнос обратно.'
            : status.outcome === 3
              ? 'Ничья. Взносы возвращены.'
              : wallet.directPayout
                ? 'Итог подтверждён. Банк переведён на кошелёк победителя.'
                : 'Итог подтверждён. Банк начислен победителю.';
      } else if (time >= deadline) {
        note = 'Срок истёк. Можно вернуть взносы.';
        primary = ['Вернуть ставки', () => wallet.refund(account, record.key)];
      } else if (!status.funded && record.role === 'guest') {
        note = live
          ? 'Создатель комнаты уже внёс ставку. Внесите столько же, чтобы начать бой.'
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
          note = 'Оба игрока подтверждают итог. При ничьей или разных решениях ставки возвращаются.';
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
    if (wallet.symbol === 'ETH' && account && credit !== null && credit > 0n) {
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
    const opponent = session.opponents[wallet.symbol];
    const stake = wallet.parseStake(this.amount.value);
    if (!stake) throw new Error(`Введите положительную сумму в ${wallet.symbol}.`);
    if (session !== this.session || !account || !opponent || session.record)
      throw new Error('Кошельки участников ещё не готовы.');
    if (sameAddress(account, opponent)) throw new Error('У игроков должны быть разные адреса кошельков.');
    const time = await wallet.time();
    if (session !== this.session || session.record) throw new Error('Соперник вышел из комнаты.');
    const key = await wallet.key(session.id, account);
    if (session !== this.session || session.record) throw new Error('Соперник вышел из комнаты.');
    const record: StakeRecord = { key, account, role: 'host' };
    this.save(record);
    session.asset = wallet.symbol;
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
      if (!session.record && session === this.session) session.asset = null;
      throw error;
    }
    if (session !== this.session) return;
    session.record = record;
    this.send('stake-offer', { key: record.key });
  }
}
