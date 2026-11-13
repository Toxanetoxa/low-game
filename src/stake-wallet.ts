/// <reference types="vite/client" />

import type { Address, EIP1193Provider, Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  formatEther,
  getAddress,
  http,
  isAddress,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  stringToHex,
  zeroAddress,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export { getAddress };
export type { Address, Hex };

export const stakeRules = 'LOW GAME: one 60-second round; two matching confirmations; draw or dispute refunds; v1';
export const STAKE_RULES_HASH = keccak256(stringToHex(stakeRules));
export type StakeOutcome = 1 | 2 | 3;

export type StakeMatch = {
  creator: Address;
  opponent: Address;
  stake: bigint;
  fundingDeadline: bigint;
  settlementDeadline: bigint;
  funded: boolean;
  outcome: number;
  creatorVote: number;
  opponentVote: number;
};

const localChain = defineChain({
  id: 31337,
  name: 'Локальная тестовая сеть',
  nativeCurrency: { name: 'Test ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'];
const hex32 = /^0x[\da-f]{64}$/i;
// A vote estimated before the other vote arrives may execute second and credit two accounts.
const settlementGasBuffer = 60_000n;

const abi = parseAbi([
  'function rulesHash() view returns (bytes32)',
  'function matches(bytes32) view returns (address creator, address opponent, uint256 stake, uint64 fundingDeadline, uint64 settlementDeadline, bool funded, uint8 outcome, uint8 creatorVote, uint8 opponentVote)',
  'function credits(address) view returns (uint256)',
  'function createMatch(bytes16 matchId, address opponent, uint64 fundingDeadline, uint64 settlementDeadline) payable returns (bytes32)',
  'function fundMatch(bytes32 key) payable',
  'function confirmResult(bytes32 key, uint8 outcome)',
  'function refund(bytes32 key)',
  'function withdraw()',
]);

export function parseStake(input: string): bigint | null {
  const value = input.trim().replace(',', '.');
  if (!/^\d{1,60}(?:\.\d{1,18})?$/.test(value)) return null;
  const wei = parseEther(value);
  return wei > 0n && wei <= maxUint256 / 2n ? wei : null;
}

export function formatStake(wei: bigint): string {
  return formatEther(wei);
}

function injectedProvider(): EIP1193Provider | null {
  const wallet = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  return typeof wallet?.request === 'function' ? wallet : null;
}

function localFaucetUrl(): URL {
  const configured = import.meta.env.VITE_LOCAL_FAUCET_URL?.trim();
  const url = new URL(configured || 'http://127.0.0.1:8546/faucet');
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/faucet' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Адрес тестового крана должен указывать на /faucet на этом компьютере.');
  }
  return url;
}

function baseFaucetUrl(): URL {
  const configured = baseFaucetEndpoint();
  if (!configured) {
    throw new Error('Пополнение Base Sepolia пока недоступно.');
  }
  let url: URL;
  try {
    url = new URL(configured, location.href);
  } catch {
    throw new Error('Адрес сервиса пополнения Base Sepolia задан неверно.');
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHosts.includes(url.hostname));
  if (!secure || url.username || url.password || url.hash) {
    throw new Error('Адрес сервиса пополнения Base Sepolia задан неверно.');
  }
  return url;
}

function baseFaucetEndpoint(): string | undefined {
  return import.meta.env.VITE_BASE_FAUCET_URL?.trim() || import.meta.env.VITE_DEV_BASE_FAUCET_PATH;
}

function matchIdBytes(matchId: string): Hex {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(matchId)) {
    throw new Error('Некорректный идентификатор матча.');
  }
  return `0x${matchId.replaceAll('-', '').toLowerCase()}`;
}

type StakeChain = typeof baseSepolia | typeof localChain;

export class StakeWallet {
  readonly address: Address | null;
  readonly symbol = 'ETH';
  readonly directPayout = false;
  readonly formatStake = formatStake;
  readonly parseStake = parseStake;
  private readonly chain: StakeChain;
  private readonly temporaryKeyStorage: string;
  private readonly walletSelectionStorage: string;
  private savedTemporary: PrivateKeyAccount | null = null;
  private temporarySigner: PrivateKeyAccount | null = null;

