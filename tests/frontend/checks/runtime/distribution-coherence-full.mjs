#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('distribution-full')
console.log(`[distribution-coherence-full] ok surfaces=${profile.surfaces.length}`)
