import { createServer } from 'node:http';
import process from 'node:process';
import { createTestFaucet } from './base-faucet.ts';

const host = process.env.BASE_FAUCET_HOST?.trim() || '127.0.0.1';
const port = Number(process.env.BASE_FAUCET_PORT || 8547);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid BASE_FAUCET_PORT');

const defaultOrigins = [
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const origins = new Set(process.env.BASE_FAUCET_ORIGINS?.split(',').map((origin) => origin.trim()) ?? defaultOrigins);
for (const origin of origins) {
  if (origin === 'null') continue;
  const url = URL.parse(origin);
  if (url?.origin !== origin || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('BASE_FAUCET_ORIGINS must contain exact HTTP(S) origins or null');
  }
}

const apiKeyId = process.env.CDP_API_KEY_ID?.trim();
const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
if (!apiKeyId || !apiKeySecret) throw new Error('Set CDP_API_KEY_ID and CDP_API_KEY_SECRET to run the testnet faucets');
const faucets = new Map([
  ['/faucet', createTestFaucet(apiKeyId, apiKeySecret, 'base-sepolia')],
  ['/faucet/solana', createTestFaucet(apiKeyId, apiKeySecret, 'solana-devnet')],
]);

const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
  const origin = request.headers.origin;
  if (origin && !origins.has(origin)) {
    request.resume();
    response.writeHead(403).end();
    return;
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  }
  if (
    host === '127.0.0.1' &&
    request.headers.host !== `127.0.0.1:${port}` &&
    request.headers.host !== `localhost:${port}`
  ) {
    request.resume();
    response.writeHead(403).end();
    return;
  }
  const faucet = faucets.get(request.url ?? '');
  if (!faucet) {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.writeHead(204).end();
    return;
  }
  faucet(request, response);
});
server.listen(port, host, () => {
  process.stdout.write(`Testnet faucets listening on ${host}:${port}/faucet and ${host}:${port}/faucet/solana\n`);
});