  constructor(address: Address | null, chain: StakeChain) {
    this.address = address;
    this.chain = chain;
    this.temporaryKeyStorage = `low-game.wallet.eth.${chain.id}.key`;
    this.walletSelectionStorage = `low-game.wallet.eth.${chain.id}.selected`;
    try {
      this.savedTemporary = this.readTemporary();
      if (localStorage.getItem(this.walletSelectionStorage) === 'temporary') {
        this.temporarySigner = this.savedTemporary;
      }
    } catch {
      // A blocked or unreadable browser store must not prevent the game from opening.
    }
  }

  get chainId(): number {
    return this.chain.id;
  }

  get chainName(): string {
    return this.chain.name;
  }

  get usesLocalNetwork(): boolean {
    return this.chain.id === localChain.id;
  }

  get usesEmbeddedFaucet(): boolean {
    return !this.usesLocalNetwork && !baseFaucetEndpoint();
  }

  get usesTemporaryWallet(): boolean {
    return this.temporarySigner !== null;
  }

  get temporaryAddress(): Address | null {
    return this.savedTemporary?.address ?? null;
  }

  async createTemporary(): Promise<Address> {
    const create = () => {
      let saved = this.readTemporary();
      try {
        if (!saved) {
          const key = generatePrivateKey();
          saved = privateKeyToAccount(key);
          localStorage.setItem(this.temporaryKeyStorage, key);
        }
        localStorage.setItem(this.walletSelectionStorage, 'temporary');
      } catch {
        throw new Error('Не удалось сохранить тестовый кошелёк. Разрешите сайту сохранять данные.');
      }
      this.savedTemporary = saved;
      this.temporarySigner = saved;
      return saved.address;
    };
    return navigator.locks ? navigator.locks.request(this.temporaryKeyStorage, create) : create();
  }

