# Atomic failure projection material

Projection modules analyze explicit, bounded, caller-owned data. The runtime
binder additionally reads the original state catalogue and canonical scheduler
checkpoint through their source-owned I/O contracts. Its returned facts are admitted
under the explicit host budgets after those original reads. Every projection has
`dataOnly: true` and `verificationStatus: unverified`. The display `contentDigest`
detects modification; it does not authenticate a graph, producer, attempt,
aggregate or replay input. Projection APIs never run tests, retry producers or
qualify release evidence. The explicit execution interface below dispatches the
original executor; it never scans a run directory or writes a checkpoint.

## Consumer interfaces

`projectAtomicCiMaterial(input, hostLimits)` accepts an explicit run/attempt/source
context, compiled graph facts and the existing planner's selected IDs. It derives
jobs, cross-job edges, one canonical DAG invocation per runner group, receipt
bindings containing both run and attempt IDs, and a receipt-required `always()`
aggregate. Cross-job edges use `always()` so a failed runner cannot cancel an
independent producer in another job. The canonical invocation must consume the
actual prerequisite receipts and prevent blocked producers from spawning.
`checkAtomicWorkflowMaterial` compares externally extracted actual workflow facts
exactly with this projection, including DAG digest, invocation count, needs,
fail-fast, artifact bindings and structured aggregate consumption.

`projectCompiledAtomicCiMaterial` consumes the original compiler's
`verifyCompiledAtomicProducerDag`, the exact matrix/authority inputs and canonical
`ci-plan.jobs[].tiers` projection. It derives the material view without maintaining
another parent/job map. This API requires the atomic framework source capability
to be installed; its independently tested dependency is
`ebf0d6e0e555ba8bf64ceb4dbc9de6427cc1699c` (original behavior correction
`653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0` plus the sole-owner import fix). The original framework source
and history are consumed unchanged by a normal merge. Missing or ambiguous canonical CI ownership
and runtime `stateAccessRef` without its canonical fact bridge are refused.

`projectCanonicalLaneAtomicCiMaterial` consumes original backend, static, frontend
and public-runtime lane admissions, plus original coverage action contracts. It invokes `compileBackendAtomicBridge`,
`bindStaticAtomicCompilation`, `prepareFrontendManifestAdmission` and
`compilePublicRuntimeProducerDag` from exact source9690f092, ab9a2493, be307751 and
43470d5c, and `compileCoverageProducerDag` from d033e029. The canonical global matrix/compiled DAG remains owner-supplied. Every
original lane step must match that graph exactly; duplicate primary owners,
cross-run/source replay and missing graph children are refused. Static thirteen
producer assertion memberships and original public runtime requirements remain
bound to original source bindings. Pure fragment compilation invokes no producer.
The API neither assembles a production matrix nor calls lane executor wrappers.
Frontend held contexts are passed only to its original admission API; no callback
can promote this DATA_ONLY result. Unconsumed executable IDs are explicit. Missing
canonical runtime state facts keep `ciProjection: null` and pending producer IDs;
no empty state access or runtime success is fabricated. With complete static/build
sources, the existing canonical CI projection yields one invocation per shared
runner for all consumed lanes. Global job maps never come from lane fragments.

`prepareCanonicalAtomicCiGroup` calls the available original frontend fragment
admissions and `preparePublicRuntimeAttemptContexts`, binding their steps to the
global graph. It also consumes the original synchronous `prepareBackendAtomicBridge`
from ffab3106 and `prepareStaticAtomicCompilation` from 8d5e8103. Backend callers
must supply `options.backendContexts[lane.id]` with the independently selected
`expectedBindingDigest`, original `profile` and original `verifyAuthority`.
Static preparation receives its original `lane.input` compilation options. Both
receive the unchanged global `options.context` and current `producerContexts`.
Their original binding, fragment digest and exact sorted executable scope must
match the already compared lane binding. Actual prerequisite contexts are required;
the static owner's frozen environments/verifier wrappers and original supplied
prerequisite objects are retained. Nothing is serialized as preparation proof.
It installs original coverage request/material preparation through
the original required-input admission seam from 39466f9a. Existing held validators
remain first in that seam; coverage source/request bytes and upstream materials
are checked by their original validators after dependency/resource admission and
before attempt allocation. Host-held callbacks remain private capabilities and do
not become DATA_ONLY proof. No prepared context qualifies runtime.

