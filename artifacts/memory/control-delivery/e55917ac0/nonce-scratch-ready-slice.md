# P06.4 bounded nonce scratch: source-ready proposal, unimplemented

Current owner: src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs.
CspNonceUtf8Template.GetRenderedLength(int nonceUtf8Length) performs checked sizing.
CspNonceUtf8Template.Write(IBufferWriter<byte>, ReadOnlySpan<byte>, CancellationToken) validates base64url nonce and writes original immutable template segments directly.
CspNonceHtmlResponseWriter.WriteBodyAsync(HttpResponse, CspNonceUtf8Template, string, CancellationToken) currently encodes nonce into stackalloc byte[64], calls that actual Write method, then awaits the original BodyWriter.FlushAsync and checks IsCanceled/IsCompleted.
Actual consumer: PublicHotReadFastPath.Serving.cs ServeHtmlWithNonce, ending in this response writer.

A releasable component may own only:
- src/backend/Infrastructure/PublicAot/ReservedCspNonceScratchWriter.cs
- tests/backend/Unit/ReservedCspNonceScratchWriterTests.cs

Proposed component contract: Write(CspNonceUtf8Template template, string nonce, IBufferWriter<byte> destination, Span<byte> callerAdmittedNonceScratch, CancellationToken token). Preflight actual Encoding.UTF8.GetByteCount(nonce) against the finite supplied span; encode via the original Encoding.UTF8 span overload; invoke the existing template.Write(destination, encodedNonceSpan, token). Never encode or copy the shared HTML template, replace its digest/representation authority, allocate/grow backing, or create a lease/publisher. Invalid nonce, cancellation and per-segment behavior remain in the original template writer. Return no borrowed memory that can escape.

Root retains existing CspNonceUtf8Template.cs, CspNonceHtmlResponseWriter, PublicHotReadFastPath.Serving.cs, factory/publication, leases, ledger, registry and integration. A future admitted-scratch overload in the original response writer must run the component inside TransientBufferLease.ConsumeAsync and await the SAME real BodyWriter.FlushAsync/ThrowIfCanceled path before releasing the operation hold. Preserve cancellation between segment boundaries, pre-commit cancellation, actual pipe backpressure and aborted-reader assertions. Do not replace streaming with whole rendered-HTML buffering.

Required ordinary component oracles: canonical writer byte comparison for CJK/emoji and different nonce lengths; immutable TemplateDigest/IntegrityBytes unchanged; invalid UTF-8/base64url and undersized scratch reject without body writes; existing segment-cancellation and real Pipe backpressure/abort assertions at root integration. Fixture output buffers are not production defaults or native qualification.

Missing production inputs: actual caller-admitted scratch pool and finite production/probe/metadata bounds; accepted P01/P05/Auto stage evidence; original source/read ownership through serving. This proposal qualifies no native row, has not been released to a worker, and is not completion of P06.4 or #3456.
