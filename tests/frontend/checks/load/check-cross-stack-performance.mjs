#!/usr/bin/env node
import { URL } from 'node:url';
const { observeStaticAtomicAssertion } = await import(new URL('../../../../tools/test/static-atomic/assertion-result.mjs', import.meta.url));
const { validateCoherenceProfile } = await import(new URL('../support/crossStackMatrix.mjs', import.meta.url));

const profile = await observeStaticAtomicAssertion('performance-contract', import.meta.url, () => validateCoherenceProfile('perf'));
console.log(`[cross-stack-performance] ok surfaces=${profile.surfaces.length}`);
