#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildReleaseDeploymentProseClassificationIndex } from './release-deployment-doc-exactness.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'config/contracts/release-deployment-prose-classifications.json')
const index = buildReleaseDeploymentProseClassificationIndex(root)

writeFileSync(output, `${JSON.stringify(index, null, 4)}\n`, { encoding: 'utf8', flag: 'w' })
console.log(`[release-deployment-prose-classification-index] wrote entries=${index.entries.length} source=${index.source.commit}`)
