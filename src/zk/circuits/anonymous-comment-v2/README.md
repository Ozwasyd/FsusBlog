# anonymous comment v3 circuit source

This canonical source directory contains the self-authored
`fsus.anonymous.comment.v3` circuit source used to generate the repository R1CS
IR artifact. Handwritten circuits live below `src/zk/circuits/`; generated R1CS,
keys and ceremony outputs remain below `artifacts/zk/`.

The source intentionally uses no GPL circuit code and no external JS packages.
Run:

```sh
node tools/crypto/build-zk-comment-v2-r1cs.mjs
node tools/crypto/build-zk-comment-v2-r1cs.mjs --check
```

The generated artifact is deterministic and hash-bound in
`security/zk/contracts/comment-v2-circuit.manifest.json` and
`security/zk/provenance/comment-v2-trusted-setup.manifest.json`.

This is not a trusted setup result. Removing the public credential commitment
invalidated every v2/layout 3 phase-2 artifact; production remains fail-closed
until a fresh v3/layout 4 Groth16 ceremony generates and verifies new
proving/verifying keys and transcripts from the generated R1CS boundary.
