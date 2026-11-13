/// <reference types="vite/client" />

import type { Address, EIP1193Provider, Hex } from 'viem';
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
const transactionHash = /^0x[\da-f]{64}$/i;

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
  const configured = import.meta.env.VITE_BASE_FAUCET_URL?.trim();
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

function matchIdBytes(matchId: string): Hex {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(matchId)) {
    throw new Error('Некорректный идентификатор матча.');
  }
  return `0x${matchId.replaceAll('-', '').toLowerCase()}`;
}

type StakeChain = typeof baseSepolia | typeof localChain;

export class StakeWallet {
  readonly address: Address | null;
  private readonly chain: StakeChain;

  constructor(address: Address | null, chain: StakeChain) {
    this.address = address;
    this.chain = chain;
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
    return !this.usesLocalNetwork && !import.meta.env.VITE_BASE_FAUCET_URL?.trim();
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
      !transactionHash.test(result.transactionHash) ||
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

  key(matchId: string, creator: Address): Hex {
    return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes16' }], [creator, matchIdBytes(matchId)]));
  }

  async connect(): Promise<Address> {
    const { wallet, rpc } = this.clients();
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
    return account;
  }

  async account(): Promise<Address | null> {
    if (!injectedProvider()) return null;
    const { wallet, rpc } = this.clients();
    if ((await rpc.getChainId()) !== this.chain.id) return null;
    const [account] = await wallet.getAddresses();
    return account ?? null;
  }

  async balance(account: Address): Promise<bigint> {
    const { rpc } = this.clients();
    await this.checkChain(rpc);
    const balance = await rpc.getBalance({ address: account });
    await this.checkChain(rpc);
    return balance;
  }

  watchContext(onChange: () => void): void {
    const provider = injectedProvider();
    provider?.on?.('accountsChanged', onChange);
    provider?.on?.('chainChanged', onChange);
    provider?.on?.('disconnect', onChange);
  }

  async status(key: Hex): Promise<StakeMatch> {
    const { rpc } = this.clients();
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

  async credits(account: Address): Promise<bigint> {
    const { rpc } = this.clients();
    const address = await this.checkContract(rpc);
    const credits = await rpc.readContract({ address, abi, functionName: 'credits', args: [account] });
    await this.checkChain(rpc);
    return credits;
  }

  async time(): Promise<bigint> {
    const { rpc } = this.clients();
    await this.checkChain(rpc);
    const { timestamp } = await rpc.getBlock();
    await this.checkChain(rpc);
    return timestamp;
  }

  async createMatch(
    account: Address,
    matchId: string,
    opponent: Address,
    stake: bigint,
    fundingDeadline: bigint,
    settlementDeadline: bigint,
  ): Promise<Hex> {
    const key = this.key(matchId, account);
    const data = encodeFunctionData({
      abi,
      functionName: 'createMatch',
      args: [matchIdBytes(matchId), opponent, fundingDeadline, settlementDeadline],
    });
    await this.send(account, data, stake);
    return key;
  }

  async fundMatch(account: Address, key: Hex, stake: bigint): Promise<void> {
    await this.send(account, encodeFunctionData({ abi, functionName: 'fundMatch', args: [key] }), stake);
  }

  async confirmResult(account: Address, key: Hex, outcome: StakeOutcome): Promise<void> {
    await this.send(account, encodeFunctionData({ abi, functionName: 'confirmResult', args: [key, outcome] }));
  }

  async refund(account: Address, key: Hex): Promise<void> {
    await this.send(account, encodeFunctionData({ abi, functionName: 'refund', args: [key] }));
  }

  async withdraw(account: Address): Promise<void> {
    await this.send(account, encodeFunctionData({ abi, functionName: 'withdraw' }));
  }

  private clients() {
    const provider = injectedProvider();
    if (!provider) throw new Error('Откройте игру в браузере с Ethereum-кошельком.');
    const transport = custom(provider, { retryCount: 0 });
    return {
      rpc: createPublicClient({ chain: this.chain, transport, cacheTime: 0 }),
      wallet: createWalletClient({ chain: this.chain, transport }),
    };
  }

  private async checkChain(rpc: ReturnType<StakeWallet['clients']>['rpc']): Promise<void> {
    if ((await rpc.getChainId()) !== this.chain.id) {
      throw new Error(`Переключите кошелёк на сеть ${this.chain.name}.`);
    }
  }

  private async checkContract(rpc: ReturnType<StakeWallet['clients']>['rpc']): Promise<Address> {
    const address = this.address;
    if (!address) throw new Error('Тестовый контракт ставок не настроен.');
    await this.checkChain(rpc);
    const rules = await rpc.readContract({ address, abi, functionName: 'rulesHash' });
    if (rules !== STAKE_RULES_HASH) throw new Error('Правила контракта не совпадают с правилами игры.');
    return address;
  }

  private async send(account: Address, data: Hex, value?: bigint): Promise<void> {
    const { wallet, rpc } = this.clients();
    const address = await this.checkContract(rpc);
    const [selected] = await wallet.getAddresses();
    if (selected?.toLowerCase() !== account.toLowerCase()) {
      throw new Error('В кошельке выбран другой адрес. Переключитесь на адрес участника матча.');
    }
    const hash = await wallet.sendTransaction({ account, to: address, data, value, chain: this.chain });
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