`executeCanonicalAtomicCiGroup` executes fully consumed frontend and coverage
graphs in one original canonical DAG invocation. Source wiring now also supports
prepared backend/static fragments through the same dispatch; genuine-input
preparation and execution remain UNRUN for those fragments. It preserves capacity, commands,
attempt policy, finalizers, and the original error/full terminal vector. Complete
selection and exactly one canonical CI runner group are required; original
selected/job-scoped dispatch ports are still absent. Its source-only dependency
consumption includes publication-error preservation from 5c1b8cd7 and input
admission from 39466f9a, without adopting their ancestor's authority fixture.

Backend/static pre-execution checks are extracted by their original owners and
consumed without calling their execute wrappers. Public preparation is already callable and used, but original
runtime admission and settled-reset postflight remain pending. Complete-vector
domain outcome projection remains with each original owner. No synthetic fixture
execution or original component control qualifies native/runtime/CI acceptance.

## Original prepare-only lane contracts

Both requested exports are now published and consumed. Their existing owner
modules extract unchanged pre-executor checks; each existing execute wrapper calls
its own preparation export before its one original executor call. This consumer
adds no runner and reconstructs no declarations. Backend source is consumed by a
normal merge; the static increment is consumed byte-for-byte on its matching
compiler base, without importing unrelated ancestor authority outputs.

`prepareBackendAtomicBridge(binding, input, options)` belongs in
`tools/test/backend-atomic-bridge.mjs`, published at
`ffab3106b2d92279f97414b214455d9815a62d67` on original source
`9690f0924509d665748afd5310c3b074ebcc03d6`. Its inputs are exactly those of
`executeBackendAtomicBridge`: the original compiled binding; `input.plans`,
`expectedPlanDigests`, `sourceRoot`, `matrix`, `authorities`; and the existing
`options.expectedBindingDigest`, `context`, `profile`, `verifyAuthority`,
`producerContexts`. Retain recompile/digest equality, current source/worktree/run
and profile equality, each producer and Release prerequisite's exact envelope,
replay and temporal refs, and the existing Release/perf-readiness environment
requirements. Preparation must return the original validated contexts for those
executable IDs. Capacity and finalizers remain caller-owned executor inputs.

`prepareStaticAtomicCompilation(compilation, options)` belongs in
`tools/test/static-atomic/compiler-bridge.mjs`, published at
`8d5e8103bdeab9960477f6dccca5dd7f7b10b6dc` on source
`228670054f7cbff4548b2aa2e3fde7265d6745d4`. Inputs retain the existing
`repositoryRoot`, `matrix`, `authorities`, `memberships`, `prerequisiteBindings`,
`context`, `producerContexts`. Call the existing exact compilation verifier;
retain all thirteen original cwd/environment checks, the network-baseline skip
refusal, frozen environment copies and original `staticAtomicAuthorityVerifier`
wrappers. Declared executable prerequisites must retain their supplied contexts;
do not manufacture a prerequisite or turn a projection into an executable.

Both original exports return this private in-memory shape:

```js
{
    compiled, // exact original verified fragment, including coordination steps
    sourceBindingDigest, // binding.contentDigest or compilation.binding.contentDigest
    producerIds, // sorted exact scoped executable IDs, including declared prerequisites
    producerContexts, // only these IDs; original validated contexts/callbacks
    context, // the unchanged original executor context
    qualificationEligible: false
}
```

The consumer already compares every owned fragment step with the canonical whole
graph and retains the original global context, capacity and finalizers. Preparation
must not execute, allocate attempts, publish receipts, perform terminal readback or
claim qualification. The returned callbacks are private capabilities, not portable
JSON evidence. The original framework prerequisite is
`2eda290cc6098971b685b3fb1465d7193bd3dde2`; later sole-owner input-admission and
publication corrections already consumed in this stack remain unchanged.
Original source binding `f39efa540fa257250c52f4b59d972ccb7db315fd` now verifies
this consumer's complete five-file `39466f9a3a4714b5b58cd4c75a8baa69588e9c9e`
combination, while retaining the original complete `2eda290c` combination.
It chooses by exact execution bytes and checks all five files against that same
commit; no per-file fallback or arbitrary execution source is admitted.
Source availability does not establish runtime acceptance. Genuine owner inputs
for both preparation calls remain unavailable here, so their dynamic identity,
context and no-dispatch controls are explicitly UNRUN. No synthetic authority
fixture or replacement callback is used to fill that gap. Original domain terminal
authentication, native/runtime admission and canonical CI attachment remain owner
integration requirements.

