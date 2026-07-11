# Release storage compatibility matrix

Every release publishes `fsusblog.release-compatibility.v1` metadata with:

- immutable `frontendBuildId`;
- backend protocol `current/min/max`;
- AEDS `emitVersion/minDecoderVersion/maxDecoderVersion`;
- notification stream `current/minClientVersion/maxClientVersion`;
- `serviceWorkerNamespace`;
- Wasm ABI `current/minConsumerVersion/maxConsumerVersion`;
- the release asset manifest SHA-256 when bound by the release evidence step.

The blocking matrix is:

| Scenario | Required result | Failure action |
| --- | --- | --- |
| N client -> N server | all protocol ranges overlap | block candidate |
| N-1 client -> N server | backend, AEDS, notification and Wasm ranges overlap | block switch or add compatibility support |
| previous client -> N server | old cached page remains usable | retain previous server or restore compatibility |
| old service worker -> retained assets | every referenced old release asset exists with matching hash | restore retention before switch |
| old decoder -> N AEDS frame | emitted AEDS version is in old decoder range | keep old frame version or version the endpoint |

`buildCompatibilityMatrix` emits `fsusblog.release-compatibility-matrix.v1`; only `status=pass` may proceed. A new protocol version expands compatible ranges before changing the emitted/current version. Removing N-1 support requires an explicit migration window, cache/service-worker expiry evidence, and a release policy change; it is not inferred from age.
