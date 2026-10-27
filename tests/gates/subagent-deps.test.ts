import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

// Wiring of the delegation tool, which the end-to-end stub test cannot state
// by itself: the tool is registered as a lazy owner tool, it is never opted
// into the guest schema, its child runs on the flash model, and the runner
// keeps the forbidden capabilities out of the child schema.
const root = fileURLToPath(new URL('../..', import.meta.url))

function text(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

test('test_gate_delegate_is_a_lazy_owner_tool_with_a_flash_child_and_no_guest_access', () => {
  const tool = text('packages/tools-subagent/src/index.ts')
  expect(tool).toMatch(/name:\s*DELEGATE_TOOL_NAME/)
  expect(tool).toMatch(/export const DELEGATE_TOOL_NAME\s*=\s*'delegate'/)
  expect(tool).toMatch(/lazy:\s*true/)
  // No guest opt-in: the seam is default-deny, and this tool must stay there.
  expect(tool).not.toMatch(/guestAllowed/)

  const app = text('packages/app/src/index.ts')
  expect(app).toMatch(/createDelegateTool/)
  // Registered in the owner tool array of the runner, not in a separate path.
  expect(app).toMatch(/tools\.push\(\s*createDelegateTool/)

  const runner = text('packages/runner/src/index.ts')
  expect(runner).toMatch(/export const CHILD_MODEL\s*=\s*'deepseek-flash'/)
  expect(runner).toMatch(/runChild\s*\(/)
  for (const name of ['delegate', 'task', 'schedule', 'zavod', 'tool_search']) {
    expect(runner).toContain(`'${name}'`)
  }
})
