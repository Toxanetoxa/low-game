import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Abi, Address, Hex } from 'viem';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';
import ganache from 'ganache';
import solc from 'solc';
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  isAddress,
  keccak256,
  parseEther,
  stringToHex,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type CompilerOutput = {
  errors?: Array<{ severity: string; formattedMessage: string }>;
  contracts?: Record<
    string,
    Record<
      string,
      {
        abi: Abi;
        evm: { bytecode: { object: string } };
      }
    >
  >;
};

async function compileEscrow(): Promise<{ abi: Abi; bytecode: Hex }> {
  const sourceName = 'DuelEscrow.sol';
  const content = await readFile(new URL('../contracts/DuelEscrow.sol', import.meta.url), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [sourceName]: { content } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'shanghai',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as CompilerOutput;
  const errors = output.errors?.filter(({ severity }) => severity === 'error') ?? [];
  assert.equal(errors.length, 0, errors.map(({ formattedMessage }) => formattedMessage).join('\n'));

  const escrow = output.contracts?.[sourceName]?.DuelEscrow;
  assert(escrow?.evm.bytecode.object, 'DuelEscrow produced no bytecode');
  return { abi: escrow.abi, bytecode: `0x${escrow.evm.bytecode.object}` };
}

function waitForStop(): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

const faucetAmount = '1';
const faucetCooldownMs = 60_000;
const maxFaucetBody = 1_024;

function sendJson(response: ServerResponse, status: number, payload: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function faucetAddress(request: IncomingMessage): Promise<Address | null> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maxFaucetBody) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { address?: unknown } | null;
    const address = body?.address;
    return typeof address === 'string' && isAddress(address) && address !== zeroAddress ? getAddress(address) : null;
  } catch {
    return null;
  }
}

function createFaucet(faucetPort: number, transfer: (address: Address) => Promise<Hex>) {
  const availableAt = new Map<Address, number>();
  let transfers: Promise<unknown> = Promise.resolve();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Cache-Control', 'no-store');

    if (request.headers.host !== `127.0.0.1:${faucetPort}` && request.headers.host !== `localhost:${faucetPort}`) {
      sendJson(response, 403, { error: 'Кран принимает запросы только с локального адреса.' });
      return;
    }
    if (request.url !== '/faucet') {
      sendJson(response, 404, { error: 'Маршрут не найден.' });
      return;
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST, OPTIONS');
      sendJson(response, 405, { error: 'Используйте POST.' });
      return;
    }
    const address = await faucetAddress(request);
    if (!address) {
      sendJson(response, 400, { error: 'Укажите действительный адрес Ethereum.' });
      return;
    }

    const now = Date.now();
    for (const [wallet, deadline] of availableAt) {
      if (deadline <= now) availableAt.delete(wallet);
    }
    const deadline = availableAt.get(address);
    if (deadline !== undefined) {
      const retryAfter = Number.isFinite(deadline) ? Math.ceil((deadline - now) / 1_000) : 60;
      response.setHeader('Retry-After', retryAfter);
      sendJson(response, 429, { error: 'Для этого кошелька уже запрошено пополнение.', retryAfter });
      return;
    }

    availableAt.set(address, Infinity);
    // Only one transfer may use the faucet account at a time so nonces cannot collide.
    const pending = transfers.then(() => transfer(address));
    transfers = pending.catch(() => {});
    try {
      const transactionHash = await pending;
      sendJson(response, 200, { amount: faucetAmount, transactionHash });
    } catch {
      sendJson(response, 503, { error: 'Локальное пополнение не подтверждено. Повторите попытку позже.' });
    } finally {
      availableAt.set(address, Date.now() + faucetCooldownMs);
    }
  }

  return createServer({ requestTimeout: 15_000 }, (request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 503, { error: 'Локальный кран недоступен.' });
    });
  });
}

const port = Number(process.argv[2] ?? '8545');
if (!Number.isInteger(port) || port < 1 || port > 65534) {
  throw new Error('RPC port must be an integer from 1 to 65534');
}

const faucetPort = port + 1;
const host = '127.0.0.1';
const chainId = 31337;
const endpoint = `http://${host}:${port}`;
const rulesHash = keccak256(
  stringToHex('LOW GAME: one 60-second round; two matching confirmations; draw or dispute refunds; v1'),
);
const { abi, bytecode } = await compileEscrow();
const server = ganache.server({
  chain: { chainId, networkId: chainId, hardfork: 'shanghai' },
  miner: { blockTime: 1 },
  wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 10 },
  logging: { quiet: true },
});

await server.listen(port, host);
let faucet: ReturnType<typeof createFaucet> | undefined;
try {
  const provider = server.provider;
  const [fixture, , , faucetFixture] = Object.values(provider.getInitialAccounts());
  assert(fixture, 'Ganache did not create a deployment account');
  const account = privateKeyToAccount(fixture.secretKey as Hex);
  const chain = defineChain({
    id: chainId,
    name: 'LOW GAME local test',
    nativeCurrency: { name: 'Test ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [endpoint] } },
  });
  const transport = custom(provider, { retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 50 });
  const wallet = createWalletClient({ chain, transport, account });
  const deployment = await publicClient.waitForTransactionReceipt({
    hash: await wallet.deployContract({ abi, bytecode, args: [rulesHash] }),
  });
  assert.equal(deployment.status, 'success', 'DuelEscrow deployment reverted');
  assert(deployment.contractAddress, 'Deployment produced no contract address');

  assert(faucetFixture, 'Ganache did not create a faucet account');
  const faucetWallet = createWalletClient({
    chain,
    transport,
    account: privateKeyToAccount(faucetFixture.secretKey as Hex),
  });
  faucet = createFaucet(faucetPort, async (address) => {
    const hash = await faucetWallet.sendTransaction({ to: address, value: parseEther(faucetAmount) });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
    assert.equal(receipt.status, 'success', 'Faucet transfer reverted');
    return hash;
  });
  const listening = once(faucet, 'listening');
  faucet.listen(faucetPort, host);
  await listening;

  console.log(`Local test RPC: ${endpoint}`);
  console.log(`Local ETH faucet: http://${host}:${faucetPort}/faucet`);
  console.log(`DuelEscrow: ${deployment.contractAddress}`);
  console.log(`VITE_ESCROW_CHAIN_ID=${chainId}`);
  console.log(`VITE_ESCROW_ADDRESS=${deployment.contractAddress}`);
  console.log(`VITE_LOCAL_FAUCET_URL=http://${host}:${faucetPort}/faucet`);
  console.log('Test state is held in memory until this process stops. Press Ctrl+C to stop.');
  await waitForStop();
} finally {
  if (faucet?.listening) {
    const closed = once(faucet, 'close');
    faucet.close();
    await closed;
  }
  await server.close();
}
