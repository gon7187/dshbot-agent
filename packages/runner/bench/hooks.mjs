// Resolves the repository's `./x.js` specifiers to their TypeScript sources so plain
// Node can run `packages/runner/*.ts` without a build step.
export function resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context)
  } catch (error) {
    if (error && error.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\/.*\.js$/.test(specifier)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context)
    }
    throw error
  }
}
