#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('perf')
console.log(`[cross-stack-performance] ok surfaces=${profile.surfaces.length}`)
