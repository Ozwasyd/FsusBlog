# Frontend failure-telemetry privacy boundary

Binary request failures are no longer published as raw errors through a `window` CustomEvent. `binaryTransport` calls only the module-local `recordBinaryFailureTelemetry`, which projects input to the fixed fields `operationId`, `routeClass`, `status`, `errorCode`, `category`, and `frameType`. Raw URL, query, fragment, backend message/details, trace, Token, Proof, Session ID, Recovery Key, body, and business-object IDs never enter the projection.

`telemetryPrivacy.ts` is the shared browser-telemetry/console redaction boundary: binary failures use a strict allowlist, audit context uses sensitive-key/value redaction, and `safeConsole` normalizes arguments identically in development and production. Errors retain only name, stable code/kind, and HTTP status—not message, stack, or extra business fields; debug controls info-audit visibility but cannot bypass redaction.

`fsus:binary:failure` and `fsus:binary:error` have been removed. The classified payload from the internal recorder may still enter the shared telemetry bus, but same-origin listeners see only allowlisted stable enums. Forged legacy global events do not increment counters, write the audit console, or trigger a telemetry payload.

## Rollback and failure semantics

- Recorder, redactor, or browser-event dispatch failure still throws the original request error as `BinaryTransportError`; telemetry is best effort. Disable the info audit console without restarting; warn/error still use the same redactor.
- No debug fallback restores raw URL/details/trace. Troubleshoot by correlating `operationId`, category, and controlled server logs; do not expand the browser data surface.
