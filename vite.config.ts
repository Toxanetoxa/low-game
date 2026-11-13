import { existsSync, readFileSync } from 'node:fs';
import { env } from 'node:process';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { createBaseFaucet } from './scripts/base-faucet.ts';

const faucetPath = '/api/base-faucet';

export default defineConfig(({ command, isPreview }) => {
  const plugins = [viteSingleFile({ removeViteModuleLoader: true })];
  if (command !== 'serve' || isPreview || env.VITE_BASE_FAUCET_URL?.trim()) {
    return { base: './', plugins };
  }

  const envFile = new URL('./.env.base-faucet', import.meta.url);
  const file = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
  const keyId = (env.CDP_API_KEY_ID ?? file.CDP_API_KEY_ID)?.trim();
  const secret = (env.CDP_API_KEY_SECRET ?? file.CDP_API_KEY_SECRET)?.trim();
  if (!keyId || !secret) return { base: './', plugins };

  const faucet = createBaseFaucet(keyId, secret);
  return {
    base: './',
    plugins: [
      ...plugins,
      {
        name: 'local-base-faucet',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== faucetPath) return next();
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
    define: { 'import.meta.env.VITE_DEV_BASE_FAUCET_PATH': JSON.stringify(faucetPath) },
  };
});
