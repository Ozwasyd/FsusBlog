#!/usr/bin/env node
import { validateCoherenceProfile } from '../support/crossStackMatrix.mjs'

const profile = validateCoherenceProfile('notification-stream-events')
console.log(`[notification-stream-business-events] ok surfaces=${profile.surfaces.length}`)
