import type { Instruction, Address as SolanaAddress } from '@solana/kit';
import type { Hex, StakeOutcome } from './stake-wallet';
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  isSolanaError,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signatureBytes,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from '@solana/kit';
import { fromHex, parseUnits, toHex } from 'viem';
import { formatSol, solanaDevnetRpc, SolanaTestWallet } from './solana-test-wallet';

const systemProgram = address('11111111111111111111111111111111');
const encoder = getAddressEncoder();
const decoder = getAddressDecoder();
const roomPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxStake = (2n ** 64n - 1n) / 2n;
const rpcTimeout = 8_000;
const clockCacheMs = 12_000;

function rpcUrl(): string {
  const configured = import.meta.env.DEV && import.meta.env.VITE_SOLANA_RPC_URL?.trim();
  if (!configured) return solanaDevnetRpc;
  const url = new URL(configured);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Для локальной Solana укажите HTTP RPC на этом компьютере.');
  }
  return url.href;
}

export class SolanaStakeWallet {
  readonly chainId: string;
  readonly chainName: string;
  readonly address: SolanaAddress | null;
  readonly symbol = 'SOL';
  readonly local: boolean;
  readonly directPayout = true;
  readonly accountWallet: SolanaTestWallet;
  private readonly rpc: ReturnType<typeof createSolanaRpc>;
  private clock: { timestamp: bigint; sampledAt: number } | null = null;

  constructor() {
    const url = rpcUrl();
    this.local = url !== solanaDevnetRpc;
    this.chainId = this.local ? 'solana:local' : 'solana:devnet';
    this.chainName = this.local ? 'Локальная Solana' : 'Solana Devnet';
    this.rpc = createSolanaRpc(url);
    this.accountWallet = new SolanaTestWallet(url);
    const configured = import.meta.env.VITE_SOLANA_ESCROW_PROGRAM?.trim();
    this.address = configured && configured !== systemProgram ? address(configured) : null;
  }

  normalizeAccount(value: string): string {
    const result = address(value);
    if (result === systemProgram) throw new Error('Некорректный адрес кошелька SOL.');
    return result;
  }

  parseStake(value: string): bigint | null {
    const normalized = value.trim().replace(',', '.');
    if (!/^\d{1,20}(?:\.\d{1,9})?$/.test(normalized)) return null;
    const amount = parseUnits(normalized, 9);
    return amount > 0n && amount <= maxStake ? amount : null;
  }

  formatStake = formatSol;

  async account(): Promise<string | null> {
    return this.accountWallet.address;
  }

  async balance(account: string): Promise<bigint> {
    if (account !== this.accountWallet.address) throw new Error('Кошелёк SOL изменился.');
    return this.accountWallet.balance();
  }

  async key(roomId: string, creator: string): Promise<Hex> {
    if (!roomPattern.test(roomId)) throw new Error('Некорректный идентификатор матча.');
    const [pda] = await getProgramDerivedAddress({
      programAddress: this.program(),
      seeds: ['duel', encoder.encode(address(creator)), fromHex(`0x${roomId.replaceAll('-', '')}`, 'bytes')],
    });
    return toHex(Uint8Array.from(encoder.encode(pda)));
  }

  async status(key: Hex) {
    const { value } = await this.rpc
      .getAccountInfo(this.matchAddress(key), { commitment: 'confirmed', encoding: 'base64' })
      .send({ abortSignal: AbortSignal.timeout(rpcTimeout) });
    if (!value) throw new Error('Ставка пока не найдена в Solana.');
    const bytes = Uint8Array.from(atob(value.data[0]), (character) => character.charCodeAt(0));
    if (value.owner !== this.program() || bytes.length !== 96 || bytes[0] !== 1) {
      throw new Error('Solana вернула неверные данные ставки.');
    }
    const state = new DataView(bytes.buffer);
    return {
      creator: decoder.decode(bytes.subarray(8, 40)),
      opponent: decoder.decode(bytes.subarray(40, 72)),
      stake: state.getBigUint64(72, true),
      fundingDeadline: state.getBigUint64(80, true),
      settlementDeadline: state.getBigUint64(88, true),
      funded: bytes[1] === 1,
      outcome: bytes[2],
      creatorVote: bytes[3],
      opponentVote: bytes[4],
    };
  }

  async time(): Promise<bigint> {
    const elapsed = this.clock ? performance.now() - this.clock.sampledAt : Infinity;
    if (this.clock && elapsed < clockCacheMs) return this.clock.timestamp + BigInt(Math.floor(elapsed / 1_000));

    const abortSignal = AbortSignal.timeout(rpcTimeout);
    const slot = await this.rpc.getSlot({ commitment: 'confirmed' }).send({ abortSignal });
    const timestamp = await this.rpc.getBlockTime(slot).send({ abortSignal });
    if (timestamp === null) throw new Error('Solana не вернула время сети.');
    this.clock = { timestamp, sampledAt: performance.now() };
    return timestamp;
  }

