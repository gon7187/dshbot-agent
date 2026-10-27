#!/usr/bin/env node
// `scripts/dshbot-migrate <источник> [флаги]`: the public command.
//
// The source adapters and the planner live in this package; this file only
// reads the flags, keeps the defaults of the daemon and chooses the exit code.

import { resolve } from 'node:path'

import { defaultEnvFile, defaultHome, maskedFailure, run, type Options } from './run.js'

const USAGE = `использование: scripts/dshbot-migrate <источник> [флаги]

Источники:
  openclaw            ключи, Telegram (токен и владелец), MCP и личность (SOUL.md)
  hermes              ключи, Telegram, MCP, навыки, память и расписания

Флаги:
  --from <каталог>     каталог состояния источника (по умолчанию автопоиск)
  --profile <имя>      профиль Hermes: <каталог>/profiles/<имя>
  --home <каталог>     DSHBOT_HOME (по умолчанию $DSHBOT_HOME или ~/.local/share/dshbot)
  --env-file <путь>    файл окружения демона (по умолчанию ~/.config/dshbot/dshbot.env)
  --dry-run            только план, ничего не записывать
  --yes                применить без вопроса
  --include-secrets    переносить секреты (иначе только имена в отчёте)
  --overwrite          заменять уже существующие значения
  --skill-conflict <режим>  что делать с навыком, имя которого занято:
                       skip (по умолчанию), rename или overwrite
  --json               машинный вывод одним JSON-документом
  --help               эта справка`

interface Parsed {
  readonly source?: string
  readonly options: Partial<Options>
  readonly help: boolean
  readonly error?: string
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): Parsed {
  let source: string | undefined
  let from: string | undefined
  let profile: string | undefined
  let home: string | undefined
  let envFile: string | undefined
  let dryRun = false
  let yes = false
  let includeSecrets = false
  let overwrite = false
  let skillConflict: 'skip' | 'rename' | 'overwrite' = 'skip'
  let json = false
  let help = false

  const valueOf = (arg: string, name: string, index: number): { value?: string; next: number; error?: string } => {
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1)
      return value === '' ? { error: `${name} требует значение`, next: index + 1 } : { value, next: index + 1 }
    }
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('-')) return { error: `${name} требует значение`, next: index + 1 }
    return { value, next: index + 2 }
  }

  for (let index = 0; index < argv.length; ) {
    const arg = argv[index] as string
    if (arg === '--help' || arg === '-h') {
      help = true
      index += 1
      continue
    }
    if (arg === '--from' || arg.startsWith('--from=')) {
      const parsed = valueOf(arg, '--from', index)
      if (parsed.error !== undefined) return { options: {}, help: false, error: parsed.error }
      from = parsed.value
      index = parsed.next
      continue
    }
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const parsed = valueOf(arg, '--profile', index)
      if (parsed.error !== undefined) return { options: {}, help: false, error: parsed.error }
      profile = parsed.value
      index = parsed.next
      continue
    }
    if (arg === '--home' || arg.startsWith('--home=')) {
      const parsed = valueOf(arg, '--home', index)
      if (parsed.error !== undefined) return { options: {}, help: false, error: parsed.error }
      home = parsed.value
      index = parsed.next
      continue
    }
    if (arg === '--env-file' || arg.startsWith('--env-file=')) {
      const parsed = valueOf(arg, '--env-file', index)
      if (parsed.error !== undefined) return { options: {}, help: false, error: parsed.error }
      envFile = parsed.value
      index = parsed.next
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      index += 1
      continue
    }
    if (arg === '--yes' || arg === '-y') {
      yes = true
      index += 1
      continue
    }
    if (arg === '--include-secrets') {
      includeSecrets = true
      index += 1
      continue
    }
    if (arg === '--overwrite') {
      overwrite = true
      index += 1
      continue
    }
    if (arg === '--skill-conflict' || arg.startsWith('--skill-conflict=')) {
      const parsed = valueOf(arg, '--skill-conflict', index)
      if (parsed.error !== undefined) return { options: {}, help: false, error: parsed.error }
      if (parsed.value !== 'skip' && parsed.value !== 'rename' && parsed.value !== 'overwrite') {
        return { options: {}, help: false, error: '--skill-conflict принимает skip, rename или overwrite' }
      }
      skillConflict = parsed.value
      index = parsed.next
      continue
    }
    if (arg === '--json') {
      json = true
      index += 1
      continue
    }
    if (arg.startsWith('-')) return { options: {}, help: false, error: `неизвестная опция ${arg}` }
    if (source !== undefined) return { options: {}, help: false, error: `лишний аргумент ${arg}` }
    source = arg
    index += 1
  }

  return {
    ...(source === undefined ? {} : { source }),
    help,
    options: {
      ...(from === undefined ? {} : { from }),
      ...(profile === undefined ? {} : { profile }),
      home: resolve(home === undefined ? defaultHome(env) : home),
      envFile: resolve(envFile === undefined ? defaultEnvFile() : envFile),
      dryRun,
      yes,
      includeSecrets,
      overwrite,
      skillConflict,
      json,
    },
  }
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2), process.env)
  if (parsed.help) {
    process.stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error !== undefined) {
    process.stderr.write(`dshbot-migrate: ${parsed.error}\n${USAGE}\n`)
    return 2
  }
  if (parsed.source === undefined) {
    process.stderr.write(`dshbot-migrate: не указан источник\n${USAGE}\n`)
    return 2
  }
  if (parsed.source !== 'openclaw' && parsed.source !== 'hermes') {
    process.stderr.write(`dshbot-migrate: источник «${parsed.source}» пока не поддерживается; доступны openclaw и hermes\n`)
    return 2
  }
  return run({ ...(parsed.options as Options), sourceName: parsed.source })
}

// The last line of defence: an unexpected error gets the same masking of
// secret values as every other message and no stack trace.
try {
  process.exitCode = main()
} catch (error) {
  process.stderr.write(`dshbot-migrate: ошибка миграции: ${maskedFailure(error)}\n`)
  process.exitCode = 1
}
