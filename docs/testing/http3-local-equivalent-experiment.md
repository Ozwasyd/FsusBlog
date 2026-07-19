# HTTP/3 + QUIC local-equivalent experiment

This is a Kestrel-only, single-process experiment for issue #1176. It does not publish a public endpoint, configure nginx/CDN, or support a claim about the public Internet. HTTP/3 remains off by default.

## Runtime contract

The opt-in configuration is startup-only:

```text
RuntimeTuning__Http3__Enabled=true
RuntimeTuning__Http3__Port=5443
RuntimeTuning__Http3__CertificatePath=/absolute/path/server.pfx
RuntimeTuning__Http3__CertificatePassword=<runtime secret>
ASPNETCORE_URLS=https://localhost:5443
```

All prerequisites must pass:

- the configured endpoint is HTTPS and its port equals `RuntimeTuning:Http3:Port`;
- the PFX exists, is currently valid and has a private key;
- `QuicListener.IsSupported` confirms a usable MsQuic and TLS 1.3 stack;
- Kestrel retains the declared endpoint rather than adding or replacing a listener.

Only then does Kestrel use `HttpProtocols.Http1AndHttp2AndHttp3`. H3 is never configured alone. The same port accepts TCP for H1/H2 and UDP for H3, and Kestrel advertises the upgrade through `Alt-Svc`. Missing MsQuic, a missing or invalid certificate, a non-HTTPS or mismatched endpoint, and an invalid port all produce a bounded `fallback` report and leave the existing endpoint defaults unchanged.

The certificate must come from a local CA trusted by the test clients and include the lab hostname (`fsusblog.test` or `localhost`) as a SAN. Do not use Kestrel's default self-signed development certificate for browser evidence. Never commit the CA key, server key, PFX or password. The runner creates them below `/tmp` and deletes them on exit.

On Linux/WSL/container hosts, install a .NET-compatible `libmsquic` and its native dependencies. On Windows 11, .NET ships the Windows MsQuic support but the firewall must allow UDP on the selected local port. Container/WSL forwarding must expose the same numeric TCP and UDP port; forwarding TCP alone is not H3 support.

## Repeatable runner

The runner needs .NET 10, OpenSSL, Docker, `ip`, and a local Docker bridge. On Linux, point `FSUSBLOG_MSQUIC_LIB_DIR` to the directory containing `libmsquic.so.2` when it is not installed system-wide:

```bash
FSUSBLOG_MSQUIC_LIB_DIR=/opt/fsusblog-http3/lib \
FSUSBLOG_HTTP3_EVIDENCE_DIR=.tmp/http3-$(date -u +%Y%m%dT%H%M%SZ) \
tools/transport/run-http3-local-experiment.sh
```

The runner uses:

- the .NET probe with `RequestVersionExact` for H2 and H3;
- the digest-pinned curl HTTP/3 image with `--http3-only` as an independent client;
- a privileged, disposable client container to block only outbound UDP/5443 and prove `curl --http3` still succeeds over H2;
- a disposable client network namespace with `tc netem`, never the host interface;
- a second lab startup without the injected MsQuic directory when the host does not otherwise provide QUIC.

The output directory contains only logs, JSON/CSV measurements and `summary.json`; it contains no certificate or private key. `summary.json` remains `incomplete` unless both clients prove H3, the fallback checks pass, and every network condition has three successful H2 and H3 rounds.

## Matrix and scenario coverage

Keep the commit, release build, host, certificate, dataset, request order, process limits and client versions fixed. Rotate H2/H3 order in longer studies to reduce warmup bias. Run at least three rounds for:

| Condition | Required evidence |
|---|---|
| baseline | 0 added delay, 0% loss |
| delay | 40 ms, 100 ms and 200 ms equivalents |
| loss | 1%, 3% and 5% |
| connection | reused and cold connections; reconnect after restart |
| cache | cold and hot application cache |
| surfaces | Public AOT, JS/CSS/font, Wasm, search, AEDS, concurrent small objects and larger static payload |
| mutations | upload, cancellation and timeout |
| fallback | UDP blocked; MsQuic absent; client without H3 |

For each cell retain actual negotiated protocol, status or error category, bytes, throughput, p50/p95/p99, server CPU time and RSS. TLS/QUIC/version-negotiation failures stay in the probe's fixed error categories. Do not add IPs, raw URLs with identifiers, cookies, tokens or client IDs as metric tags.

The transport lab routes validate transport mechanics and resource measurement. Release qualification must additionally run existing application tests for anonymous and authenticated requests, admin authorization, CSP/Trusted Types/HSTS and `X-Fsus-*` headers, cookie/CSRF/cache isolation, Range/ETag/compression/immutable assets, Public AOT hydration, Wasm/AEDS decode, upload cancellation/timeout/rate limits, notification stream/WebSocket fallback, and OpenTelemetry correlation. HTTP version negotiation must not change those semantics.

## 2026-07-19 local observation

The implementation was exercised on Ubuntu 24.04 with .NET/ASP.NET Core 10.0.8, a temporary local CA, `libmsquic 2.5.7`, the .NET exact-version probe and a digest-pinned curl 8.17.0-dev/quiche client. Both exact H2 and exact H3 completed 12/12 Public AOT lab requests; a 2 MiB H3 cold-connection run completed 8/8. The independent curl client negotiated H3 and returned 200. With UDP/5443 rejected inside that client namespace, curl fell back to H2 and still returned 200. Without the injected MsQuic library, the same opt-in HTTPS listener retained the local certificate, stayed on H2 and returned 200.

The disposable `tc netem` matrix completed three H2 and three H3 AEDS rounds for baseline, 40/100/200 ms added-delay equivalents and 1/3/5% loss. This is functional local evidence, not a statistically sufficient performance recommendation. Cold H3 did not show a stable advantage in this small sample, so the release decision is `keep_opt_in_experiment`; the default remains off and no public performance claim is permitted.

## Risks and rollback

- UDP may be blocked or rate-limited while TCP remains healthy. Clients automatically stay on H2/H1 because the endpoint always coexists; this is the no-restart traffic downgrade.
- A bad certificate or endpoint mismatch never activates the H3 defaults. When MsQuic alone is missing, the validated experiment certificate is still applied to the declared HTTPS endpoint while protocol defaults remain H1/H2, so the existing site remains available and avoids a startup failure loop.
- Protocol selection is a Kestrel startup property. To stop advertising H3 globally, set `RuntimeTuning:Http3:Enabled=false` and perform the normal retained-image restart. Do not mutate a running listener or remove H1/H2.
- If CPU, RSS, tail latency or errors regress, keep the experiment profile disabled. Removing the optional configuration has no API, AEDS, notification, authentication or cache migration cost.
