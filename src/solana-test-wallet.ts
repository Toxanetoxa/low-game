import type { Hex } from 'viem';
import * as Base58 from 'ox/Base58';
import * as Ed25519 from 'ox/Ed25519';
import { formatUnits } from 'viem';

export const solanaDevnetRpc = 'https://api.devnet.solana.com';
export const solanaFaucetUrl = 'https://faucet.solana.com/';

const devnetGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const mainnetGenesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const lamportsPerSol = 1_000_000_000;
const seedPattern = /^0x[0-9a-f]{64}$/u;
const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]+$/u;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

type SignatureStatus = {
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  err?: unknown;
};

class SolanaServiceError extends Error {
  constructor(readonly status: number) {
    super('Solana Devnet недоступна. Попробуйте позже.');
  }
}

function faucetUrl(): URL | null {
  const configured = import.meta.env.VITE_SOLANA_FAUCET_URL?.trim() || import.meta.env.VITE_DEV_SOLANA_FAUCET_PATH;
  if (!configured) return null;

  const url = new URL(configured, location.href);
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHosts.has(url.hostname));
  if (!secure || url.username || url.password || url.hash) {
    throw new Error('Некорректный адрес сервиса пополнения Solana Devnet.');
  }
  return url;
}

function readSeed(storageKey: string): Hex | null {
  let stored: string | null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    throw new Error('Разрешите браузеру сохранять данные сайта, чтобы создать кошелёк SOL.');
  }
  if (stored === null) return null;
  if (!seedPattern.test(stored)) throw new Error('Не удалось прочитать сохранённый кошелёк SOL.');
  return stored as Hex;
}

async function solanaRpc<T>(url: URL, method: string, params: unknown[], timeout = 8_000): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeout),
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) throw new SolanaServiceError(response.status);
  const payload = (await response.json()) as { error?: { code?: number }; result?: T };
  if (payload.error || payload.result === undefined) throw new SolanaServiceError(payload.error?.code ?? 500);
  return payload.result;
}

function isSignature(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 88 && base58Pattern.test(value) && Base58.toBytes(value).length === 64
  );
}

export function formatSol(lamports: bigint): string {
  return formatUnits(lamports, 9);
}

export class SolanaTestWallet {
  private readonly rpc: URL;
  private readonly local: boolean;
  private readonly storageKey: string;
  private lastSeed: Hex | null = null;
  private publicAddress: string | null = null;
  private verifiedCluster: Promise<void> | null = null;

  constructor(rpcUrl = solanaDevnetRpc) {
    this.rpc = new URL(rpcUrl);
    this.local = loopbackHosts.has(this.rpc.hostname);
    const secure = this.rpc.protocol === 'https:' || (this.rpc.protocol === 'http:' && this.local);
    if (!secure || this.rpc.username || this.rpc.password || this.rpc.hash) {
      throw new Error('Некорректный адрес RPC Solana.');
    }
    this.storageKey = this.local ? 'low-game.solana-local-wallet.v1' : 'low-game.solana-devnet-wallet.v1';
    if (this.rpc.href === new URL(solanaDevnetRpc).href) this.verifiedCluster = Promise.resolve();
  }

  get address(): string | null {
    const seed = readSeed(this.storageKey);
    if (seed === this.lastSeed) return this.publicAddress;
    this.lastSeed = seed;
    this.publicAddress =
      seed === null ? null : Base58.fromBytes(Ed25519.getPublicKey({ privateKey: seed, as: 'Bytes' }));
    return this.publicAddress;
  }

  get canRequestFunds(): boolean {
    return (
      this.local ||
      Boolean(import.meta.env.VITE_SOLANA_FAUCET_URL?.trim() || import.meta.env.VITE_DEV_SOLANA_FAUCET_PATH)
    );
  }

  async create(): Promise<string> {
    const createWallet = () => {
      const existing = this.address;
      if (existing !== null) return existing;
      try {
        localStorage.setItem(this.storageKey, Ed25519.randomPrivateKey());
      } catch {
        throw new Error('Браузер не смог сохранить кошелёк SOL.');
      }
      const address = this.address;
      if (address === null) throw new Error('Браузер не сохранил кошелёк SOL.');
      return address;
    };
    return navigator.locks ? navigator.locks.request(this.storageKey, createWallet) : createWallet();
  }

