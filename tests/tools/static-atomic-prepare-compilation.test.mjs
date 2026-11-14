import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

// This allowlist runs source inspection only. No product module or fixture is imported.
const preparationTestAllowlist = Object.freeze([
    'static preparation retains the original pre-executor checks byte for byte',
    'static preparation has no execution or publication call',
    'static execution retains one canonical dispatch after preparation',
    'real owner input preparation preserves private identities and contexts'
]);
const compilerSource = fs.readFileSync(new URL('../../tools/test/static-atomic/compiler-bridge.mjs', import.meta.url), 'utf8');
const producerSource = fs.readFileSync(new URL('../../tools/test/static-atomic/producer.mjs', import.meta.url), 'utf8');
const preparationStart = compilerSource.indexOf('export function prepareStaticAtomicCompilation(');
const executionStart = compilerSource.indexOf('export async function executeStaticAtomicCompilation(');
const preparationSource = compilerSource.slice(preparationStart, executionStart);
const executionSource = compilerSource.slice(executionStart);

test(preparationTestAllowlist[0], () =>
{
    assert.ok(preparationStart >= 0 && executionStart > preparationStart);
    const checksStart = preparationSource.indexOf('    const verified = verifyStaticAtomicCompilation(compilation, options);');
    const checksEnd = preparationSource.indexOf('    const producerIds =');
    assert.ok(checksStart >= 0 && checksEnd > checksStart);
    const checksDigest = createHash('sha256').update(preparationSource.slice(checksStart, checksEnd)).digest('hex');
    // Original block before dispatch in 228670054f7cbff4548b2aa2e3fde7265d6745d4.
    assert.equal(checksDigest, 'a60140c973d80226884e6e2ea8c21f6f0fb1497d682fc478388034b3d8acc0c0');
});

test(preparationTestAllowlist[1], () =>
{
    assert.doesNotMatch(preparationSource,
        /executeCompiledAtomicProducerDag|executeWeightedStepDag|runProducerAttempts|\bcapacity\b|finalizerOperations|mkdir|writeFile|JSON\.stringify|verifyAuthority\s*\(|\.validate\s*\(/u);
    assert.match(compilerSource, /const \{ isAtomicExecutable, resolveAtomicReference, resolveAtomicReplayPlan \} = await import/u);
    assert.match(preparationSource, /verified\.compiled\.steps\.filter\(isAtomicExecutable\)\.map\(step => step\.id\)\.sort\(\)/u);
    assert.match(preparationSource, /producerContexts: Object\.fromEntries\(producerIds\.map\(id => \[id, producerContexts\[id\]\]\)\)/u);
    assert.match(preparationSource, /compiled: verified\.compiled,\s*sourceBindingDigest: verified\.binding\.contentDigest,/u);
    assert.match(preparationSource, /context: options\.context,\s*qualificationEligible: false/u);
    const constructorStart = producerSource.indexOf('export function staticAtomicAuthorityVerifier(');
    const closureStart = producerSource.indexOf('    return reference =>', constructorStart);
    assert.ok(constructorStart >= 0 && closureStart > constructorStart);
    const constructorSource = producerSource.slice(constructorStart, closureStart);
    assert.match(constructorSource, /typeof verifyAuthority !== 'function'/u);
    assert.doesNotMatch(constructorSource, /verifyAuthority\s*\(/u);
});

test(preparationTestAllowlist[2], () =>
{
    assert.equal(compilerSource.match(/\bexecuteCompiledAtomicProducerDag\(/gu)?.length, 1);
    assert.match(executionSource, /const prepared = prepareStaticAtomicCompilation\(compilation, options\);\s*return executeCompiledAtomicProducerDag\(prepared\.compiled,/u);
    assert.match(executionSource, /matrix: options\.matrix, authorities: options\.authorities,/u);
    assert.match(executionSource, /context: prepared\.context, capacity: options\.capacity, producerContexts: prepared\.producerContexts,/u);
    assert.match(executionSource, /finalizerOperations: options\.finalizerOperations/u);
    assert.doesNotMatch(executionSource, /\bcatch\b|terminalVector|publicationError/u);
});

test(preparationTestAllowlist[3], {
    skip: 'UNRUN: prepareStaticAtomicCompilation(compilation, options); no complete genuine owner-supplied compilation/options are available; synthetic authority fixtures are excluded'
}, () =>
{
    // The source owner must supply the existing real inputs without replacing callbacks or identities.
});
