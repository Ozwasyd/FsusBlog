# Static assertion result observations

This source observer serves the six unique #2251 coherence assertions. It invokes
the original `validateCoherenceProfile` callback exactly once and observes that
specific invocation after completion or failure. It spawns no process, supplies no
retry policy and changes no checker assertion or original command.

The original #2272 PoW parity checker calls `publishStaticAtomicAssertionResult`
at its existing final success/failure decision. Its original failure collection,
assertions and thrown summary remain unchanged. Earlier import/read/assertion
failure cannot manufacture a completed PoW observation.

When the existing runner sets `FSUSBLOG_ATTEMPT_RESULT_PATH`, the original checker
writes one exclusive `fsusblog.test-attempt-result.v1` file. On failure it retains
the original thrown reason even if result publication also fails. With no result
request the original callback and console output continue normally. A result
publication failure after successful validation remains a failed command.

The result request must use the native runner's existing
`<producerId>/attempt-N/result.json` namespace, matching the producer declaration
for that source assertion. A child ignores an inherited legacy parent result
request and never overwrites the parent's file or publishes child IDs as parent
membership. This is output routing, not authority or qualification admission;
the existing envelope still owns the exact path. No new runner environment key,
caller command or expected-ID list is required.

`staticAssertionObservation(assertionId, sourceUrl)` reads the existing unique
cross-stack assertion registry binding and requires the exact original source.
It exposes the original source test, assertion, coverage and artifact identities.
The emitted canonical observation is `canonicalTestId({ framework: 'command',
source: binding.artifactPaths[0], name: [binding.sourceTestId] })`: a canonical
encoding of that existing command assertion, observed by its actual callback.
No expected-test list, replay enumeration or caller-supplied replacement ID is
read. The source profile's many internal checks remain one original command
assertion; this observer claims no new per-surface test execution.

A failed process may terminate before an assertion observer writes any IDs. The
terminal bridge retains the actual empty or partial observed set and its original
failure; it never fills observations from replay membership. Any observed IDs must
belong to the bound replay set and failed IDs must have actually been observed.
A clean success still requires the complete exact observed set. Planned replay
membership and actual `observedTestIds` are separate fields in the failed summary.

The native replay/membership owners must explicitly admit this exact command
observation encoding and map each original assertion to its one actual emitted
ID. The source binding proposal is not a global registry or qualification change.
The static bridge still requires complete canonical membership, source/run/input,
network and replay authority, exact-one attempts and verified logs/artifacts.
Projections remain `qualificationEligible: false` until real integration is
accepted. Do not register the thirteen producers as zero-ID process-only commands.

The observed source closure now includes this module, its producer declarations,
package-script source, native canonical-ID and
registry validators, the existing assertion registry and the original checker
source/profile fixture. Input owners must hold those exact transitive bytes for
the current candidate. A source descriptor alone is not an execution or held-input
receipt. This observer emits no product artifacts; existing registry artifact
paths remain preserved metadata.

The ordinary runner correction `d22765955c9dee268e4809efc77d1c27e48248ad`
allows a sidecar-free success only for genuinely zero-declared-ID commands.
Missing sidecars never copy planned IDs into executed membership. All thirteen
canonical static producers still require their real observed-ID result sidecars.

The original registered security-matrix source binding can also be encoded by
this API, for its existing physical owner to consume. Encoding a descriptor runs
no checker and records no execution. No matrix result is emitted by this partition.

The other six security producers need their original physical writers to emit their
own observations. In particular `security-matrices` retains the shared physical
envelope writer; it cannot be wrapped in a second runner or re-executed here.
No sibling security writer, shared registry, declaration or overlapping original
contract source is edited by this increment.
