import { createRequire } from 'node:module'

export const requireWebPackage = createRequire(new URL('../../src/Web/package.json', import.meta.url))
