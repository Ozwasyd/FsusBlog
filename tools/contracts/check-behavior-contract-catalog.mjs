import { execFileSync } from 'node:child_process'
import { loadCatalog, root, validateBehaviorReferences } from './behavior-contract-catalog.mjs'

const catalog = loadCatalog()
validateBehaviorReferences(catalog)
execFileSync('node', ['tools/contracts/generate-behavior-contract-catalog.mjs', '--check'], { cwd: root, stdio: 'inherit' })
console.log('[behavior-contract-catalog] authority, references, and generated projections are in sync')
