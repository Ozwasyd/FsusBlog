# Third-Party Moderation Runtime Package Guide

FsusBlog accepts third-party anti-spam models only as signed `FsusAntiSpamModel` portable runtime data packages. A package is data, not executable code. It is loaded by the same built-in runtime loader used for first-party releases.

## Package Files

A package directory must contain:

- `manifest.json`
- `runtime_config.json`
- `model_state.json`
- `weights.int8.json`
- `threshold_policy.json`
- `test_vectors.jsonl`
- `manifest.sig` when production signature validation is enabled

`manifest.json` must declare `runtime_format = fsus-antispam-portable-runtime-v1`, a source beginning with `mainline-release` or `third-party`, artifact SHA-256 digests, provenance, and the runtime channel. Production packages must pass trusted signature validation.

## Runtime Boundary

The loader verifies:

- runtime format compatibility
- artifact digest matches
- trusted signature when required
- threshold policy shape
- model test vectors
- source is not `legacy/python`, audit-only, or any other legacy path

Loading failure never interrupts comment creation. FsusBlog keeps the previous active scorer snapshot; if no scorer is active, it writes an unavailable model signal and keeps the comment in the normal moderation path.

## Signal Boundary

The model can emit only risk-signal fields:

- label
- confidence
- severity
- categories
- primary reason
- threshold profile
- latency
- metadata

The model must not emit or imply final actions such as `reject_submit`, `geo_block`, `blocked_regions`, `publish`, `hide`, `submit_action`, or `display_action`. FsusBlog owns hard dictionaries, region policy, viewer filtering, automatic disposition policy, and admin final actions.

## Third-Party Requirements

Third-party packages must:

- use the same portable runtime format as first-party packages
- pass artifact digest checks
- pass trusted signature checks in production
- include passing `test_vectors.jsonl`
- keep categories and threshold policy inside FsusBlog's risk-signal boundary
- avoid legacy identity fields and audit-only provenance
- avoid executable hooks, plugins, services, shell commands, dynamic libraries, or arbitrary code

Third parties can ship model data. They cannot add a new production execution path.
