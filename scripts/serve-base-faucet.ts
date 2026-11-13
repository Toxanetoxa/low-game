import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Address } from 'viem';
import { Buffer } from 'node:buffer';
import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { getAddress, isAddress, zeroAddress } from 'viem';

const endpoint = new URL('https://api.cdp.coinbase.com/platform/v2/evm/faucet');
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
const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim().replaceAll('\\n', '\n');
if (!apiKeyId || !apiKeySecret)
  throw new Error('Set CDP_API_KEY_ID and CDP_API_KEY_SECRET to run the Base Sepolia faucet');
const signRequest = createRequestSigner(apiKeyId, apiKeySecret);

const maxBodyBytes = 1_024;
const cooldownSeconds = 60;
const claimWindowMs = 60 * 60_000;
const claimsPerHour = 30;
const nextClaimAt = new Map<Address, number>();
const recentClaims: number[] = [];

function createRequestSigner(keyId: string, secret: string): () => string {
  const decoded = Buffer.from(secret, 'base64');
  const privateKey =
    decoded.length === 64 && !secret.startsWith('-----BEGIN')
      ? createPrivateKey({
          key: {
            kty: 'OKP',
            crv: 'Ed25519',
            d: decoded.subarray(0, 32).toString('base64url'),
            x: decoded.subarray(32).toString('base64url'),
          },
          format: 'jwk',
        })
      : createPrivateKey(secret);
  const ed25519 = privateKey.asymmetricKeyType === 'ed25519';
  if (!ed25519 && privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Use a Coinbase CDP Ed25519 key or a P-256 private key');
  }

  // Coinbase CDP requires a JWT bound to the HTTP method, host and path.
  // https://docs.cdp.coinbase.com/api-reference/v2/authentication
  return () => {
    const time = Math.floor(Date.now() / 1_000);
    const header = {
      alg: ed25519 ? 'EdDSA' : 'ES256',
      kid: keyId,
      typ: 'JWT',
      nonce: randomBytes(16).toString('hex'),
    };
    const claims = {
      sub: keyId,
      iss: 'cdp',
      iat: time,
      nbf: time,
      exp: time + 120,
      uris: [`POST ${endpoint.host}${endpoint.pathname}`],
    };
    const message = `${base64Json(header)}.${base64Json(claims)}`;
    const signature = sign(ed25519 ? null : 'sha256', Buffer.from(message), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${message}.${signature.toString('base64url')}`;
  };
}

function base64Json(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sendJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function limit(response: ServerResponse, retryAfter?: number): void {
  if (retryAfter !== undefined) response.setHeader('Retry-After', retryAfter);
  sendJson(response, 429, { retryAfter });
}

function providerRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1_000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

async function readAddress(request: IncomingMessage): Promise<Address | null> {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json' || Number(request.headers['content-length']) > maxBodyBytes) {
    request.resume();
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { address?: unknown } | null;
    const address = value?.address;
    return typeof address === 'string' && isAddress(address) && address !== zeroAddress ? getAddress(address) : null;
  } catch {
    return null;
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Vary', 'Origin');
  const origin = request.headers.origin;
  if (origin && !origins.has(origin)) {
    request.resume();
    sendJson(response, 403, {});
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
    sendJson(response, 403, {});
    return;
  }
  if (request.url !== '/faucet') {
    request.resume();
    sendJson(response, 404, {});
    return;
  }
  if (request.method === 'OPTIONS') {
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'POST') {
    request.resume();
    response.setHeader('Allow', 'POST, OPTIONS');
    sendJson(response, 405, {});
    return;
  }
  const address = await readAddress(request);
  if (!address) {
    sendJson(response, 400, {});
    return;
  }

  const now = Date.now();
  for (const [wallet, deadline] of nextClaimAt) {
    if (deadline <= now) nextClaimAt.delete(wallet);
  }
  while (recentClaims.length && recentClaims[0] + claimWindowMs <= now) recentClaims.shift();
  const addressDeadline = nextClaimAt.get(address) ?? now;
  const serviceDeadline = recentClaims.length >= claimsPerHour ? recentClaims[0] + claimWindowMs : now;
  const retryInMs = Math.max(addressDeadline, serviceDeadline) - now;
  if (retryInMs > 0) {
    limit(response, Math.ceil(retryInMs / 1_000));
    return;
  }
  nextClaimAt.set(address, now + cooldownSeconds * 1_000);
  recentClaims.push(now);

  const result = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signRequest()}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ address, network: 'base-sepolia', token: 'eth' }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (result.status === 429) {
    await result.body?.cancel();
    limit(response, providerRetryAfter(result.headers.get('Retry-After')));
    return;
  }
  if (!result.ok) {
    await result.body?.cancel();
    console.warn(`Base Sepolia faucet provider returned HTTP ${result.status}`);
    sendJson(response, 503, {});
    return;
  }
  const body = (await result.json()) as { transactionHash?: unknown } | null;
  const transactionHash = body?.transactionHash;
  if (typeof transactionHash !== 'string' || !/^0x[\da-f]{64}$/i.test(transactionHash)) {
    sendJson(response, 503, {});
    return;
  }
  sendJson(response, 200, { transactionHash });
}

const server = createServer({ requestTimeout: 15_000 }, (request, response) => {
  void handle(request, response).catch(() => {
    if (!response.headersSent && !response.destroyed) sendJson(response, 503, {});
  });
});
server.listen(port, host, () => {
  process.stdout.write(`Base Sepolia ETH faucet listening on ${host}:${port}/faucet\n`);
});
