# anonymous comment v2 circuit source

This directory contains the self-authored `fsus.anonymous.comment.v2` circuit
source used to generate the repository R1CS IR artifact.

The source intentionally uses no GPL circuit code and no external JS packages.
Run:

```sh
node tools/crypto/build-zk-comment-v2-r1cs.mjs
node tools/crypto/build-zk-comment-v2-r1cs.mjs --check
```

The generated artifact is deterministic and hash-bound in
`security/zk/comment-v2-circuit.manifest.json` and
`security/zk/comment-v2-trusted-setup.manifest.json`.

This is not a trusted setup result. Production remains fail-closed until #552
generates and verifies the real Groth16 proving/verifying keys and transcripts
from the generated R1CS boundary.
