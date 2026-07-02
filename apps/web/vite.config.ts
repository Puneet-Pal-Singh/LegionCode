import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import {
  findMissingEndpointEnvVars,
  formatMissingEndpointEnvMessage,
  shouldFailFastEndpointBuild,
} from './src/lib/endpoint-config'

const CLIENT_LOG_DEV_ENDPOINT = '/__legioncode/client-log'
const CLIENT_LOG_MAX_BYTES = 8_000

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
      ...clientLogTerminalPlugins(env),
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

function clientLogTerminalPlugins(env: Record<string, string>): Plugin[] {
  if (env.VITE_FORWARD_CLIENT_LOGS !== 'true') {
    return []
  }

  return [clientLogTerminalPlugin()]
}

function clientLogTerminalPlugin(): Plugin {
  return {
    name: 'legioncode-client-log-terminal',
    configureServer(server) {
      server.middlewares.use(CLIENT_LOG_DEV_ENDPOINT, (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('Method Not Allowed')
          return
        }

        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => {
          if (body.length < CLIENT_LOG_MAX_BYTES) {
            body += chunk
          }
        })
        req.on('end', () => {
          const line = sanitizeClientLogLine(body)
          if (line) {
            console.log(`[web/client] ${line}`)
          }
          res.statusCode = 204
          res.end()
        })
        req.on('error', (error) => {
          console.warn('[web/client-log] failed to read client log', error)
          res.statusCode = 400
          res.end()
        })
      })
    },
  }
}

function sanitizeClientLogLine(line: string): string {
  return line.replace(/[\r\n]/g, ' ').slice(0, CLIENT_LOG_MAX_BYTES).trim()
}
