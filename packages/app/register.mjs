// Resolves the repository's `./x.js` specifiers to their TypeScript sources so plain
// Node can run `packages/app/src/*.ts` without a build step (the same trick as
// packages/runner/bench/register.mjs).
import { enableCompileCache, registerHooks } from 'node:module'

// The bot and every child daemon of the tests load this file before the app's module graph, so the
// compile cache halves their cold start. Node takes the directory from NODE_COMPILE_CACHE when it is
// set and otherwise uses one shared directory in the system temp directory (the same for every HOME).
// An unusable directory only costs speed: startup must never fail because of the cache.
try {
  enableCompileCache()
} catch {
  // Compile cache is an optimization; start without it.
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (error && error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\/.*\.js$/.test(specifier)) {
        return nextResolve(specifier.slice(0, -3) + '.ts', context)
      }
      throw error
    }
  },
})
