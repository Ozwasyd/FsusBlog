#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('sse-events')
console.log(`[sse-business-events] ok surfaces=${profile.surfaces.length}`)
