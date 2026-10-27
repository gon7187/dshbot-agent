import { readFileSync } from 'node:fs'
import { createScanner, SyntaxKind } from 'typescript/unstable/ast'
import { expect, test } from 'vitest'

// These are contracts of the test harnesses themselves. Inspect executable
// tokens (comments and string contents cannot masquerade as awaited calls).
// Do not execute/import the other test files and register their tests twice.
interface Token {
  kind: SyntaxKind
  text: string
  value: string
}

function tokensOf(source: string): Token[] {
  const scanner = createScanner(true, undefined, source)
  const tokens: Token[] = []
  const templateDepths: number[] = []
  const expressionStarts = new Set([
    SyntaxKind.EqualsToken, SyntaxKind.OpenParenToken, SyntaxKind.CommaToken,
    SyntaxKind.ColonToken, SyntaxKind.ReturnKeyword, SyntaxKind.EqualsGreaterThanToken,
  ])
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.SlashToken && expressionStarts.has(tokens.at(-1)?.kind ?? SyntaxKind.Unknown)) {
      kind = scanner.reScanSlashToken()
    }
    if (kind === SyntaxKind.TemplateHead) templateDepths.push(0)
    else if (kind === SyntaxKind.OpenBraceToken && templateDepths.length > 0) {
      templateDepths[templateDepths.length - 1] += 1
    } else if (kind === SyntaxKind.CloseBraceToken && templateDepths.length > 0) {
      if (templateDepths.at(-1) === 0) {
        kind = scanner.reScanTemplateToken(false)
        if (kind === SyntaxKind.TemplateTail) templateDepths.pop()
      } else templateDepths[templateDepths.length - 1] -= 1
    }
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() })
  }
  return tokens
}

function inside(tokens: Token[], start: number, open: SyntaxKind, close: SyntaxKind): Token[] {
  let depth = 0
  for (let end = start; end < tokens.length; end += 1) {
    if (tokens[end].kind === open) depth += 1
    if (tokens[end].kind === close && --depth === 0) return tokens.slice(start + 1, end)
  }
  return []
}

function functionsIn(tokens: Token[]): Map<string, Token[]> {
  const functions = new Map<string, Token[]>()
  for (let at = 0; at < tokens.length; at += 1) {
    if (tokens[at].kind !== SyntaxKind.FunctionKeyword || tokens[at + 1]?.kind !== SyntaxKind.Identifier) continue
    const paramsAt = tokens.findIndex((token, index) => index > at && token.kind === SyntaxKind.OpenParenToken)
    if (paramsAt < 0) continue
    const params = inside(tokens, paramsAt, SyntaxKind.OpenParenToken, SyntaxKind.CloseParenToken)
    const bodyAt = tokens.findIndex((token, index) => index > paramsAt + params.length + 1 && token.kind === SyntaxKind.OpenBraceToken)
    if (bodyAt >= 0) functions.set(tokens[at + 1].text, inside(tokens, bodyAt, SyntaxKind.OpenBraceToken, SyntaxKind.CloseBraceToken))
  }
  return functions
}

function awaitedCalls(tokens: Token[]): string[] {
  return tokens.flatMap((token, index) =>
    token.kind === SyntaxKind.AwaitKeyword && tokens[index + 1]?.kind === SyntaxKind.Identifier &&
      tokens[index + 2]?.kind === SyntaxKind.OpenParenToken ? [tokens[index + 1].text] : [])
}

function reachableWaits(body: Token[], functions: Map<string, Token[]>): { names: string[]; tokens: Token[] } {
  const names = new Set<string>()
  const reachable = [...body]
  const visit = (current: Token[]): void => {
    for (const name of awaitedCalls(current)) {
      if (names.has(name)) continue
      names.add(name)
      // A polling primitive's internal retry sleep is not a quiet window.
      if (name === 'waitFor' || name === 'sleep') continue
      const next = functions.get(name)
      if (next) {
        reachable.push(...next)
        visit(next)
      }
    }
  }
  visit(body)
  return { names: [...names], tokens: reachable }
}

function sourceTokens(name: string): Token[] {
  return tokensOf(readFileSync(new URL(name, import.meta.url), 'utf8'))
}

const quietWaits = new Set(['quiet', 'settle', 'quietFor'])

test.each([
  ['./test-support/wake-harness.ts', 'ownerTurn'],
])('test_h1_owner_turn_helper_keeps_its_event_barrier_%s_%s', (file, helper) => {
  const functions = functionsIn(sourceTokens(file))
  const body = functions.get(helper)
  expect(body, `the owner turn helper ${helper} is present in ${file}`).toBeDefined()
  const waits = reachableWaits(body ?? [], functions)
  expect(waits.names.filter((name) => quietWaits.has(name) || name === 'sleep'),
    'a completed owner turn needs no quiet window or fixed sleep').toEqual([])
  expect(waits.names, 'the helper waits for delivery completion before returning its answer').toContain('waitForTurnComplete')
})

test('test_h1_group_no_reply_barrier_cannot_use_the_next_poll_as_processing_completion', () => {
  const tokens = sourceTokens('./group-mention.test.ts')
  const functions = functionsIn(tokens)
  const groupSay = functions.get('groupSay')
  expect(groupSay, 'the existing group conversation helper remains exercised by its tests').toBeDefined()
  const waits = reachableWaits(groupSay ?? [], functions)
  const fallback = waits.names.some((name) => quietWaits.has(name))
  expect(waits.names.length, 'groupSay awaits processing rather than only queuing the update').toBeGreaterThan(0)
  expect(fallback || !waits.tokens.some((token) => token.kind === SyntaxKind.Identifier && token.text === 'polls'),
    'a growing polls counter only acknowledges ingress; await this update completion or retain the quiet fallback').toBe(true)
})
