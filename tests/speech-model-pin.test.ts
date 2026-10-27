import { readdirSync, readFileSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// The speech model is pinned in the code, not in a manifest next to the files and not in a digest of the server:
// a revision of the export, the size and the SHA-256 of each file. The values were checked by the owner outside the
// sandbox (the encoder was downloaded and compared).
const root = fileURLToPath(new URL('..', import.meta.url))

const REPOSITORY = 'csukuangfj/sherpa-onnx-whisper-small'
const REVISION = '8f3c18b358db4d1f2fc1eae49d75cd20989e4309'
const PINNED: Array<{ name: string; size: string; sha256: string }> = [
  {
    name: 'small-encoder.int8.onnx',
    size: '112442483',
    sha256: '4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9',
  },
  {
    name: 'small-decoder.int8.onnx',
    size: '262226114',
    sha256: 'acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee',
  },
  {
    name: 'small-tokens.txt',
    size: '816730',
    sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126',
  },
]

const SOURCE_FILE = /\.(?:ts|mts|mjs|js)$/
const TEST_FILE = /\.test\.[a-z]+$/

function sources(dir: string): string[] {
  const found: string[] = []
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) found.push(...sources(full))
    else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) found.push(full)
  }
  return found
}

/** The code that may hold the pin, with the digit separators of numeric literals removed. */
function codeText(): { text: string; voiceFiles: string[] } {
  const voiceFiles = sources(join(root, 'packages', 'voice'))
  const files = [...voiceFiles, ...sources(join(root, 'packages', 'app', 'src'))]
  const text = files.map((file) => readFileSync(file, 'utf8')).join('\n').replace(/(?<=\d)_(?=\d)/g, '')
  return { text, voiceFiles }
}

test('test_model_the_revision_the_sizes_and_the_hashes_of_the_three_files_are_constants_in_the_code', () => {
  const { text, voiceFiles } = codeText()
  expect(voiceFiles.length, 'the recognition lives in packages/voice').toBeGreaterThan(0)

  expect(text).toContain(REPOSITORY)
  expect(text, 'the pinned revision of the export').toContain(REVISION)
  expect(text, 'the download goes by the revision, never by the moving main').not.toMatch(/resolve\/main|revision=main/)
  expect(text, 'the models live in DSHBOT_HOME/models').toMatch(/['"`/]models['"`/]/)
  expect(text, 'the files are checked with SHA-256').toMatch(/sha-?256/i)
  for (const file of PINNED) {
    expect(text, `${file.name} is named`).toContain(file.name)
    expect(text, `size of ${file.name}`).toContain(file.size)
    expect(text, `SHA-256 of ${file.name}`).toContain(file.sha256)
  }
})
