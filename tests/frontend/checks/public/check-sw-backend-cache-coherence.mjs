#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('sw-cache')
console.log(`[sw-backend-cache-coherence] ok surfaces=${profile.surfaces.length}`)