Backend property source `09a3951c90c662c4f80302a9f23fa335abce7edc` has the owner's
real restore, Release/Debug compilation and four original property-test results;
the earlier restore failure is not a blanket blocker. It adds no prepare-only
bridge export. Static observation source
`228670054f7cbff4548b2aa2e3fde7265d6745d4` retains seven genuine writer hooks;
the other writer bindings and complete canonical membership remain owner work.
Neither source needs a second journal or result runner in this partition.

`projectCompiledAtomicRuntimeCiMaterial` extends the compiler/CI-plan projection
with the original runtime state's catalogue and registry facts. Each original
`stateAccessRef` must bind its catalogue digest and exact entry digest through
`catalogDigest` and `catalogEntryDigest`; entry IDs remain producer IDs, without an
alias table. Missing entries or stateful children without original refs are
refused. The graph retains canonical dotted state-domain names. Read/write advice
is conservative; the actual scheduler policy retains the original operation,
exclusive-domain and commutativity rules. Conflicting independent producers in
different CI jobs are refused until the canonical planner co-locates them. Existing
cross-job prerequisite ancestry permits serialization; no new needs map is added.

`createCompiledAtomicRuntimeCiBinding` loads state facts using the original
`loadRuntimeStateAuthority` and checks the explicit current-run checkpoint with
`readCanonicalSchedulerCheckpoint` from exact scheduler source
`2eda290cc6098971b685b3fb1465d7193bd3dde2`. Disposable checkpoint JSON cannot substitute
for canonical objects/journal. Source/worktree/run/digest must match and scheduler
status must be running. Compiled argv is retained unchanged for execution; only a
literal command view is derived for the existing catalogue source analyzer.
Unsupported argv syntax needs the original structured argv analyzer, rather than
assuming no state. The returned original conflict policy, including catalogue,
registry and checkpoint source checks before later admission waves, can be attached
to the original executor's capacity. CPU, memory, concurrency, commands, attempt
policy and finalizers stay unchanged. This readback does not grant a live scheduler
resource admission or perform checkpoint CAS/final receipt publication. Hosts still
need the original owner/grant and finalizer contracts. Raw validated state facts
are returned for reuse by read-only terminal collection, not as a qualification
receipt. Ordinary controls execute original source-fixture producers through this
binding; they do not exercise product services or qualify Production runtime.
The executable state-policy binder currently requires complete selection: the
original executor lacks a selected-subgraph/not-selected terminal API. Pure CI
projection keeps the planner's selection facts, but cannot grant partial execution.
Multi-job dispatch also needs the original executor's job-scoped invocation and
structured cross-job prerequisite handoff; this binder is not a CI job dispatcher.

`collectCompiledAtomicTerminalMaterial` consumes that same verified compiled DAG,
its original complete terminal vector and explicit expected-vector material. It
checks complete producer membership, original receipt digests, run/source/worktree
identity and current-run references. It preserves the original terminal status,
primary failure refs, blocked dependencies, receipt digests and reference digest
encoding, including bare SHA-256 join evidence. Unspawned cancellation stays an
attempt-less original receipt. CI transport bindings remain plans: this read-only
API neither materializes a file nor claims that its planned receipt path exists.
Runtime collection accepts the same original `runtimeAuthority` facts and
recomputes the state-aware CI binding, preserving the original CI projection digest.
Partial selection is refused until the original executor supplies not-selected
receipts. Explicit repository-relative paths are lexical checks; filesystem reads,
symlink authentication and original byte verification belong to the authority
bridge. Expected-vector equality is structural DATA_ONLY validation. It cannot
promote caller-owned material to semantic evidence or qualification. Interruption
messages are omitted; the original vector ref preserves their source identity.

`collectCanonicalLaneAtomicTerminalMaterial` accepts the canonical lane source
input together with that same complete-vector collection input. Its third argument
retains the original frontend admission contexts. Original lane bindings select
executable members from the one complete vector; each lane retains source receipt
digests, exact terminal-state lists, primary failures and blocked roots. Shared
prerequisites may appear in multiple lane indexes but remain one receipt in the
whole collection. Coordination receipts stay in the complete collection. Unconsumed
producer IDs remain explicit; no lane membership is invented. This read-only
DATA_ONLY index invokes no executor or receipt writer. It is usable operator
material, while original domain terminal authentication and semantic navigation
publication remain pending with their owners.
The original `primaryFailureRefs` can include settled-join dependency refs; these
are preserved verbatim and are not reclassified as failed producers. Use the
explicit `terminalStates` lists for each producer's actual terminal disposition.

