# Admin dangerous-operation policy boundary

`IAdminDangerousOperationPolicyReader` owns the immutable confirmation and
step-up policy presented by the admin operations API:

```text
GET /api/binary/admin/ops/dangerous-operations/policy
  -> IAdminDangerousOperationPolicyReader
       -> immutable policy response
```

The endpoint depends on the stateless singleton reader directly.
Integrity operations do not own or forward policy reads, and the policy reader
has no dependency on integrity operations or any runtime service.

Rule levels, Chinese labels, operation identifiers, policy version, route
permission, fixed-IP limiting, and the AEDS response contract remain unchanged.
