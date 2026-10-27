// `npm start` entry point: build the daemon from the environment and keep it alive
// until SIGTERM/SIGINT, then drain and exit with the same code.

import { DEFAULT_DREAM_AT } from '../../consciousness/src/index.js'
import { DEFAULT_BACKUP_AT } from './backup.js'
import {
  ConfigError,
  CONFIG_EXIT_CODE,
  readEnvConfig,
  scrubSecrets,
  startDshbot,
  type Dshbot,
} from './index.js'

/** Last-resort exit of a stopping daemon; the unit's TimeoutStopSec is 15 s. */
const STOP_FAILSAFE_MS = 9_000

function fatal(error: unknown, code: number): never {
  const detail = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
  process.stderr.write(`[dshbot] fatal: ${scrubSecrets(detail)}\n`)
  process.exit(code)
}

async function main(): Promise<void> {
  // A configuration error is permanent: systemd must keep the unit down rather
  // than restart it into the same failure (exit 78 is in RestartPreventExitStatus).
  const env = (() => {
    try {
      return readEnvConfig(process.env)
    } catch (error) {
      fatal(error, error instanceof ConfigError ? CONFIG_EXIT_CODE : 1)
    }
  })()
  // The service entry point is the one place that switches the night
  // consolidation on by default: a bare `startDshbot` config without `dream`
  // never starts a night turn. `DSHBOT_DREAM_AT` changes the time, `off` is the
  // operator's explicit opt-out; `/dream on|off` of the owner is a separate,
  // persisted switch.
  const { dreamAt, backupAt, backupKeep, ...config } = env

  let daemon: Dshbot | undefined
  let signalReceived = false
  const onSignal = (): void => {
    signalReceived = true
    // Even a stop that is stuck inside a child process or a model stream ends
    // with a clean exit inside the service timeout.
    setTimeout(() => process.exit(0), STOP_FAILSAFE_MS)
    void daemon?.stop(0)
  }
  // Installed before startup: a SIGTERM during the start is still a clean stop.
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  daemon = await startDshbot({
    ...config,
    ...(dreamAt === 'off' ? {} : { dream: { at: dreamAt ?? DEFAULT_DREAM_AT } }),
    // The daily snapshot is on by default too: `DSHBOT_BACKUP_AT` moves it,
    // `DSHBOT_BACKUP_KEEP` bounds the disk use. `/backup` works without it.
    backup: {
      at: backupAt ?? DEFAULT_BACKUP_AT,
      ...(backupKeep === undefined ? {} : { keep: backupKeep }),
    },
  })

  if (signalReceived) void daemon.stop(0)
  const code = await daemon.stopped
  process.exit(code)
}

main().catch((error: unknown) => {
  fatal(error, error instanceof ConfigError ? CONFIG_EXIT_CODE : 1)
})
