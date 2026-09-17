#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('runtime-matrix')
console.log(`[runtime-coherence-matrix] ok surfaces=${profile.surfaces.length}`)
