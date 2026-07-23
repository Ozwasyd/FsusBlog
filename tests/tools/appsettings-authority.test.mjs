import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkAppsettingsAuthority,
  parseEnvironmentExample,
  parseJsonWithComments,
  validateAppsettingsAuthorityPolicy
} from '../../tools/configuration/check-appsettings-authority.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const policyPath = 'tests/governance/appsettings-authority.json'
const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, policyPath), 'utf8'))

function write(root, relative, content) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function copy(root, relative) {
  write(root, relative, fs.readFileSync(path.join(repositoryRoot, relative)))
}

function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-appsettings-authority-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  copy(root, policyPath)
  for (const relative of Object.values(policy.authorities)) copy(root, relative)
  for (const relative of policy.canonicalTemplateConsumers) copy(root, relative)
  return root
}

test('canonical repository keeps one base, one production overlay, one minimal development example, and one operator template', () => {
  const result = checkAppsettingsAuthority({ root: repositoryRoot, policyFile: policyPath })
  assert.deepEqual(result.errors, [])
  assert.equal(result.developmentLeafCount, 11)
  assert.equal(result.productionSectionCount, 22)
  assert.ok(result.productionEnvironmentKeyCount >= 50)
  assert.equal(result.templateConsumerCount, 15)
})

test('one scan exposes full-copy resurrection, redundant development values, unsafe production values, env drift, and stale consumers', (context) => {
  const root = fixture(context)
  write(root, 'src/backend/appsettings.example.json', '{}\n')
  write(root, 'src/backend/appsettings.Staging.example.json', '{}\n')

  const developmentPath = path.join(root, policy.authorities.developmentExample)
  const development = JSON.parse(fs.readFileSync(developmentPath, 'utf8'))
  development.Fido2.ServerName = 'FsusBlog'
  write(root, policy.authorities.developmentExample, `${JSON.stringify(development, null, 2)}\n`)

  const productionPath = path.join(root, policy.authorities.productionOverlay)
  const productionSource = fs.readFileSync(productionPath, 'utf8')
    .replace('{', '{\n  "ConnectionStrings": { "DefaultConnection": "Host=prod;Password=leaked" },')
    .replace('"SecretKey": ""', '"SecretKey": "leaked"')
  write(root, policy.authorities.productionOverlay, productionSource)

  const envPath = path.join(root, policy.authorities.productionEnvironmentExample)
  const envSource = fs.readFileSync(envPath, 'utf8')
    .replace('DB_PASSWORD=CHANGE_ME_DB_PASSWORD_MIN_32_CHARS', 'DB_PASSWORD=real-password')
    .concat('\nDB_USER=duplicate\n')
  write(root, policy.authorities.productionEnvironmentExample, envSource)

  const consumer = 'tools/deploy-production.sh'
  write(root, consumer, fs.readFileSync(path.join(root, consumer), 'utf8').replaceAll('.env.production.example', '.env.production-template'))

  const result = checkAppsettingsAuthority({ root, policyFile: policyPath })
  assert.ok(result.errors.some((error) => error.includes('retired configuration authority exists: src/backend/appsettings.example.json')))
  assert.ok(result.errors.some((error) => error.includes('ambiguous full appsettings example is forbidden: src/backend/appsettings.Staging.example.json')))
  assert.ok(result.errors.some((error) => error.includes('development example contains an undeclared overlay leaf: Fido2:ServerName')))
  assert.ok(result.errors.some((error) => error.includes('development example redundantly copies the base value: Fido2:ServerName')))
  assert.ok(result.errors.some((error) => error.includes('production overlay contains an undeclared top-level section: ConnectionStrings')))
  assert.ok(result.errors.some((error) => error.includes('production fail-closed leaf must remain an empty placeholder: Jwt:SecretKey')))
  assert.ok(result.errors.some((error) => error.includes('production environment example duplicates key DB_USER')))
  assert.ok(result.errors.some((error) => error.includes('production environment example key must remain a CHANGE_ME placeholder: DB_PASSWORD')))
  assert.ok(result.errors.some((error) => error.includes('production template consumer retains the legacy template name: tools/deploy-production.sh')))
})

test('policy cannot rename authorities, weaken precedence, duplicate declarations, or escape the repository', () => {
  const candidate = structuredClone(policy)
  candidate.authorities.base = 'other.json'
  candidate.precedence.reverse()
  candidate.productionEnvironmentExample.placeholderKeys.push(candidate.productionEnvironmentExample.placeholderKeys[0])
  candidate.canonicalTemplateConsumers.push('../outside')
  const errors = validateAppsettingsAuthorityPolicy(candidate)
  assert.ok(errors.some((error) => error.includes('exact base, production overlay')))
  assert.ok(errors.some((error) => error.includes('configuration precedence must be')))
  assert.ok(errors.some((error) => error.includes('placeholderKeys must contain unique')))
  assert.ok(errors.some((error) => error.includes('unsafe repository path')))
})

test('environment parser rejects malformed, exported, invalid, and duplicate entries together', () => {
  const parsed = parseEnvironmentExample('export SECRET=x\nMISSING\n1BAD=value\nGOOD=first\nGOOD=second\n')
  assert.equal(parsed.entries.get('GOOD'), 'second')
  assert.ok(parsed.errors.some((error) => error.includes('must not use export')))
  assert.ok(parsed.errors.some((error) => error.includes('must be KEY=VALUE')))
  assert.ok(parsed.errors.some((error) => error.includes('invalid key 1BAD')))
  assert.ok(parsed.errors.some((error) => error.includes('duplicates key GOOD')))
})

test('base plus each environment overlay preserves shared contracts while changing only its environment surface', () => {
  const base = parseJsonWithComments(fs.readFileSync(path.join(repositoryRoot, policy.authorities.base), 'utf8'))
  const development = parseJsonWithComments(fs.readFileSync(path.join(repositoryRoot, policy.authorities.developmentExample), 'utf8'))
  const production = parseJsonWithComments(fs.readFileSync(path.join(repositoryRoot, policy.authorities.productionOverlay), 'utf8'))

  assert.equal(base.AnonymousCredentialIssuer.AllowBannedAccountIssuance, false)
  assert.equal(development.fsus.allowLocalAuthFixture, true)
  assert.equal(development.AuthCookies.AllowInsecureTransportCookies, true)
  assert.equal(production.AllowedHosts, 'fsus.blog;www.fsus.blog')
  assert.equal(production.Jwt.SecretKey, '')
  assert.equal(production.Security.Pow.SigningKey, '')
  assert.equal(production.AnonymousIdentity.ZkProd.AllowDevVerifier, false)
})
