# Static atomic compilation preparation

## Private interface

`prepareStaticAtomicCompilation(compilation, options)` is a synchronous, private
in-memory product interface exported from [compiler-bridge.mjs](compiler-bridge.mjs).
`compilation` is the actual `{ compiled, binding }` returned by
`bindStaticAtomicCompilation`. Options retain `repositoryRoot`, `matrix`,
`authorities`, `memberships`, `prerequisiteBindings`, `context` and
`producerContexts`; no replacement input schema is introduced.

Preparation calls the existing `verifyStaticAtomicCompilation`, including exact
recompilation/rebinding equality, then reads the actual static declarations.
The original thirteen cwd and string-valued environment checks, copied frozen
environments, network-baseline skip refusal and `staticAtomicAuthorityVerifier`
construction are unchanged. Construction checks the supplied callback's type and
returns its original closure; preparation never invokes that closure.

The return value is:

```js
{
    compiled,
    sourceBindingDigest,
    producerIds,
    producerContexts,
    context,
    qualificationEligible: false
}
```

`compiled` is the existing verifier's recomputed fragment, retaining its exact
identity and all coordination steps. Its JavaScript object identity need not equal
`compilation.compiled`: the existing verifier already returns the rebind result.
`sourceBindingDigest` is that verified binding's `contentDigest`.
`producerIds` is the sorted roster from actual compiled steps selected by the
canonical `isAtomicExecutable` predicate: atomic producers and genuine declared
hard prerequisites. Projections and finalizers are not executable IDs.

`producerContexts` contains only those IDs. Static producer contexts preserve
supplied fields, authority references and optional `requiredInputAdmission` by
reference, with only the original environment copy/freeze and authority wrapper.
Declared executable prerequisite contexts remain exactly as supplied, without
cloning or wrapping them. Missing prerequisite contexts remain missing for the
original executor to refuse; preparation adds no prerequisite admission policy.
Unrelated supplied contexts are excluded. `context` is the unchanged supplied
object. Inputs are not mutated. Contexts and callbacks are private capabilities;
the result must never be serialized or published as proof.

## Execution boundary

Preparation does not call the canonical executor, an external authority callback,
capacity, `requiredInputAdmission.validate`, finalizers, scheduling or an attempt
runner. It creates no evidence directory, attempt, checkpoint or receipt and
cannot promote qualification. Original declaration/compiler reads still occur.

`executeStaticAtomicCompilation` now calls preparation followed by exactly its
existing `executeCompiledAtomicProducerDag` call. Matrix, authorities, capacity
and finalizer operations remain caller-owned executor inputs. The original error,
cause, publication error and complete terminal vector pass through unchanged.
Terminal projection/readback modules are untouched. No runner, registry,
checkpoint writer or publication path is added.

## Permitted validation

The explicit allowlist in
[static-atomic-prepare-compilation.test.mjs](../../../tests/tools/static-atomic-prepare-compilation.test.mjs)
runs three static source controls and reports one real-input control as UNRUN.
The original preparation block is compared byte for byte by its source SHA-256
from `228670054f7cbff4548b2aa2e3fde7265d6745d4`; source inspection also checks
private executable scoping and the single original dispatch boundary.
These controls import no product module or fixture and invoke no callback.

```bash
node --check tools/test/static-atomic/compiler-bridge.mjs
node --check tests/tools/static-atomic-prepare-compilation.test.mjs
node --test tests/tools/static-atomic-prepare-compilation.test.mjs
```

At delivery, both syntax checks and all three static controls pass, with zero
failures and one skipped real-input control. `git diff --check` passes. Portable
format/docs checks pass for this document; the native style selector does not
select `.mjs`, so these checks do not establish JavaScript lint acceptance.
No full repository, lifecycle, compiler/terminal or execution suite is run.

```bash
./tools/format.sh --check --file tools/test/static-atomic/compiler-bridge.mjs --file tests/tools/static-atomic-prepare-compilation.test.mjs --file tools/test/static-atomic/PREPARE_COMPILATION_CONTRACT.md
./tools/lint.sh docs --file tools/test/static-atomic/PREPARE_COMPILATION_CONTRACT.md
git diff --check
```

The exact positive call remains UNRUN:

```js
const prepared = prepareStaticAtomicCompilation(compilation, options);
```

The checkout contains only synthetic static compiler fixtures, not a complete
genuine owner-supplied compilation with matrix, authorities, canonical memberships,
prerequisite bindings and private contexts. No authority fixture is manufactured.
Once the source owner supplies unchanged real inputs, its ordinary control must
check the original binding identity, exact executable roster, unchanged global
context and prerequisite objects, preserved static fields and callbacks, copied
frozen environments, and zero executor/publication invocations. It must not call
the returned authority closures or input validators. Source checks cannot establish
those runtime observations. Old compiler/terminal suites, identity mutation,
race/TOCTOU/custody controls and equivalent held harnesses are excluded.

## Original consumer integration

The consumer request is published at
`a3a7b51af346ecaed00add62f9f1ff4d4d36a44d`,
`tools/test-matrix/atomic-failure/README.md`, under
“Prepare-only requests to the existing lane owners”. This component is based on
the published static source `228670054f7cbff4548b2aa2e3fde7265d6745d4`.

The consumer must compare every owned fragment step against its canonical whole
graph and retain the original global context, capacity and finalizers. It must
retain genuine declared executable prerequisite contexts and must not turn a
projection into an executable. Prepared callbacks remain private capabilities,
never DATA_ONLY proof or runtime qualification. Consume the actual source branch
and ancestry through normal source integration; do not reconstruct declarations
or add a runner. The exact exported commit and validation limitations must be
provided before using this port. The real positive preparation control remains
pending; static source checks do not qualify native/runtime/CI acceptance.

The source owner retains final integration. Matrix/workflow registration,
complete membership and remaining writer bindings, runtime admission, complete
terminal acceptance and qualification remain with their original owners. The
parent owns draft PRs and all GitHub content actions. No package publication,
merge or issue closure is part of this component. Roll back this component's
three changed files together if context scoping or dispatch preservation regresses.
