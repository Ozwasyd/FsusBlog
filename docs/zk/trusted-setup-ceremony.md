# Anonymous comment v5 trusted setup

Production proving uses only `fsus.anonymous.comment.v5` with public-input layout
version `6`. Earlier circuit-specific setup material is retired and has no
repository ownership, build, deployment, compatibility, or restore path.

The current source and authority files are:

- `src/zk/circuits/anonymous-comment-v5/comment_v5.circuit.json`
- `security/zk/contracts/comment-v5-circuit.manifest.json`
- `security/zk/provenance/comment-v5-trusted-setup.manifest.json`
- `config/zk/anonymous-comment-v5-verifying-key.manifest.json`
- `security/zk/provenance/artifact-ownership.manifest.json`

The checked-in setup manifest intentionally records `ceremony_status: not-run`
and `production_usable: false`. Therefore ordinary builds exclude the proving
key and browser prover bundle. Setting `FSUSBLOG_ZK_PRODUCTION_ENABLED=1` fails
closed until a fresh layout-6 ceremony supplies a verified phase-2 transcript,
at least three contributions, R1CS, proving key, verifying key, and browser
prover bundle with complete matching SHA-256 bindings.

External ceremony and delivery artifacts live outside ordinary Git at the exact
paths declared by the trusted-setup manifest. The ownership checker rejects
tracked copies or undeclared paths.

Run the repository checks with:

```bash
node tools/security/comment-privacy-build-contract.mjs
node tools/crypto/check-zk-artifact-ownership.mjs
node --test tests/security/comment-privacy-build-contract.test.mjs
node --test tests/tools/zk-artifact-ownership.test.mjs
```

Changing the public statement requires a new circuit identity, layout version,
circuit-specific setup, verifying-key binding, credential-root rotation, and
immutable release evidence. A key from another circuit or layout is never a
fallback.
