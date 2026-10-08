#!/usr/bin/env node
import { URL } from 'node:url';
const { observeStaticAtomicAssertion } = await import(new URL('../../../../tools/test/static-atomic/assertion-result.mjs', import.meta.url));
const { validateCoherenceProfile } = await import(new URL('../support/crossStackMatrix.mjs', import.meta.url));

const profile = await observeStaticAtomicAssertion('upload-complete', import.meta.url, () => validateCoherenceProfile('upload-complete'));
console.log(`[upload-complete-coherence] ok surfaces=${profile.surfaces.length}`);
