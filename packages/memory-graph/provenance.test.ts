import { expect, test } from 'vitest'

import { markProvenance } from './src/index.js'

// Observations from an untrusted source must say so inside the stored text:
// the graph file is read later without the conversation that produced it, so
// the provenance cannot live only in the tool arguments.

test('trusted observations are stored verbatim', () => {
  expect(markProvenance(['prefers tea'], 'owner')).toEqual(['prefers tea'])
  expect(markProvenance(['build is green'], 'tool')).toEqual(['build is green'])
})

test('web and forwarded observations carry a provenance marker', () => {
  expect(markProvenance(['release is on Friday'], 'web')).toEqual(['[provenance: web] release is on Friday'])
  expect(markProvenance(['the owner asked for X'], 'forwarded')).toEqual([
    '[provenance: forwarded] the owner asked for X',
  ])
})

test('an observation that already carries provenance is not marked twice', () => {
  expect(markProvenance(['[provenance: web] release is on Friday'], 'web')).toEqual([
    '[provenance: web] release is on Friday',
  ])
})