  async createMatch(
    account: string,
    roomId: string,
    opponent: string,
    stake: bigint,
    fundingDeadline: bigint,
    settlementDeadline: bigint,
  ): Promise<Hex> {
    const minimum = await this.rpc
      .getMinimumBalanceForRentExemption(0n)
      .send({ abortSignal: AbortSignal.timeout(rpcTimeout) });
    if (stake < minimum) throw new Error(`Минимальная ставка Solana — ${formatSol(minimum)} SOL.`);
    const key = await this.key(roomId, account);
    const data = new Uint8Array(41);
    data.set(fromHex(`0x${roomId.replaceAll('-', '')}`, 'bytes'), 1);
    const values = new DataView(data.buffer);
    values.setBigUint64(17, stake, true);
    values.setBigUint64(25, fundingDeadline, true);
    values.setBigUint64(33, settlementDeadline, true);
    await this.send(account, data, [
      { address: address(account), role: AccountRole.WRITABLE_SIGNER },
      { address: address(opponent), role: AccountRole.READONLY },
      { address: this.matchAddress(key), role: AccountRole.WRITABLE },
      { address: systemProgram, role: AccountRole.READONLY },
    ]);
    return key;
  }

  async fundMatch(account: string, key: Hex, stake: bigint): Promise<void> {
    const match = await this.status(key);
    if (match.opponent !== account || match.stake !== stake) throw new Error('Условия ставки SOL изменились.');
    await this.send(account, Uint8Array.of(1), [
      { address: address(account), role: AccountRole.WRITABLE_SIGNER },
      { address: this.matchAddress(key), role: AccountRole.WRITABLE },
      { address: systemProgram, role: AccountRole.READONLY },
    ]);
  }

  async confirmResult(account: string, key: Hex, outcome: StakeOutcome): Promise<void> {
    await this.send(account, Uint8Array.of(2, outcome), [
      { address: address(account), role: AccountRole.READONLY_SIGNER },
      ...(await this.payoutAccounts(key)),
    ]);
  }

  async refund(account: string, key: Hex): Promise<void> {
    await this.send(account, Uint8Array.of(3), await this.payoutAccounts(key));
  }

  private program(): SolanaAddress {
    if (!this.address) throw new Error('Программа ставок Solana не настроена.');
    return this.address;
  }

  private matchAddress(key: Hex): SolanaAddress {
    return decoder.decode(fromHex(key, 'bytes'));
  }

  private async payoutAccounts(key: Hex): Promise<NonNullable<Instruction['accounts']>> {
    const match = await this.status(key);
    return [
      { address: this.matchAddress(key), role: AccountRole.WRITABLE },
      { address: address(match.creator), role: AccountRole.WRITABLE },
      { address: address(match.opponent), role: AccountRole.WRITABLE },
    ];
  }

  private async send(account: string, data: Uint8Array, accounts: Instruction['accounts']): Promise<void> {
    await this.accountWallet.ensureTestNetwork();
    const feePayer = address(account);
    const { value: lifetime } = await this.rpc
      .getLatestBlockhash({ commitment: 'confirmed' })
      .send({ abortSignal: AbortSignal.timeout(rpcTimeout) });
    if (this.accountWallet.address !== feePayer) throw new Error('Выбран другой кошелёк SOL.');
    const programAddress = this.program();
    const message = appendTransactionMessageInstruction(
      { programAddress, data, accounts },
      setTransactionMessageLifetimeUsingBlockhash(
        lifetime,
        setTransactionMessageFeePayer(feePayer, createTransactionMessage({ version: 'legacy' })),
      ),
    );
    const transaction = compileTransaction(message);
    const signed = {
      ...transaction,
      signatures: {
        [feePayer]: signatureBytes(this.accountWallet.sign(Uint8Array.from(transaction.messageBytes), feePayer)),
      },
    };
    const signature = getSignatureFromTransaction(signed);
    const wire = getBase64EncodedWireTransaction(signed);
    const submit = () =>
      this.rpc
        .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
        .send({ abortSignal: AbortSignal.timeout(rpcTimeout) });

    let submissionError: unknown;
    try {
      await submit();
    } catch (error) {
      submissionError = error;
      if (
        error instanceof TypeError ||
        (error instanceof DOMException && error.name === 'TimeoutError') ||
        (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
          (error.context.statusCode === 429 || error.context.statusCode >= 500))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        // The same signed transaction has the same signature, even if the first submission reached Solana.
        try {
          await submit();
          submissionError = undefined;
        } catch (retryError) {
          submissionError = retryError;
        }
      }
    }
    const confirmed = await this.accountWallet.confirmFunds(signature);
    if (confirmed === true) return;
    if (confirmed === false) throw new Error('Solana отклонила транзакцию.');
    if (submissionError) throw submissionError;
    throw new Error('Подтверждение SOL задерживается. Проверьте ставку перед повтором.');
  }
}
