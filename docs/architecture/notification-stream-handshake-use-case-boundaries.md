# Notification stream handshake use-case boundaries

The notification stream handshake is composed from three one-way use-case ports. This keeps policy changes local and prevents the endpoint-facing coordinator from accumulating infrastructure dependencies.

```text
NotificationStreamHandler
  -> INotificationStreamHandshakeService
       -> INotificationStreamHandshakeRequestValidator
       -> INotificationStreamRiskProofPolicy
       -> INotificationStreamConnectionAdmission
```

The dependency direction is always from the coordinator to a narrow port. Implementations do not reference or call back into `NotificationStreamHandshakeService`.

## Ownership

- `NotificationStreamHandshakeRequestValidator` owns deployment availability, WebSocket/protocol/auth header validation, and origin policy. Its only infrastructure ports are the origin snapshot, hosting environment, and deployment state.
- `NotificationStreamRiskProofPolicy` owns anonymous PoW compatibility, risk decisions, challenge proof/grant consumption, and best-effort risk signals. It does not resolve audiences or read account state.
- `NotificationStreamConnectionAdmission` owns identity projection, account admission, and audience resolution. It has no origin, PoW, risk, or proof dependencies.
- `NotificationStreamHandshakeService` only preserves sequencing and short-circuit behavior. It has three use-case dependencies and no direct infrastructure dependency bag.

## Preserved contract and rollback

The stream protocol remains `fsus-aeds.v2`. Existing status codes, `X-Fsus-*` proof headers, `Fsus-Notification-Grant` cookie, legacy `pow` query compatibility, admin audience rules, and preflight-before-WebSocket ordering remain unchanged.

Each module is registered behind a scoped interface. A rollback restores the previous module implementation without changing endpoints, cookies, headers, or stored data; in-flight request scopes finish on the old graph while new scopes use the deployed registration. There is no compatibility facade or duplicate implementation in the former service.

Focused tests cover request and risk short-circuits, grant handoff, origin/runtime behavior, admission identity projection, and the one-way constructor graph.
