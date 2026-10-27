// Git's `--directory` collapses a wholly ignored directory into one entry, so
// the risk rule has to look inside it when a footprint touches that entry. The
// scan is limited to the intersection: the whole ignored directory for an
// ancestor footprint, or the footprint subtree for a path inside it. A failed
// or oversized listing is high risk instead of a silent `low`.

import { expect, test } from 'vitest'

import { assessFactoryRisk, type FactoryRiskInput } from './src/index.js'

const BASE: Omit<FactoryRiskInput, 'footprint' | 'ignoredDirectories' | 'scanIgnoredDirectory'> = {
  body: 'Поправить подпись кнопки поиска',
  modelRisk: 'low',
  projectRoot: '/srv/project',
  projectPaths: ['src/search.ts', 'config/'],
}

test('a footprint on a collapsed ignored directory scans that directory', () => {
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['config/'],
    ignoredDirectories: ['config/'],
    scanIgnoredDirectory: () => ['config/secrets.json'],
  })
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/секреты/)
})

test('a footprint inside an ignored directory scans only its own subtree', () => {
  const scanned: string[] = []
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['config/public/'],
    ignoredDirectories: ['config/'],
    scanIgnoredDirectory: (directory) => {
      scanned.push(directory)
      return ['config/public/notes.md']
    },
  })
  expect(scanned).toEqual(['config/public'])
  expect(assessment).toEqual({ risk: 'low' })
})

test('a non-root ancestor of an ignored directory scans the collapsed directory', () => {
  const scanned: string[] = []
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['bundle/'],
    ignoredDirectories: ['bundle/config/'],
    scanIgnoredDirectory: (directory) => {
      scanned.push(directory)
      return ['bundle/config/secrets.json']
    },
  })
  expect(scanned).toEqual(['bundle/config'])
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/секреты/)
})

test('a footprint that misses every ignored directory does not scan anything', () => {
  let calls = 0
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['src/'],
    ignoredDirectories: ['config/', 'node_modules/'],
    scanIgnoredDirectory: () => {
      calls += 1
      return []
    },
  })
  expect(assessment).toEqual({ risk: 'low' })
  expect(calls).toBe(0)
})

test('the project root is already risky and never scans ignored directories', () => {
  let calls = 0
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['.'],
    ignoredDirectories: ['node_modules/'],
    scanIgnoredDirectory: () => {
      calls += 1
      return []
    },
  })
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/миграции, workflow, \.env, секреты/)
  expect(calls).toBe(0)
})

test('a failed listing of a touched ignored directory is high with the reason', () => {
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['config/'],
    ignoredDirectories: ['config/'],
    scanIgnoredDirectory: () => undefined,
  })
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/перечислить/)
  expect(assessment.reason).toMatch(/config/)
})

test('a listing over the budget is high with the reason', () => {
  const assessment = assessFactoryRisk({
    ...BASE,
    footprint: ['config/'],
    ignoredDirectories: ['config/'],
    ignoredScanLimit: 1,
    scanIgnoredDirectory: () => ['config/a.txt', 'config/b.txt'],
  })
  expect(assessment.risk).toBe('high')
  expect(assessment.reason).toMatch(/предел/)
})