  async requestTestFunds(account: Address): Promise<Hex> {
    const selected = await this.account();
    if (selected?.toLowerCase() !== account.toLowerCase()) {
      throw new Error('Кошелёк или сеть изменились. Повторите пополнение.');
    }
    const local = this.usesLocalNetwork;
    const endpoint = local ? localFaucetUrl() : baseFaucetUrl();
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: account }),
        signal: AbortSignal.timeout(20_000),
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new Error(
        local
          ? 'Локальный кран недоступен. Запустите npm run dev:escrow и попробуйте снова.'
          : 'Сервис пополнения Base Sepolia недоступен. Попробуйте позже.',
      );
    }
    const result = await response.json().catch(() => null);
    if (response.status === 429) {
      if (Number.isSafeInteger(result?.retryAfter) && result.retryAfter > 0) {
        const seconds = result.retryAfter;
        const delay = seconds < 60 ? `${seconds} сек.` : `${Math.ceil(seconds / 60)} мин.`;
        throw new Error(`Достигнут лимит пополнений. Повторите через ${delay}`);
      }
      throw new Error('Достигнут лимит пополнений. Попробуйте позже.');
    }
    if (
      !response.ok ||
      typeof result?.transactionHash !== 'string' ||
      !hex32.test(result.transactionHash) ||
      (local && result.amount !== '1')
    ) {
      throw new Error('Не удалось получить подтверждение от сервиса пополнения. Проверьте баланс перед повтором.');
    }
    return result.transactionHash as Hex;
  }

  async confirmBaseFunds(hash: Hex): Promise<boolean | null> {
    const rpc = createPublicClient({ chain: baseSepolia, transport: http() });
    const receipt = await rpc
      .waitForTransactionReceipt({ hash, timeout: 30_000, checkReplacement: false })
      .catch(() => null);
    return receipt ? receipt.status === 'success' : null;
  }

  normalizeAccount(value: string): Address {
    return getAddress(value);
  }

  key(matchId: string, creator: string): Hex {
    return keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'bytes16' }],
        [this.normalizeAccount(creator), matchIdBytes(matchId)],
      ),
    );
  }

  async connect(): Promise<Address> {
    const transport = this.injectedTransport();
    const wallet = createWalletClient({ chain: this.chain, transport });
    const rpc = this.publicClient(transport);
    await wallet.requestAddresses();
    if ((await rpc.getChainId()) !== this.chain.id) {
      try {
        await wallet.switchChain({ id: this.chain.id });
      } catch {
        throw new Error(`Выберите сеть ${this.chain.name} в кошельке и повторите подключение.`);
      }
    }
    await this.checkChain(rpc);
    const [account] = await wallet.getAddresses();
    if (!account) throw new Error('Кошелёк не предоставил адрес.');
    this.temporarySigner = null;
    try {
      localStorage.removeItem(this.walletSelectionStorage);
    } catch {
      // Connecting an external wallet does not require access to browser storage.
    }
    return account;
  }

  async account(): Promise<Address | null> {
    if (this.temporarySigner) return this.temporarySigner.address;
    if (!injectedProvider()) return null;
    const transport = this.injectedTransport();
    const wallet = createWalletClient({ chain: this.chain, transport });
    const rpc = this.publicClient(transport);
    if ((await rpc.getChainId()) !== this.chain.id) return null;
    const [account] = await wallet.getAddresses();
    return account ?? null;
  }

  async balance(account: string): Promise<bigint> {
    const rpc = this.publicClient();
    await this.checkChain(rpc);
    const balance = await rpc.getBalance({ address: this.normalizeAccount(account) });
    await this.checkChain(rpc);
    return balance;
  }

  watchContext(onChange: () => void): void {
    const provider = injectedProvider();
    const onExternalChange = () => {
      if (!this.temporarySigner) onChange();
    };
    provider?.on?.('accountsChanged', onExternalChange);
    provider?.on?.('chainChanged', onExternalChange);
    provider?.on?.('disconnect', onExternalChange);
  }

  async status(key: Hex): Promise<StakeMatch> {
    const rpc = this.publicClient();
    const address = await this.checkContract(rpc);
    const [creator, opponent, stake, fundingDeadline, settlementDeadline, funded, outcome, creatorVote, opponentVote] =
      await rpc.readContract({ address, abi, functionName: 'matches', args: [key] });
    await this.checkChain(rpc);
    return {
      creator,
      opponent,
      stake,
      fundingDeadline,
      settlementDeadline,
      funded,
      outcome,
      creatorVote,
      opponentVote,
    };
  }

  async credits(account: string): Promise<bigint> {
    const rpc = this.publicClient();
    const address = await this.checkContract(rpc);
    const credits = await rpc.readContract({
      address,
      abi,
      functionName: 'credits',
      args: [this.normalizeAccount(account)],
    });
    await this.checkChain(rpc);
    return credits;
  }

  async time(): Promise<bigint> {
    const rpc = this.publicClient();
    await this.checkChain(rpc);
    const { timestamp } = await rpc.getBlock();
    await this.checkChain(rpc);
    return timestamp;
  }

  async createMatch(
    account: string,
    matchId: string,
    opponent: string,
    stake: bigint,
    fundingDeadline: bigint,
    settlementDeadline: bigint,
  ): Promise<Hex> {
    const key = this.key(matchId, account);
    const data = encodeFunctionData({
      abi,
      functionName: 'createMatch',
      args: [matchIdBytes(matchId), this.normalizeAccount(opponent), fundingDeadline, settlementDeadline],
    });
    await this.send(this.normalizeAccount(account), data, stake);
    return key;
  }

  async fundMatch(account: string, key: Hex, stake: bigint): Promise<void> {
    await this.send(
      this.normalizeAccount(account),
      encodeFunctionData({ abi, functionName: 'fundMatch', args: [key] }),
      stake,
    );
  }

  async confirmResult(account: string, key: Hex, outcome: StakeOutcome): Promise<void> {
    await this.send(
      this.normalizeAccount(account),
      encodeFunctionData({ abi, functionName: 'confirmResult', args: [key, outcome] }),
      undefined,
      settlementGasBuffer,
    );
  }

  async refund(account: string, key: Hex): Promise<void> {
    await this.send(this.normalizeAccount(account), encodeFunctionData({ abi, functionName: 'refund', args: [key] }));
  }

  async withdraw(account: string): Promise<void> {
    await this.send(this.normalizeAccount(account), encodeFunctionData({ abi, functionName: 'withdraw' }));
  }

  private readTemporary(): PrivateKeyAccount | null {
    let key: string | null;
    try {
      key = localStorage.getItem(this.temporaryKeyStorage);
    } catch {
      throw new Error('Хранилище кошелька недоступно. Разрешите сайту сохранять данные.');
    }
    if (key === null) return null;
    if (hex32.test(key)) {
      try {
        return privateKeyToAccount(key as Hex);
      } catch {
        // Preserve unreadable data so an existing wallet is never silently replaced.
      }
    }
    throw new Error('Не удалось прочитать сохранённый тестовый кошелёк.');
  }

  private injectedTransport() {
    const provider = injectedProvider();
    if (!provider) throw new Error('Откройте игру в браузере с Ethereum-кошельком.');
    return custom(provider, { retryCount: 0 });
  }

  private publicClient(transport = this.temporarySigner ? http() : this.injectedTransport()) {
    return createPublicClient({ chain: this.chain, transport, cacheTime: 0 });
  }

  private async checkChain(rpc: ReturnType<StakeWallet['publicClient']>): Promise<void> {
    if ((await rpc.getChainId()) !== this.chain.id) {
      throw new Error(`Переключите кошелёк на сеть ${this.chain.name}.`);
    }
  }

  private async checkContract(rpc: ReturnType<StakeWallet['publicClient']>): Promise<Address> {
    const address = this.address;
    if (!address) throw new Error('Тестовый контракт ставок не настроен.');
    await this.checkChain(rpc);
    const rules = await rpc.readContract({ address, abi, functionName: 'rulesHash' });
    if (rules !== STAKE_RULES_HASH) throw new Error('Правила контракта не совпадают с правилами игры.');
    return address;
  }

  private async send(account: Address, data: Hex, value?: bigint, gasBuffer?: bigint): Promise<void> {
    const signer = this.temporarySigner;
    const send = () => this.sendTransaction(account, data, signer, value, gasBuffer);
    if (signer && navigator.locks) {
      await navigator.locks.request(`${this.temporaryKeyStorage}.transaction`, send);
    } else {
      await send();
    }
  }

  private async sendTransaction(
    account: Address,
    data: Hex,
    signer: PrivateKeyAccount | null,
    value?: bigint,
    gasBuffer?: bigint,
  ): Promise<void> {
    const transport = signer ? http() : this.injectedTransport();
    const wallet = createWalletClient({ chain: this.chain, transport });
    const rpc = this.publicClient(transport);
    const address = await this.checkContract(rpc);
    const selected = signer?.address ?? (await wallet.getAddresses())[0];
    if (this.temporarySigner !== signer || selected?.toLowerCase() !== account.toLowerCase()) {
      throw new Error('В кошельке выбран другой адрес. Переключитесь на адрес участника матча.');
    }
    const transaction = { to: address, data, value };
    const gas = gasBuffer === undefined ? undefined : (await rpc.estimateGas({ ...transaction, account })) + gasBuffer;
    const hash = await wallet.sendTransaction({ ...transaction, account: signer ?? account, chain: this.chain, gas });
    let replaced = false;
    const receipt = await rpc.waitForTransactionReceipt({
      hash,
      timeout: 120_000,
      onReplaced: ({ reason }) => {
        replaced = reason !== 'repriced';
      },
    });
    await this.checkChain(rpc);
    if (replaced) throw new Error('Транзакция была отменена или заменена в кошельке.');
    if (receipt.status !== 'success') throw new Error('Сеть отклонила транзакцию.');
  }
}

export function createStakeWallet(): StakeWallet {
  const address = import.meta.env.VITE_ESCROW_ADDRESS?.trim();
  const chainId = import.meta.env.VITE_ESCROW_CHAIN_ID?.trim() || String(baseSepolia.id);
  const chain = chainId === String(localChain.id) ? localChain : baseSepolia;
  const validChain = chainId === String(baseSepolia.id) || chainId === String(localChain.id);
  const contract =
    validChain && address && isAddress(address) && address.toLowerCase() !== zeroAddress ? getAddress(address) : null;
  return new StakeWallet(contract, chain);
}
