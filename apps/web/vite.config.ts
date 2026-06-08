import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import {
  findMissingEndpointEnvVars,
  formatMissingEndpointEnvMessage,
  shouldFailFastEndpointBuild,
} from './src/lib/endpoint-config'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const missingEndpointVars = findMissingEndpointEnvVars(env)

  if (
    command === 'build' &&
    shouldFailFastEndpointBuild(env) &&
    missingEndpointVars.length > 0
  ) {
    throw new Error(
      `${formatMissingEndpointEnvMessage(missingEndpointVars)}. Set these before running a deploy build.`,
    )
  }

  return {
    base: '/agents/',
    plugins: [
      react(),
      tailwindcss(),
    ],
    server: {
      port: 5174,
      strictPort: true,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./vitest.setup.ts'],
    },
  }
})
