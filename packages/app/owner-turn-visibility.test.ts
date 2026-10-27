// `/usage on` footer of an owner turn with the promised-work nudge: the nudge is a second model call of the same
// owner turn, and each call enters the sum exactly once. A nudge that finishes adds the usage of its own outcome;
// a nudge that fails adds only what it paid for before the failure (carried on the runner's TurnFailedError) and
// never the usage of the first call again; any other error adds nothing. The footer is built from that sum.

import { expect, test } from 'vitest'

import { TurnFailedError, usageOfFailedTurn, type TurnOutcome, type TurnUsageEvent } from '../runner/src/index.js'
import { turnFooterText, withFollowUpUsage } from './src/usage.js'

const MODEL = 'deepseek-flash'

function usage(input: number, cacheRead: number, output: number): TurnUsageEvent {
  return { sessionId: 'main', principal: 'owner', model: MODEL, inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: 0, outputTokens: output }
}

const FIRST = usage(1000, 300, 200)

function tokensOf(value: TurnUsageEvent | undefined): number[] | undefined {
  return value === undefined ? undefined : [value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.outputTokens]
}

test('a nudge that fails before any model call adds nothing: the first call is not counted twice', async () => {
  const result = await withFollowUpUsage<TurnOutcome, TurnUsageEvent>(
    FIRST,
    async () => {
      throw new TurnFailedError('ход завершился ошибкой', undefined)
    },
    usageOfFailedTurn,
  )
  expect(result.outcome).toBeUndefined()
  expect(result.error).toBeInstanceOf(TurnFailedError)
  expect(tokensOf(result.usage)).toEqual([1000, 300, 0, 200])
  expect(turnFooterText(result.usage!)).toBe(turnFooterText(FIRST))
})

test('a nudge that fails with an error other than a failed turn adds nothing', async () => {
  const result = await withFollowUpUsage<TurnOutcome, TurnUsageEvent>(
    FIRST,
    async () => {
      throw new Error('runner is gone')
    },
    usageOfFailedTurn,
  )
  expect(tokensOf(result.usage)).toEqual([1000, 300, 0, 200])
})

test('a nudge that fails after a paid call adds only what it paid for', async () => {
  const result = await withFollowUpUsage<TurnOutcome, TurnUsageEvent>(
    FIRST,
    async () => {
      throw new TurnFailedError('ход завершился ошибкой', usage(40, 7, 3))
    },
    usageOfFailedTurn,
  )
  expect(tokensOf(result.usage)).toEqual([1040, 307, 0, 203])
})

test('a nudge that finishes adds the usage of its own outcome once and hands the outcome back', async () => {
  const result = await withFollowUpUsage<TurnOutcome, TurnUsageEvent>(
    FIRST,
    async () => ({ text: 'готово', usage: usage(50, 20, 10) }),
    usageOfFailedTurn,
  )
  expect(result.outcome?.text).toBe('готово')
  expect(tokensOf(result.usage)).toEqual([1050, 320, 0, 210])
})

test('a nudge without completed model calls keeps the sum, and a first turn without usage takes the nudge alone', async () => {
  const stopped = await withFollowUpUsage<TurnOutcome, TurnUsageEvent>(FIRST, async () => ({ text: '', aborted: 'stop' }), usageOfFailedTurn)
  expect(tokensOf(stopped.usage)).toEqual([1000, 300, 0, 200])
  const alone = await withFollowUpUsage<TurnOutcome, TurnUsageEvent>(undefined, async () => ({ text: 'x', usage: usage(5, 1, 2) }), usageOfFailedTurn)
  expect(tokensOf(alone.usage)).toEqual([5, 1, 0, 2])
})
