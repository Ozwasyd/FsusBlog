import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeRuntimeStateOperations, analyzeRuntimeStepCommand, discoverShellCallNames, discoverStaticModuleSources, validateRuntimeStateDomainCatalog } from '../../tools/test-matrix/runtime-state-domain-catalog.mjs'
import { runtimeSteps } from '../../tools/test/bundles/bundle-steps.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const source = path.join(root, 'config/testing/runtime-state-domain-catalog.json')
function mutate(change) { const dir = mkdtempSync(path.join(tmpdir(), 'runtime-state-')); const data = JSON.parse(readFileSync(source)); change(data); const file = path.join(dir, 'catalog.json'); writeFileSync(file, JSON.stringify(data)); return [dir, file] }
function rejects(change, pattern) { const [dir, file] = mutate(change); try { assert.match(validateRuntimeStateDomainCatalog(file).join('\n'), pattern) } finally { rmSync(dir, {recursive:true,force:true}) } }
test('catalog is bidirectionally exact', () => assert.deepEqual(validateRuntimeStateDomainCatalog(), []))
test('catalog retains the fixed runtime-state audit baseline', () => {
  const catalog = JSON.parse(readFileSync(source))
  assert.equal(catalog.auditBaseline, '3bd957a74a9846567a6f6270c03349b8219d6dc1')
  assert.equal(catalog.implementationBaseline, 'b49320d24ed605ca98c5f24df5f33c1c767b4451')
})
test('rejects omitted and extra steps', () => { rejects((data) => data.steps.pop(), /missing from catalog/); rejects((data) => data.steps.push({stepId:'unknown',stateAccess:'none'}), /extra catalog step/) })
test('rejects unknown, broad and unordered domains', () => { rejects((data) => data.steps.find((x)=>x.stepId==='bootstrap').writes.push('all-runtime-state'), /unknown domain/); rejects((data) => data.steps.find((x)=>x.stepId==='bootstrap').writes.reverse(), /sorted and unique/) })
test('rejects no proof, bad reset and stateful coordination', () => { rejects((data) => data.steps.find((x)=>x.stepId==='bootstrap').evidence=[], /no operation-specific proof/); rejects((data) => data.steps.find((x)=>x.stepId==='runtime-integration').resetBefore=[{producer:'x',postcondition:'x'}], /invalid resetBefore/); rejects((data) => data.steps.find((x)=>x.stepId==='security-join').stateAccess='declared', /coordination-only/) })
test('rejects unverifiable commutative writes', () => rejects((data) => data.steps.find((x)=>x.stepId==='runtime-integration').commutativeWrites=[{domain:'postgres.article'}], /needs verifier/))
test('real runtime commands resolve to catalog evidence rather than step-name guesses', () => {
  for (const step of runtimeSteps().filter((step) => step.resources?.coordinationOnly !== true)) {
    assert.ok(analyzeRuntimeStepCommand(step).sources.length > 0, step.id)
  }
})
test('runtime shell wrappers resolve their sourced call chain', () => {
  const step = runtimeSteps().find((candidate) => candidate.id === 'runtime-integration')
  const analysis = analyzeRuntimeStepCommand(step)
  assert.ok(analysis.sources.includes('tools/test/lanes/_lane-collect-support.sh'))
  assert.ok(analysis.sources.includes('tools/test/lanes/_suite-support.sh'))
  assert.ok(analysis.calledFunctions.includes('RunIntegrationOnly'))
})
test('Node entrypoints resolve repository-relative import chains', () => {
  const analysis = analyzeRuntimeStepCommand({command:'node tools/test-matrix/runtime-state-domain-catalog.mjs'})
  assert.ok(analysis.sources.includes('tools/test/bundles/bundle-steps.mjs'))
})
test('call-chain parsing ignores commented and quoted fake shell calls', () => {
  assert.deepEqual(discoverShellCallNames('# Hidden\n"Hidden"\nReal', ['Hidden','Real']), ['Real'])
})
test('Node import parsing ignores comments and accepts side-effect imports', () => {
  assert.deepEqual(discoverStaticModuleSources('tools/root.mjs', '// import "./fake.mjs"\nimport "./real.mjs"'), ['tools/real.mjs'])
})
test('rejects a forged static analyzer proof', () => rejects((data) => data.steps.find((x)=>x.stepId==='bootstrap').evidence.find((item)=>item.proofKind==='static-analyzer').ruleId='forged.rule', /invalid static analyzer proof/))
test('loaded schema rejects missing fields and additional properties', () => {
  rejects((data) => delete data.auditBaseline, /missing required property auditBaseline/)
  rejects((data) => delete data.steps.find((x)=>x.stepId==='runtime-integration').creates, /must match exactly one schema variant/)
  rejects((data) => data.steps.find((x)=>x.stepId==='runtime-integration').unexpected=true, /must match exactly one schema variant/)
})
test('rejects unexplained multi-operation domains and fake test evidence', () => {
  rejects((data) => data.steps.find((x)=>x.stepId==='bootstrap').operationOverlaps=[], /unexplained operation overlap/)
  rejects((data) => { const proof=data.steps.find((x)=>x.stepId==='release-public-hydration').evidence.find((item)=>item.proofKind==='structured-test'); proof.assertionId='not-a-real-test' }, /invalid structured assertion proof/)
})
test('rejects required predecessors outside runtime ancestry', () => rejects((data) => data.steps.find((x)=>x.stepId==='runtime-integration').requiredPredecessors=['release-public'], /not in its runtime dependency ancestry/))
test('operation analyzer separates create delete invalidate and mutation semantics', () => {
  const findings = analyzeRuntimeStateOperations('mkdir fixture\nrm -rf fixture\nredis-cli SET x y\ninvalidate redis cache')
  assert.deepEqual(findings.map(({operation})=>operation).sort(), ['creates','deletes','invalidates','writes'])
})
test('real repository command mutation cannot bypass state analysis', () => {
  const steps = runtimeSteps().map((step) => step.id === 'runtime-integration' ? {...step, command:'tools/bootstrap-acceptance-env.sh'} : step)
  const errors = validateRuntimeStateDomainCatalog(source, steps).join('\n')
  assert.match(errors, /analyzer detected undeclared/)
})
test('real repository DB plus Redis access fails when either domain is omitted', () => {
  const [dir, file] = mutate((data) => {
    const entry = data.steps.find((candidate) => candidate.stepId === 'bootstrap')
    entry.deletes = entry.deletes.filter((domain) => domain !== 'redis.cache.public')
    entry.operationOverlaps = entry.operationOverlaps.filter((overlap) => overlap.domain !== 'redis.cache.public')
  })
  try {
    assert.match(validateRuntimeStateDomainCatalog(file).join('\n'), /analyzer detected undeclared deletes redis\.cache\.public/)
  } finally {
    rmSync(dir, {recursive:true,force:true})
  }
})
test('real repository operation finding fails when create semantics are omitted', () => {
  const [dir, file] = mutate((data) => {
    const entry = data.steps.find((candidate) => candidate.stepId === 'bootstrap')
    entry.creates = entry.creates.filter((domain) => domain !== 'fixture.runtime-config')
    entry.operationOverlaps = entry.operationOverlaps.filter((overlap) => overlap.domain !== 'fixture.runtime-config')
  })
  try {
    assert.match(validateRuntimeStateDomainCatalog(file).join('\n'), /analyzer detected undeclared creates fixture\.runtime-config/)
  } finally {
    rmSync(dir, {recursive:true,force:true})
  }
})
test('rejects reset producer command and assertion receipt drift', () => {
  rejects((data) => data.steps.find((entry) => entry.stepId === 'runtime-integration').resetBefore[0].producerCommand='tools/false-reset.sh', /producer command mismatch/)
  rejects((data) => data.steps.find((entry) => entry.stepId === 'runtime-integration').resetBefore[0].assertionId='not-a-real-postcondition', /verifier does not own assertion receipt/)
})
test('rejects an extra domain without matching evidence', () => {
  rejects((data) => { const entry=data.steps.find((candidate)=>candidate.stepId==='local-runtime-exposure'); entry.evidence=entry.evidence.filter((item)=>item.operation!=='all'); entry.reads.push('postgres.outbox'); entry.reads.sort() }, /no operation-specific proof for reads postgres\.outbox/)
})
test('mutating a real shell wrapper call chain cannot hide a new delete', () => {
  const wrapper = 'tools/test/lanes/runtime-integration.sh'
  const original = readFileSync(path.join(root, wrapper), 'utf8')
  const sourceOverrides = new Map([
    [wrapper, `${original}\nsource "./runtime-state-mutator.sh"\n`],
    ['tools/test/lanes/runtime-state-mutator.sh', 'redis-cli DEL fsus:public:cache\n']
  ])
  assert.match(validateRuntimeStateDomainCatalog(source, runtimeSteps(), {sourceOverrides}).join('\n'), /runtime-integration analyzer detected undeclared deletes redis\.cache\.public/)
})
test('mutating a real Node import chain cannot hide a new SQL domain', () => {
  const entrypoint = 'tools/security/check-local-runtime-exposure.mjs'
  const original = readFileSync(path.join(root, entrypoint), 'utf8')
  const sourceOverrides = new Map([
    [entrypoint, `${original}\nimport "./runtime-state-mutator.mjs"\n`],
    ['tools/security/runtime-state-mutator.mjs', 'await sql(\"DELETE FROM mutation_outbox\")\n']
  ])
  assert.match(validateRuntimeStateDomainCatalog(source, runtimeSteps(), {sourceOverrides}).join('\n'), /local-runtime-exposure analyzer detected undeclared deletes postgres\.outbox/)
})
test('package scripts resolve relative to package cwd and cannot bypass the catalog', () => {
  const packageFile = 'src/frontend/package.json'
  const packageJson = JSON.parse(readFileSync(path.join(root, packageFile), 'utf8'))
  packageJson.scripts['check:security:csrf-browser-matrix'] = 'node ../../tools/bootstrap-acceptance-env.sh'
  const sourceOverrides = new Map([[packageFile, JSON.stringify(packageJson)]])
  const errors = validateRuntimeStateDomainCatalog(source, runtimeSteps(), {sourceOverrides}).join('\n')
  assert.match(errors, /csrf-matrix analyzer detected undeclared/)
  assert.ok(analyzeRuntimeStepCommand(runtimeSteps().find((step) => step.id === 'csrf-matrix'), {sourceOverrides})
    .sources.includes('tools/bootstrap-acceptance-env.sh'))
})
test('unresolvable and repository-escaping command sources fail closed', () => {
  const original = runtimeSteps()
  const missing = original.map((step) => step.id === 'csrf-matrix'
    ? {...step, command: 'tools/test/lanes/not-a-real-runtime-entry.sh'}
    : step)
  assert.match(validateRuntimeStateDomainCatalog(source, missing).join('\n'), /source resolution failed: repository source is missing/)

  const packageFile = 'src/frontend/package.json'
  const packageJson = JSON.parse(readFileSync(path.join(root, packageFile), 'utf8'))
  packageJson.scripts['check:security:csrf-browser-matrix'] = 'node ../../../outside-runtime-entry.mjs'
  const errors = validateRuntimeStateDomainCatalog(source, original, {
    sourceOverrides: new Map([[packageFile, JSON.stringify(packageJson)]])
  }).join('\n')
  assert.match(errors, /source resolution failed: .*escapes repository/)

  packageJson.scripts['check:security:csrf-browser-matrix'] = 'redis-cli FLUSHDB'
  const unresolvable = validateRuntimeStateDomainCatalog(source, original, {
    sourceOverrides: new Map([[packageFile, JSON.stringify(packageJson)]])
  }).join('\n')
  assert.match(unresolvable, /package script has no resolvable repository entry/)
})
