// Atomic file replacement shared by the entry store and the identity file.
//
// The bytes go to a temporary file in the same directory, are fsynced, and only
// then rename over the target. A failure leaves the target untouched and removes
// the temporary file.

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Replaces `filePath` atomically with `content`.
 *
 * A failure anywhere before the rename leaves the previous file untouched and
 * removes the temporary file; the original error is rethrown.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  const directory = dirname(filePath)
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  )
  const bytes = Buffer.from(content, 'utf8')
  let fd: number | undefined

  try {
    fd = openSync(tempPath, 'wx', 0o666)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written <= 0) {
        throw new Error(`short write while saving ${basename(filePath)}`)
      }
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tempPath, filePath)

    // Make the rename itself durable. Directory fsync is not supported on
    // every platform, so a failure here must not fail an already-saved file.
    try {
      const directoryFd = openSync(directory, 'r')
      try {
        fsyncSync(directoryFd)
      } finally {
        closeSync(directoryFd)
      }
    } catch {
      // Best effort only.
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The original error is more useful than a close failure.
      }
    }
    try {
      unlinkSync(tempPath)
    } catch {
      // The temporary file may not exist if the write never started.
    }
    throw error
  }
}
