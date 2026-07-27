import { execFileSync } from 'node:child_process'
import { loadCatalog, root, validateBehaviorReferences } from './behavior-contract-catalog.mjs'
import { assertBehaviorOwnerBindings } from './behavior-owner-binding.mjs'

const catalog = loadCatalog()
validateBehaviorReferences(catalog)
assertBehaviorOwnerBindings({ repositoryRoot: root, catalog })
execFileSync('node', ['tools/contracts/generate-behavior-contract-catalog.mjs', '--check'], { cwd: root, stdio: 'inherit' })
console.log('[behavior-contract-catalog] authority, owner bindings, references, and generated projections are in sync')
