import { sandboxedTests, type SandboxOptions } from '../../evolve/src/index.js'

// Only the host delivery service launches this entry; candidate code runs in bwrap.
let input = ''
for await (const chunk of process.stdin) {
  input += String(chunk)
  if (Buffer.byteLength(input) > 64 * 1024) throw new Error('gate input is too large')
}
const result = await sandboxedTests(JSON.parse(input) as SandboxOptions)
process.stdout.write(JSON.stringify({ ...result, output: result.output.slice(-256 * 1024) }))
