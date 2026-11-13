import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import * as Base58 from 'ox/Base58';
import { getAddress, isAddress, zeroAddress } from 'viem';

const maxBodyBytes = 1_024;
const cooldownSeconds = 60;
const claimWindowMs = 60 * 60_000;
const claimsPerHour = 30;
const base58Pattern = /^[1-9A-HJ-NP-Za-km-z]+$/u;

type FaucetNetwork = 'base-sepolia' | 'solana-devnet';

function createRequestSigner(keyId: string, secret: string, endpoint: URL): () => string {
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

function isSolanaValue(value: string, bytes: number): boolean {
  return (
    value.length <= (bytes === 32 ? 44 : 88) && base58Pattern.test(value) && Base58.toBytes(value).length === bytes
  );
}

async function readAddress(request: IncomingMessage, network: FaucetNetwork): Promise<string | null> {
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
    if (typeof address !== 'string') return null;
    if (network === 'solana-devnet') return isSolanaValue(address, 32) && address !== '1'.repeat(32) ? address : null;
    return isAddress(address) && address !== zeroAddress ? getAddress(address) : null;
  } catch {
    return null;
  }
}

export function createTestFaucet(keyId: string, keySecret: string, network: FaucetNetwork) {
  const solana = network === 'solana-devnet';
  const endpoint = new URL(`https://api.cdp.coinbase.com/platform/v2/${solana ? 'solana' : 'evm'}/faucet`);
  const signRequest = createRequestSigner(keyId, keySecret.replaceAll('\\n', '\n'), endpoint);
  const nextClaimAt = new Map<string, number>();
  const recentClaims: number[] = [];

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'POST') {
      request.resume();
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, {});
      return;
    }
    const address = await readAddress(request, network);
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
      body: JSON.stringify(solana ? { address, token: 'sol' } : { address, network, token: 'eth' }),
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
      console.warn(`${network} faucet provider returned HTTP ${result.status}`);
      sendJson(response, 503, {});
      return;
    }
    const body = (await result.json()) as { transactionHash?: unknown; transactionSignature?: unknown } | null;
    if (solana) {
      const signature = body?.transactionSignature;
      if (typeof signature === 'string' && isSolanaValue(signature, 64)) {
        sendJson(response, 200, { signature });
        return;
      }
    } else {
      const transactionHash = body?.transactionHash;
      if (typeof transactionHash === 'string' && /^0x[\da-f]{64}$/i.test(transactionHash)) {
        sendJson(response, 200, { transactionHash });
        return;
      }
    }
    sendJson(response, 503, {});
  }

  return (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) sendJson(response, 503, {});
    });
  };
}
