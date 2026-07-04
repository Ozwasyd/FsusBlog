#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
const defaultOut = path.join(root, '.tmp/release-evidence/integrity-proof-verification.json')

function parseArgs(argv) {
  const options = { out: defaultOut }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--out') options.out = path.resolve(root, argv[++index])
    else if (arg.startsWith('--out=')) options.out = path.resolve(root, arg.slice('--out='.length))
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const filter = 'FullyQualifiedName~IntegrityProofVerification'
const command = [
  'test',
  'tests/backend/FsusBlog.Server.Tests.csproj',
  '--filter',
  filter
]

const result = spawnSync('dotnet', command, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env }
})

const status = result.status === 0 ? 'ok' : 'failed'
const summary = {
  schema: 'fsusblog.integrity-proof-verification.v1',
  status,
  releaseEvidence: true,
  externalNetwork: false,
  generatedAt: new Date().toISOString(),
  command: ['dotnet', ...command],
  filter,
  verifier: {
    implementation: 'C# IntegrityProofVerifier',
    fixtureMode: 'deterministic-golden-v1',
    privateKeyPolicy: 'fixed test key only; public registry output must not expose private key material'
  },
  fixtures: [
    'canonical hash fixture',
    'artifact digest fixture',
    'publish proof signature fixture',
    'transparency log chain fixture',
    'Merkle checkpoint root fixture',
    'inclusion proof fixture',
    'public key registry fixture'
  ],
  tamperMatrix: [
    'payload tamper',
    'signature tamper',
    'keyId tamper',
    'algorithm mismatch',
    'log deletion',
    'log reorder',
    'checkpoint tamper'
  ],
  publicModels: [
    'articleRevisionId',
    'revisionNo',
    'ArticleDetailAeds',
    'PublicHotRead',
    'PublicAOT'
  ]
}

fs.mkdirSync(path.dirname(options.out), { recursive: true })
fs.writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
