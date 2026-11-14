#!/usr/bin/env node
import { URL } from 'node:url';
const { observeStaticAtomicAssertion } = await import(new URL('../../../../tools/test/static-atomic/assertion-result.mjs', import.meta.url));
const { validateCoherenceProfile } = await import(new URL('../support/crossStackMatrix.mjs', import.meta.url));

const profile = await observeStaticAtomicAssertion('notification-business-events', import.meta.url, () => validateCoherenceProfile('notification-stream-events'));
console.log(`[notification-stream-business-events] ok surfaces=${profile.surfaces.length}`);
