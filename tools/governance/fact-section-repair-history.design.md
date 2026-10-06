# Finite embedded fact-section repair history

Issue #3611 is a governance prerequisite for #3610/#3619, not a generated-only
exception already available to contributors. The first implementation component
is `fact-section-repair-history.mjs`, exercised by the existing Change Contract
test entry. It never executes producer code, dispatches a new repair schema,
admits a PR, or elevates a trusted baseline. Its successful result is explicitly
`preflight-only` with `qualification: false`.

## Reviewed history candidate

The proposed finite registration seals the last document owner `0d863111` and
the complete 21-node all-parent graph through `b19b3dc7`, including ordered merge
parents and every tracked tree object. It binds the two actual single-parent
source events `709986ab` then its direct child `1e95f95f`; it does not invent a
named outer PR for either event. The output is exactly the reviewed regular
document blob, not a directory, marker wildcard, or mutable receipt discovery.

The current preflight requires the unchanged frontier and a document-only,
single-parent repair history. Every historical document identity remains the
anchor identity, and every source event must match exactly once and in order.
Each intermediate candidate document must retain either the exact old or exact
complete repaired identity; transient prose edits and partial repairs are refused
even if the final head restores the expected bytes.
The complete candidate document identity seals prose, all marker ranges and
every other output byte; the additional semantic check proves that both changed
authority-module source digests equal the current exact Git blobs while all
other authority fields remain unchanged. Git replacements, grafts, lazy fetching,
shallow repositories, nonregular modes, corrupt or truncated blobs are refused.

## Remaining trusted admission stages

The preflight is deliberately not listed in the active Change Contract repair
schemas. These stages remain required before a production dispatch exists:

1. Independently review the finite graph and producer closure epochs.
   `3943bbc9` changed runtime-role deployment authority and `d3658ecd` changed
   zero-legacy identity governance. Replay each historical revision with its
   original tracked producer bytes, not the current producer overlaid on an
   older checkout.
2. Construct a trusted execution adapter from an authority checkout, not an
   executable candidate root or a candidate-supplied adapter. The original
   `runMinimalContractBuild` and fresh `runExtractor` with `useCache: false`
   must produce the current-source observation. Validate complete source,
   worktree, toolchain, build receipt and input-closure identity. A reader's
   self-digest validation or the historical #3610 receipt is insufficient.
3. Use the original complete catalog and generated-section producer to inspect
   all affected ranges, then double replay and fixed-point check. A nonempty
   exact expected identity is mandatory; never use `expectedIdentity: null`,
   synthetic resealing, direct hash replacement or reduced generated ranges.
4. After explicitly authorized owner promotion, regenerate repair metadata
   against the actual trusted base. `b19b3dc7` remains the immutable history
   frontier, not a substitute for the future PR base. Review every intervening
   policy-only transition; mixed producer/output changes or a newly changed
   canonical closure require an independently reviewed new epoch. The initial
   preflight rejects this suffix rather than claiming it is already safe.
5. Retain ordinary PR metadata, exact generated repair and external-naming
   evidence, local-equivalent CI and independent acceptance. The old checker
   rejecting the bootstrap or repair must never be reported as trusted PASS.

The focused refusal fixtures qualify only this read-only component. They do not
prove canonical execution, matrix acceptance, complete repair admission, merge,
production readiness, or authority promotion.
