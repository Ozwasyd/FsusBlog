#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('auth-state')
console.log(`[auth-state-coherence] ok surfaces=${profile.surfaces.length}`)
