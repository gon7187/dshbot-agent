import { expect, test } from 'vitest'
import { createWakeScheduler, type WakeScheduleStorage, type WakeTurnOutcome } from './src/index.js'

// The owning timer seam runs without a daemon, provider or real-time wait.
function manualClock() {
  let time = 0
  let sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimer(callback: () => void, delay: number): unknown { const id = ++sequence; timers.set(id, { at: time + delay, callback }); return id },
    clearTimer(handle: unknown) { timers.delete(handle as number) },
    pending: () => timers.size,
    async advance(ms: number) {
      time += ms
      for (const [id, t] of [...timers]) if (t.at <= time) { timers.delete(id); t.callback() }
      for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve))
    },
  }
}

test('W-RECOVERY restores the deadline, backs off without overlap and cannot rearm after stop', async () => {
  const clock = manualClock()
  const minute = 60_000
  let stored: string | undefined
  const storage: WakeScheduleStorage = { read: () => stored, write: value => { stored = value } }
  let turns = 0
  let finish!: (outcome: WakeTurnOutcome) => void
  const options = { ...clock, storage, jitter: 0, intervalMinutes: 15,
    runTurn: () => { turns++; return new Promise<WakeTurnOutcome>(resolve => { finish = resolve }) } }
  const first = createWakeScheduler(options)
  first.start()
  const due = first.nextWakeAt()
  await clock.advance(5 * minute)
  first.stop()
  const restarted = createWakeScheduler(options)
  restarted.start()
  expect(restarted.nextWakeAt()).toBe(due)
  await clock.advance(10 * minute)
  expect(turns).toBe(1)
  expect(clock.pending()).toBe(0)
  await clock.advance(30 * minute)
  expect(turns).toBe(1)
  finish('failed')
  await clock.advance(0)
  expect(restarted.intervalMinutes()).toBe(30)
  expect(restarted.nextWakeAt()).toBe(clock.now() + 30 * minute)
  await clock.advance(30 * minute)
  expect(turns).toBe(2)
  restarted.stop()
  finish('ok')
  await clock.advance(60 * minute)
  expect(turns).toBe(2)
  expect(clock.pending()).toBe(0)
})