  sign(message: Uint8Array, expectedAddress?: string): Uint8Array {
    const seed = readSeed(this.storageKey);
    if (seed === null) throw new Error('Сначала создайте кошелёк SOL.');
    if (
      expectedAddress &&
      expectedAddress !== Base58.fromBytes(Ed25519.getPublicKey({ privateKey: seed, as: 'Bytes' }))
    ) {
      throw new Error('Кошелёк SOL изменился. Повторите операцию.');
    }
    return Ed25519.sign({ payload: message, privateKey: seed, as: 'Bytes' });
  }

  ensureTestNetwork(): Promise<void> {
    return (this.verifiedCluster ??= solanaRpc<string>(this.rpc, 'getGenesisHash', [])
      .then((genesis) => {
        if (typeof genesis !== 'string' || (this.local ? genesis === mainnetGenesis : genesis !== devnetGenesis)) {
          throw new Error('Кошелёк SOL поддерживает Solana Devnet и локальную тестовую сеть.');
        }
      })
      .catch((error: unknown) => {
        this.verifiedCluster = null;
        throw error;
      }));
  }

  async balance(): Promise<bigint> {
    const address = this.address;
    if (address === null) throw new Error('Сначала создайте кошелёк SOL.');
    await this.ensureTestNetwork();
    let result: { value: number };
    try {
      result = await solanaRpc(this.rpc, 'getBalance', [address, { commitment: 'confirmed' }]);
    } catch (error) {
      if (error instanceof SolanaServiceError && error.status === 429) {
        throw new Error('Solana Devnet временно ограничила запросы баланса.');
      }
      throw new Error('Не удалось прочитать баланс Solana Devnet.');
    }
    if (!Number.isSafeInteger(result?.value) || result.value < 0) {
      throw new Error('Solana Devnet вернула некорректный баланс.');
    }
    return BigInt(result.value);
  }

  async requestTestFunds(): Promise<string> {
    const address = this.address;
    if (address === null) throw new Error('Сначала создайте кошелёк SOL.');
    await this.ensureTestNetwork();
    if (this.local) {
      let signature: unknown;
      try {
        signature = await solanaRpc(this.rpc, 'requestAirdrop', [address, lamportsPerSol, { commitment: 'confirmed' }]);
      } catch {
        throw new Error('Локальная сеть Solana не приняла запрос на пополнение.');
      }
      if (!isSignature(signature)) throw new Error('Локальная сеть Solana вернула некорректную подпись.');
      return signature;
    }

    const url = faucetUrl();
    if (url === null) throw new Error('Пополнение SOL для этой сети не настроено.');
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
        signal: AbortSignal.timeout(20_000),
        credentials: 'omit',
        redirect: 'error',
      });
    } catch {
      throw new Error('Сервис пополнения SOL недоступен. Можно воспользоваться краном Solana Devnet.');
    }
    const payload = (await response.json().catch(() => null)) as { signature?: unknown; retryAfter?: number } | null;
    if (response.status === 429) {
      const wait = payload?.retryAfter;
      if (typeof wait === 'number' && Number.isSafeInteger(wait) && wait > 0) {
        throw new Error(`Достигнут лимит пополнений SOL. Повторите через ${wait} с.`);
      }
      throw new Error('Достигнут лимит пополнений SOL. Попробуйте позже.');
    }
    if (!response.ok || !isSignature(payload?.signature)) {
      throw new Error('Сервис пополнения SOL не подтвердил отправку. Проверьте баланс перед повтором.');
    }
    return payload.signature;
  }

  async confirmFunds(signature: string): Promise<boolean | null> {
    if (!isSignature(signature)) return null;
    await this.ensureTestNetwork();
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      try {
        const timeout = Math.min(8_000, Math.max(1, Math.floor(deadline - performance.now())));
        const result = await solanaRpc<{ value: [SignatureStatus | null] }>(
          this.rpc,
          'getSignatureStatuses',
          [[signature], { searchTransactionHistory: true }],
          timeout,
        );
        const status = result?.value?.[0];
        if (status?.err != null) return false;
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return true;
      } catch {
        // A temporary RPC failure does not mean the transfer failed.
      }
      const remaining = Math.max(0, deadline - performance.now());
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, remaining)));
    }
    return null;
  }
}
