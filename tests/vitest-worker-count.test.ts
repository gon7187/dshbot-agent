import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const machine = vi.hoisted(() => ({ cores: 8, load: [0, 0, 0] as number[] }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const availableParallelism = (): number => machine.cores
  const loadavg = (): number[] => [...machine.load]
  return {
    ...actual,
    availableParallelism,
    loadavg,
    default: { ...actual, availableParallelism, loadavg },
  }
})

const saved = process.env.DSHBOT_TEST_WORKERS

function setMachine(cores: number, load: number): void {
  machine.cores = cores
  machine.load = [load, load, load]
}

async function workers(): Promise<unknown> {
  vi.resetModules()
  const mod = await import('../vitest.config.js')
  const config = mod.default as { test?: { maxWorkers?: unknown } }
  return config.test?.maxWorkers
}

beforeEach(() => {
  delete process.env.DSHBOT_TEST_WORKERS
  setMachine(8, 0)
})

afterEach(() => {
  if (saved === undefined) delete process.env.DSHBOT_TEST_WORKERS
  else process.env.DSHBOT_TEST_WORKERS = saved
})

describe('vitest worker count', () => {
  test('test_c1_idle_machine_gets_two_workers_per_core', async () => {
    setMachine(8, 0)
    expect(await workers()).toBe(16)
    setMachine(4, 0)
    expect(await workers()).toBe(8)
  })

  test('test_c1_loaded_machine_gets_fewer_workers_but_at_least_one', async () => {
    setMachine(8, 0)
    const idle = (await workers()) as number
    setMachine(8, 16)
    const loaded = (await workers()) as number
    expect(loaded).toBeLessThan(idle)
    expect(loaded).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(loaded)).toBe(true)

    setMachine(8, 8000)
    const swamped = (await workers()) as number
    expect(swamped).toBeLessThanOrEqual(loaded)
    expect(swamped).toBe(1)
  })

  test('test_c1_single_core_never_drops_below_one_worker', async () => {
    setMachine(1, 50)
    expect(await workers()).toBe(1)
  })

  test('test_c2_explicit_positive_integer_sets_worker_count', async () => {
    setMachine(8, 0)
    process.env.DSHBOT_TEST_WORKERS = '3'
    expect(await workers()).toBe(3)
    process.env.DSHBOT_TEST_WORKERS = '1'
    expect(await workers()).toBe(1)
    process.env.DSHBOT_TEST_WORKERS = '40'
    expect(await workers()).toBe(40)
    setMachine(8, 8000)
    process.env.DSHBOT_TEST_WORKERS = '5'
    expect(await workers()).toBe(5)
  })

  test('test_c2_invalid_values_fall_back_to_cores_and_load', async () => {
    const invalid = ['', '0', '-2', '1.5', 'abc', '4abc']
    for (const [cores, load] of [
      [8, 0],
      [8, 16],
    ] as const) {
      setMachine(cores, load)
      delete process.env.DSHBOT_TEST_WORKERS
      const expected = await workers()
      expect(expected).toBeGreaterThanOrEqual(1)
      for (const value of invalid) {
        process.env.DSHBOT_TEST_WORKERS = value
        expect(await workers(), `DSHBOT_TEST_WORKERS=${JSON.stringify(value)} load=${load}`).toBe(expected)
      }
    }
  })
})
