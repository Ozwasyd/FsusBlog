#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const errors = []

function read(path) {
  try {
    return readFileSync(resolve(root, path), 'utf8')
  } catch {
    errors.push(`missing ${path}`)
    return ''
  }
}

function includes(path, source, token) {
  if (!source.includes(token)) {
    errors.push(`${path} missing ${token}`)
  }
}

const files = {
  readme: read('README.md'),
  development: read('docs/development.md'),
  demoData: read('docs/development/demo-data.md'),
  troubleshooting: read('docs/troubleshooting.md'),
  start: read('tools/dev/start.sh'),
  seed: read('tools/dev/seed-demo-data.sh'),
  seedSql: read('tools/dev/demo-seed.sql'),
  compose: read('ops/development/dependencies.compose.yml'),
  env: read('.env.example'),
  appsettingsDev: read('src/backend/appsettings.Development.example.json'),
  appsettingsBase: read('src/backend/appsettings.json'),
  appsettingsProduction: read('src/backend/appsettings.Production.json'),
  envProduction: read('.env.production.example'),
  configurationAuthority: read('docs/configuration/appsettings-authority.md')
}

for (const token of [
  './tools/dev/start.sh --seed-demo',
  'http://127.0.0.1:3000',
  'demo-admin',
  'docs/troubleshooting.md',
  'docs/known-limitations.md'
]) {
  includes('README.md', files.readme, token)
}

for (const token of [
  'PostgreSQL',
  'Redis',
  'backend',
  'frontend',
  '--seed-demo',
  'ops/development/dependencies.compose.yml'
]) {
  includes('tools/dev/start.sh', files.start, token)
}

for (const token of [
  'demo-admin',
  'demo-reader',
  'anonymous_account',
  'admin_principal',
  'article_revision',
  'article_rights_policy',
  'article_rights_snapshot',
  'Public Preview Walkthrough',
  'pending moderation',
  'demo-security-event'
]) {
  includes('tools/dev/demo-seed.sql', files.seedSql, token)
}

for (const token of [
  'demo-admin',
  'demo-reader',
  'anonymous account container',
  'admin principal',
  'Passkey',
  'fictional',
  'deterministic',
  'No real'
]) {
  includes('docs/development/demo-data.md', files.demoData, token)
}

for (const token of [
  '.NET SDK Version Mismatch',
  'Node / npm / pnpm Version Mismatch',
  'PostgreSQL Connection Failure',
  'Redis Connection Failure',
  'Port Conflicts',
  'Frontend Dev Server Proxy Failure',
  'AEDS Decode / WASM Worker Issue',
  'WebAuthn RP ID / Origin Configuration Issue',
  'Login / Session / Cookie Issues',
  'Migration Failure',
  'Public AOT Worker Failure',
  'Permission / File Path Issues'
]) {
  includes('docs/troubleshooting.md', files.troubleshooting, token)
}

for (const token of [
  'postgres:17-alpine',
  'redis:7-alpine',
  'fsusblog-dev-postgres',
  'fsusblog-dev-redis'
]) {
  includes('ops/development/dependencies.compose.yml', files.compose, token)
}

for (const [path, source] of Object.entries({
  '.env.example': files.env,
  'src/backend/appsettings.Development.example.json': files.appsettingsDev
})) {
  includes(path, source, 'localhost')
  includes(path, source, '127.0.0.1')
}

includes('src/backend/appsettings.json', files.appsettingsBase, '"ConnectionStrings"')
includes('src/backend/appsettings.Production.json', files.appsettingsProduction, '"SecretKey": ""')
includes('.env.production.example', files.envProduction, 'Jwt__SecretKey=CHANGE_ME_')
includes('.env.production.example', files.envProduction, 'DB_PASSWORD=CHANGE_ME_')
for (const token of [
  'appsettings.json',
  'appsettings.Production.json',
  '.env.production',
  'command-line'
]) {
  includes('docs/configuration/appsettings-authority.md', files.configurationAuthority, token)
}

if (/(gmail|qq\.com|163\.com|outlook\.com|fsus\.blog|ozwasyd\.com|192\.168\.|10\.0\.|172\.16\.)/i.test(files.seedSql)) {
  errors.push('tools/dev/demo-seed.sql appears to contain real-looking contact, domain, or IP data')
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[dev-onboarding] ${error}`)
  }
  process.exit(1)
}

console.log('[dev-onboarding] ok')
