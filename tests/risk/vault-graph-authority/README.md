# Vault graph authority risk harness

This isolated diagnostic harness consumes unchanged, exact published production
source. It is not a canonical test lane, terminal receipt, host authority, asset
transaction or native filesystem acceptance. The original implementation owners
retain all production files and shared registrations.

## Source bindings

| Capability | Exact source |
| --- | --- |
| Requested early graph | `80a2736711edff3a711ec854d55c65433a127a5f` |
| Strict graph successor | `00eeaf705dcc03a5412b36002df0b166e7442f3a` |
| Link/embed candidates | `bc05768dc1e2b6dc7495889295f2e86273855ec0` |
| Current strict link/embed successor | `7117889cec02509f14099f28477f673a8cf5795b` |
| Original root contracts | `c0c32cb168fbe59125b942b5964edd7263247338` |

Graph owner: `01a119f3-0b4d-713b-9857-43c641edb03c`, #2124/#2125.
Link/embed owner: `01a119f3-2d20-7274-83f9-b54866b0800b`, #2126/#2127/#2128.

## Reproduce

Use .NET SDK 10.0.401 and an FsusBlog checkout with these commits available.
On the configured saved environment, first source `/workspace/.setup/activate.sh`.
The runner fetches only the four exact capability SHAs into the checkout's object
database and creates detached worktrees under an explicitly supplied empty output
directory. It never edits production files or creates a compatibility overload.

```bash
bash tests/risk/vault-graph-authority/run.sh /tmp/vault-graph-authority-risk
```

The runner returns nonzero while any assertion or composition fails. Logs and
exact process exits remain in that output directory. It retains the detached
source worktrees for inspection; cleanup is separate from acceptance.

The graph mode references the original shared project. Composite mode compiles
the original shared files and two original consumer files together, retaining
their internal digest accessibility. This is diagnostic source composition;
it does not establish original backend project or full DAG qualification.

## Observed results

- Strict graph: 18/18 mixed graph/plan controls passed, exit 0. They cover
  AssetId/owner substitution, revocation, frozen revision drift, cross-vault
  targets, partial edge sets, mixed cycles and cumulative bytes, distinct
  identities, backing-array tamper refusal and frozen input snapshot isolation.
  The added coordinator-directed control uses stored server revision 8 and fresh
  observed revision 9: Ready/PullUpdate freezes and verifies the fresh graph, while
  Build and VerifyCurrent both refuse old saved graph/bytes with
  `portable_dependency_article_or_relation_drift`. This controls the reported
  predecessor defect without claiming general graph currentness. The coordinator's
  predecessor SHA `50068eb43939be73e72054f8d7a662184d2497a1` is not remotely
  fetchable on this host; that baseline is coordinator-reported, not independently
  reproduced here.
- Strict graph plus link/embed composition: exit 1, exactly two production
  CS7036 errors, at `ArticleVaultBlockLinkRefactor.cs:77` and
  `ArticleVaultFrozenEmbedAdmission.cs:160`. Consumers do not supply the required
  current authority edges. No compatibility shim is supplied.
- Compatible early graph plus link/embed: 4/6 checks passed, exit 1.
  Published frozen revision 17 remains fixed while latest revision is 99;
  cancellation after resolution and fresh actor substitution both refuse.
- Current strict graph plus `7117889` consumers: compilation succeeds, resolving
  the earlier API incompatibility. The same six composite checks run, 4 pass and
  the same two unexpected admissions fail, exit 1. Production analyzer warnings
  remain visible; diagnostic compilation is not whole-project qualification.

Two regression assertions remain red:

1. A live link and an identical literal inside a markdown code fence share the
   same source graph. Replacing the input range with fenced offset 42..70 yields
   `Permitted=true`, replacement `[display](/posts/new#stable)`, and `Verify=true`.
   Exact substring equality and target presence do not bind a range to the
   canonical source relation occurrence. Expected: refuse this substituted range.
2. Two portable article identities share a projected route and the `stable`
   anchor. The same raw occurrence is admitted for the second identity and its
   independently checked candidate verifies. Expected: refuse an ambiguous
   occurrence-to-target binding. Use the existing #1868/#1808 mapping authority;
   do not introduce another parser or choose a route winner.

Both findings reproduce on the current strict source pair and are admission
counterexamples over finite synthetic projection
fixtures. No actual write, real host permission bypass or production exploit is
claimed. Current exact findings were handed to
[#2126](https://github.com/Ozwasyd/FsusBlog/issues/2126#issuecomment-6053412185)
and [the coordinator](https://github.com/Ozwasyd/FsusBlog/issues/3582#issuecomment-6053412536).

Asset transaction/upload/ledger receipts, package adapters, real local
materialization, process interruption/recovery, whole-DAG scale/round-trip and
partial business commit behavior remain blocked or untested. A zero-write gate
and these finite projections cannot prove transaction atomicity or host authority.
Changeset not needed: test-only, no consumer-visible implementation change.
