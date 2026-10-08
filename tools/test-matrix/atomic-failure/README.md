# Atomic failure projection material

These modules analyze explicit, bounded, caller-owned data. Every result has
`dataOnly: true` and `verificationStatus: unverified`. The display `contentDigest`
detects modification; it does not authenticate a graph, producer, attempt,
aggregate or replay input. No module runs tests, retries a producer, scans a run
directory, writes a checkpoint or qualifies release evidence.

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
`653ef38e2ce6dbcf8e2671bd8e091eb9c04538a0`. The original framework source
and history are consumed unchanged by a normal merge. Missing or ambiguous canonical CI ownership
and runtime `stateAccessRef` without its canonical fact bridge are refused.

`collectCompiledAtomicTerminalMaterial` consumes that same verified compiled DAG,
its original complete terminal vector and explicit expected-vector material. It
checks complete producer membership, original receipt digests, run/source/worktree
identity and current-run references. It preserves the original terminal status,
primary failure refs, blocked dependencies, receipt digests and reference digest
encoding, including bare SHA-256 join evidence. Unspawned cancellation stays an
attempt-less original receipt. CI transport bindings remain plans: this read-only
API neither materializes a file nor claims that its planned receipt path exists.
Partial selection is refused until the original executor supplies not-selected
receipts. Explicit repository-relative paths are lexical checks; filesystem reads,
symlink authentication and original byte verification belong to the authority
bridge. Expected-vector equality is structural DATA_ONLY validation. It cannot
promote caller-owned material to semantic evidence or qualification. Interruption
messages are omitted; the original vector ref preserves their source identity.

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
  domain migration receipts. The original compiler/executor source is now consumed;
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
