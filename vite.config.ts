import { existsSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createTestFaucet } from './scripts/base-faucet.ts';

const baseFaucetPath = '/api/base-faucet';
const solanaFaucetPath = '/api/solana-faucet';

export default defineConfig(({ command, isPreview }) => {
  const plugins = [viteSingleFile({ removeViteModuleLoader: true })];
  if (command !== 'serve' || isPreview) {
    return { base: './', plugins };
  }

  const envFile = new URL('./.env.base-faucet', import.meta.url);
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const keyId = (env.CDP_API_KEY_ID ?? file.CDP_API_KEY_ID)?.trim();
  const secret = (env.CDP_API_KEY_SECRET ?? file.CDP_API_KEY_SECRET)?.trim();
  if (!keyId || !secret) return { base: './', plugins };

  const faucets = new Map([
    [baseFaucetPath, createTestFaucet(keyId, secret, 'base-sepolia')],
    [solanaFaucetPath, createTestFaucet(keyId, secret, 'solana-devnet')],
  ]);
  return {
    base: './',
    plugins: [
      ...plugins,
      {
        name: 'local-base-faucet',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const faucet = faucets.get(request.url ?? '');
            if (!faucet) return next();
            const origin = request.headers.origin;
            if (origin && URL.parse(origin)?.host !== request.headers.host) {
              request.resume();
              response.writeHead(403).end();
              return;
            }
            faucet(request, response);
          });
        },
      },
    ],
    define: {
      'import.meta.env.VITE_DEV_BASE_FAUCET_PATH': JSON.stringify(baseFaucetPath),
      'import.meta.env.VITE_DEV_SOLANA_FAUCET_PATH': JSON.stringify(solanaFaucetPath),
    },
  };
});