The graph input is an extracted **DATA_ONLY view**, not a declaration catalog or
compiler. Its explicit `graphRef` and `dagDigest` identify the upstream compiled
graph. Nodes retain IDs, logical parents, closed execution kind, evidence class,
hard/settled edges, planner-assigned CI job, state access and exclusive resources.
The caller must extract all fields from the existing declarations/compiler;
maintaining a separate producer list or job map is forbidden. Job contraction
cycles and missing selection prerequisites are refused. No workflow cutover is
performed here. Runner images, commands, timeouts and installation/service policy
remain with their existing owners.

`projectFailureNavigationMaterial(input, hostLimits, repositoryRoot)` consumes the
explicit compiled graph, current aggregate reference and complete terminal vector.
It retains primary failure refs and canonical taxonomy identities, checks current
run paths and blocked root closure, and uses the existing replay-plan validator and
replay command builder. Failed producers get the original sealed plan command;
blocked producers get upstream replay references and no self command. State writes,
exclusive resources and hard/settled ancestry prevent conflicting replay advice.
Coordination nodes cannot claim correctness attempts or self replay. Success,
failure, timeout, internal error, blocked, cancelled, not-selected and diagnostic
remain separate. `renderFailureNavigationMaterial` gives a compact operator view.
`publishVerifiedFailureNavigation` always refuses: the independent aggregate/attempt
authentication bridge is not available on this base. A flag, callback or digest
cannot substitute for that missing authority.

`analyzeExecutableAuthorityMaterial(input, hostLimits)` checks launch facts supplied
by the canonical transitive-input parser. Every correctness node needs exactly one
owned executable authority. Unknown dynamic launches, swallowed errors, hidden
children, correctness execution in coordination nodes, missing owners and broad
descendant exemptions become precise source-location findings. A tool descendant
needs exact owner/child command digests, purpose, output owner, no independent
test/evidence IDs and a proof test. These proof materials are not authenticated
here. `inspectPackageScriptMaterial` expands literal npm/pnpm script references;
`inspectWorkflowCommandMaterial` uses the repository YAML parser to expose actual
run steps, unsafe continuation and default matrix fail-fast. The deliberately
finite command grammar refuses unsupported shell structure or dynamic expansion.
These functions neither replace the Shell/Node/TS closure analyzer nor claim whole
repository coverage. Extraction still needs canonical owner integration.

`analyzeAtomicExecutionMaterial(input, hostLimits)` compares complete externally
captured execution observations with navigation and local/CI projections. Missing
terminal members, retries, duplicate spawns, omitted finalizers, wrong blocked
closure, graph drift and first-failure replacement are refused. Its result retains
`terminalAcceptancePending: true`; it is not a terminal acceptance receipt. The
new conformance tests also invoke the existing `executeWeightedStepDag` with real
Node children to collect two independent failures and check transitive blocking,
settled joining and exact-once cleanup. The original failing cancellation
control remains unchanged and now passes when consuming the original owner
correction653ef38. This partition does not independently repair scheduler or
framework source. Earlier failing evidence stays bound to its original candidate.

All inputs require separate host budgets: `maxDepth`, `maxNodes`, `maxBytes` and
`maxItems`, each a positive safe integer. Descriptor checks reject getters, proxies,
special objects, sparse arrays and cycles before cloning. This constructed-object
interface does not provide encoded-input containment or an allocation/OOM guarantee
for exceptionally wide key enumeration. The caller owns input transport policy.

## Integration boundaries still required

- The atomic declaration/compiler owners must provide exact current graph bytes,
  compiled identities, declaration-linked source launch facts, attempt bindings and
  domain migration receipts. Runtime catalogue entries need exact producer IDs and
  original state refs with `catalogDigest` and `catalogEntryDigest`; the planner must
  invoke the state bridge before assigning conflicting children to separate jobs. The original compiler/executor source is now consumed;
  complete domain declarations and runtime authority bindings remain pending.
- The semantic aggregate owner must authenticate original producer/attempt/replay
  refs, retain all first failures and publish through the existing current-run
  locator/checkpoint transaction before verified navigation can exist.
- The matrix/workflow owner must call these APIs from the canonical CI planner and
  gate, extract actual workflow facts and register the new source tests. No global
  registry, matrix, inventory, workflow or historical ledger is independently edited.
  The shared bundle correction is consumed byte-for-byte from its sole owner.
- Full domain migrations, Production Fresh/resume parity, focused physical replay,
  all mutation classes and terminal acceptance remain required. Synthetic component
  evidence cannot satisfy those gates. The parent owns review, integration and any
  justified issue closure. The tracking issue carries no implementation.

Rollback the isolated new modules and tests together if a ref, topology or failure
preservation regression is found. No runtime authority or package is published.
