# Security matrix catalog

`security/matrices/` is the machine-readable requirements and scenario-mapping namespace. It contains governance data, not executable tests, scanners, runtime settings, or generated evidence.

The canonical catalog is `security/matrices/catalog.json` with schema `fsusblog.security-matrix-catalog.v1`. Each entry declares:

- a stable matrix `id` and canonical repository-relative `path`;
- `family`, `schema`, and `version` so unrelated matrix formats cannot be interchanged;
- the accountable `owner` and executable `checker` consumer;
- the entry-list key, ID pattern, and semantic validation profile.

The current hierarchy is:

```text
security/matrices/
  catalog.json
  standards/
    asvs-v5.0.0.yml
    wstg-v4.2.yml
  authentication/
    webauthn.yml
  risk-control.yml
  perception-v2.yml
  privacy-zk-comment.yml
```

Every matrix repeats its catalog `schema`, `family`, `version`, `owner`, and `checker` values. `tools/security/check-security-matrices.mjs` rejects catalog-to-file drift, duplicate IDs or paths, unsafe and missing references, unsupported validation profiles, and missing entry fields. It accumulates independent failures before returning a non-zero status so one run exposes the complete matrix-governance defect set.

Generated evidence remains under `.tmp/security/**`. Such paths are declarations of future run output and are not treated as committed evidence or as proof that a fresh execution passed.

When adding or changing a matrix:

1. choose the role-specific namespace and add or update the catalog entry;
2. keep the matrix metadata identical to the catalog declaration;
3. preserve owner, code, test, and evidence mappings for every entry;
4. add a semantic profile to the checker before using a new profile name;
5. run `node tools/security/check-security-matrices.mjs` and `node --test tests/tools/security-matrix-catalog.test.mjs`.
