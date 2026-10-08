# Candidate input identities

`identity-contract.mjs` owns the closed candidate-input descriptor, SHA-256 seal,
independent verifier and field-level diff. Run IDs, ordinals, process IDs, ports,
logs and measurement timestamps belong to separate run receipts. Business epoch,
timezone and culture are semantic inputs. There is no age or TTL rule: changing
an input, schema, catalog or policy creates a different candidate identity.

This contract does not collect inputs or create cohorts. Upstream receipts remain
under their existing owners, and independently verified collector refs are required
before this input identity can be used for qualification.

```bash
node --test tests/tools/release-candidate-identity.test.mjs
```
