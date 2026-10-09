# DocumentExport source options contract

This current source contract supplies the canonical Export endpoint owner (#3653); HTTP endpoint integration and runtime qualification remain that owner’s work. It adds typed AEDS payloads, not a parallel catalog or authorization authority. Related to #3735.

## Actual authority and privacy

Source catalog source `871b8e4f7474000dd5d3d79162d9e81fe0abf6b6` owns `IDocumentExportSourceCatalog.CaptureAsync(actor, requests, ct)` and `CaptureRevisionsAsync(actor, articleId, ct)`. Both capture persisted bindings; both require the original authenticated write/PoW POST boundary. An ordinary GET must not invoke either mutation. The endpoint obtains its real actor/site/session from the original authority; the payload has none of those fields. It preserves the existing one-body-read, cancellation, no-store and typed ApiError behavior.

The actual public response is only `Choices[]` of `ChoiceId`, `Label`, `Coordinate`. Private BoundSource, fingerprints, source bodies, rights/responsibility snapshots and actor/session binding rows are not serialized. The catalog retains its original private maximum512 bindings per scope; a response permits at most50 choices. No private store, cleanup, source-version allocation or authorization logic is added by this wire layer.

## Formal request and response roots

| Root | AEDS ID | Fields | Complete frame / payload cap |
| --- | --- | --- | --- |
| DocumentExportSourceCaptureRequest | 282 | Sources[], each Kind:Int32, ArticleId:positiveInt32, DraftKey:string?, RevisionId:Int64?, PublicationId:Int64? | 65,536B / 65,520B |
| DocumentExportRevisionChoicesRequest | 283 | ArticleId:positiveInt32 | 1,024B / 1,008B; canonical payload exactly8B |
| DocumentExportSourceChoicesResponse | 284 | Choices[] of ChoiceId:string, Label:string, Coordinate | 131,088B / 131,072B |

Coordinate includes Kind:Int32, ArticleId:positiveInt64, DraftKey:string?, RevisionId:Int64?, PublicationId:Int64?, independent positiveInt64 SourceVersion. TypeScript retains every Int64 as a canonical decimal string; no Number conversion or revision-derived version exists. Draft kind1 requires only the draft key, revision kind2 only revisionId, publication kind3 revisionId and publicationId. A client selector carries no SourceVersion; it cannot allocate one.

Shared DTOs: `src/shared/Contracts/DocumentExport/DocumentExportSourceOptionsContracts.cs`. Core encoder/decoder: `src/core/Cache/PodBinaryCodec.DocumentExportSourceOptions.cs`, with Encode/Write/TryDecode methods named after all three roots. The response is mapped exactly once in the sole binaryDecoderRegistry; requests are not response registrations.

## Bounded layout and failure semantics

Every payload begins with little-endian Int32 revision1. Capture and choices then contain an Int32 count0..50. Records follow Shared field order. Strings are an Int32 UTF8 byte count followed by strict UTF8; nullable values use a closed byte0/1 presence tag. Int64 values are exact signed little-endian64-bit numbers on wire. Entire payload consumption is mandatory. There is no JSON/text fallback, job/page projection or private source serialization.

Actual ChoiceId is exactly64 lowercase ASCII hex characters, from the catalog’s32-byte random binding ID. Draft key is bounded96 UTF16 units and preserves the catalog’s .NET trim requirement. Label is bounded256 UTF16 units, originating in ArticleProductionNormalizers.MaxTitleLength, actual draft normalization256 and persisted Article/Revision/Draft title columns256. Display labels are not identifiers and preserve valid Unicode rather than being sanitized by transport.

A valid UTF8 string uses at most3 bytes per UTF16 unit. Therefore the longest50-draft Capture payload is `8 + 50*(4+4+1+4+288+1+1) = 15158B`, or15174B complete frame. A longest50-choice payload is `8 + 50*(68+772+4+8+1+4+288+1+1+8) = 57758B`, or57774B complete frame. Canonical revision capture is8B payload/24B frame. These bounds prove the chosen caps; the128KiB choices cap is independent of job/page budgets and private512-binding retention.

Malformed new-family native payloads use dedicated `DocumentExportSourceOptionsPayloadInvalid=19` and `document_export_source_options_payload_invalid`; existing job/request/page roots retain error18. Unknown/retired frame and header guards remain earlier; new-family flags/budgets precede CRC, bounded typed payload validation follows CRC. Invalid managed writes throw the same new stable reason; TryDecode returns false. Endpoint owner maps errors through its existing typed ApiError authority.

## Exact current-master closure

Checked master `9d72a1c93b297f719d8695a642cdfb1615cf1d51` already contains byte-identical existing Export Core models/codec, but lacks roots278–281 and their cross-stack products. This branch supplies those four roots plus282–284, preserving their existing wire IDs, schema and job/page limits. Original current-master244 frame entries remain byte-for-byte equivalent as parsed records; other domains are not copied from the frozen aggregate.

Original producer requires a dense goldenOrder. The current-master closure appends244–250; frozen full registry used269–275 because it also included25 additional domains. This catalog ordering is explicitly different; IDs/layouts are unchanged. No producer constraint was relaxed and no old whole generated catalog was copied. Products are regenerated by original AEDS and wire producers. Original scalar/whitespace/digest native primitives are extracted unchanged into the Export-only header, avoiding unrelated WritingAid production contracts.

## Acceptance limits

Literal payload oracles, exact selection rosters, negative controls and command artifacts must be bound to the published tested source. Node/native parity does not establish managed executable, actual catalog PostgreSQL, HTTP/session/PoW, device/provider, rendered UX or full frontend-type acceptance. The canonical endpoint owner must consume this exact closure and prove real handlers before those stages are accepted. No issue closure, deployment or merge is authorized here.
