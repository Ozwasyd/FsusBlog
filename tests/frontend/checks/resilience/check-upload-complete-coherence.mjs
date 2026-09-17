#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('upload-complete')
console.log(`[upload-complete-coherence] ok surfaces=${profile.surfaces.length}`)
