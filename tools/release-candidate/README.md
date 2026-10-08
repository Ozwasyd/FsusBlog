# Candidate input identities

`identity-contract.mjs` owns the closed candidate-input descriptor, SHA-256 seal,
independent verifier and field-level diff. Run IDs, ordinals, process IDs, ports,
logs and measurement timestamps belong to separate run receipts. Business epoch,
timezone and culture are semantic inputs. There is no age or TTL rule: changing
an input, schema, catalog or policy creates a different candidate identity.

`collect-source-worktree.mjs` calls the canonical
`snapshotRepositorySourceIdentity` API in `tools/test/repository-source-snapshot.mjs`.
It requires a physical Git root and an explicit source policy:

```json
{
    "schema": "fsusblog.repository-source-policy.v1",
    "untracked": "include",
    "ignoredInputs": []
}
```

Each consumed ignored file must be explicitly declared with `ownerId`, `path`,
`reason`, `consumedBy` and `required`. These declarations must come from the
consumer's authority. An empty list does not establish that all actual producers
have registered every ignored input. Arbitrary cache directories are not scanned.

```bash
node tools/release-candidate/collect-source-worktree.mjs --repo . --policy /explicit/source-policy.json
node --test tests/tools/release-candidate-identity.test.mjs tests/tools/release-candidate-source-worktree.test.mjs
```

The snapshot includes index objects/stages and actual tracked/untracked file
contents and executable modes, relative symlink targets, declared ignored inputs
and parent Git submodule pointers. Alias and submodule checkout contents need
their separate collector. The digest excludes physical roots and mtimes. File
reads check BigInt filesystem identity before and after reading; the collector
reobserves bytes and Git inventory before sealing. Unsafe hidden index flags,
shallow repositories, special files, missing objects and escaping paths fail.
Collection never installs, builds, checks out, cleans or stashes inputs.

The shared scheduler and Reliability consumers have not adopted this API in this
increment. Their owners must replace their current source snapshot boundary,
call it before seal, before each major producer and after the run, and compare
`diffRepositorySourceSnapshots` output. Any changed input cancels qualification
and reports changed paths. A passing module test does not establish this uptake
or actual runtime acceptance. The repository-level ignored-input declaration and
cross-consumer governance also remain with their canonical owners.

Downstream candidate aggregation requires verified alias/policy/build/fixture/
execution identities. Missing receipts cannot be filled with SHA-only or manual
defaults, and this source contract does not create a qualified candidate.

## Cohort contract and storage capability

`cohort-ledger.mjs` independently validates complete candidate payloads, distinct
run/scheduler/namespace/Fresh-cleanup identities, ordinals, append order, every
previous/current hash and the terminal seal. It retains failed, cancelled, partial
and infrastructure outcomes. New runs never replace a failed ordinal. Restarting
requires an explicitly named new cohort instance; no three-round rule is applied.

`cohort-store.mjs` writes the identity and empty ledger in one staged directory
rename, then uses an exclusive writer and explicit expected digest for atomic CAS
updates. The immutable identity root is checked on every read. Inspection always
requires the externally held expected ledger digest: otherwise a valid historical
prefix cannot be distinguished from deletion of later records. A crashed writer
lock is retained and refused; no PID/time-based stealing or repair is supplied.

Creation requires the caller's independent six-fragment identity-plan verifier.
Appending requires the caller's existing current-run locator and verified
outcome/Fresh-cleanup/runtime mapping. These mandatory capabilities are injected
interfaces, not generic `verified: true` fields. Neither production mapping is
provided in this increment, and bare candidate payloads are not accepted by store
creation. Unit callbacks exercise the owned storage contract only; they do not
prove physical runtime receipts or qualification. Full independent inspection
must additionally revalidate original locator-bound run receipts. Static consumer
governance and terminal acceptance remain pending their canonical integration.

```bash
node --test tests/tools/release-candidate-cohort-ledger.test.mjs
```
