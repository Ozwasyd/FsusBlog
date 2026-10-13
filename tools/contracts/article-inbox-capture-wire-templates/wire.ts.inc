export interface ArticleInboxCaptureRequest {
    schemaVersion: 1; requestId: string; expectedSiteScope: string; title: string; markdownContent: string;
}
export interface ArticleInboxCaptureReceipt {
    receiptId: string; requestId: string; ownerAdminPrincipalId: string; articleId: number;
    draftId: string; draftServerRevision: string; revisionId: string; revisionNo: number;
    outboxEventId: string; auditReference: string; auditDigest: string; sourceDigest: string;
    contentDigest: string; occurredAtUtcTicks: string; isIdempotentReplay: boolean;
}
export interface ArticleInboxCaptureResponse {
    schemaVersion: 1; requestId: string; authenticatedAdminPrincipalId: string;
    requestSiteScope: string; receipt: ArticleInboxCaptureReceipt | null;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const requestKeys = ['schemaVersion', 'requestId', 'expectedSiteScope', 'title', 'markdownContent'];
const responseKeys = ['schemaVersion', 'requestId', 'authenticatedAdminPrincipalId', 'requestSiteScope', 'receipt'];
const receiptKeys = ['receiptId', 'requestId', 'ownerAdminPrincipalId', 'articleId', 'draftId', 'draftServerRevision',
    'revisionId', 'revisionNo', 'outboxEventId', 'auditReference', 'auditDigest', 'sourceDigest', 'contentDigest',
    'occurredAtUtcTicks', 'isIdempotentReplay'];
function invalid(): never { throw new RangeError('article_inbox_capture_payload_invalid'); }
function exact(value: unknown, keys: readonly string[]): void {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
}
function integer64(value: string): bigint {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) invalid();
    const parsed = BigInt(value); if (parsed > 9223372036854775807n) invalid(); return parsed;
}
function guid(value: string): void {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
        || value === '00000000-0000-0000-0000-000000000000') invalid();
}
function white(code: number): boolean {
    return code >= 9 && code <= 13 || code === 32 || code === 133 || code === 160 || code === 5760
        || code >= 8192 && code <= 8202 || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288;
}
function text(value: string, maxUnits: number, maxBytes: number, controls: boolean): Uint8Array {
    if (typeof value !== 'string' || value.length > maxUnits) invalid();
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code >= 0xd800 && code <= 0xdfff || controls && (code < 32 || code >= 127 && code <= 159)) invalid();
    }
    const bytes = encoder.encode(value); if (bytes.length > maxBytes) invalid(); return bytes;
}
function site(value: string): void {
    text(value, 128, 512, true);
    const chars = Array.from(value); if (chars.length === 0 || white(chars[0]!.codePointAt(0)!)
        || white(chars[chars.length - 1]!.codePointAt(0)!)) invalid();
}
function digest(value: string, size = 64): void {
    if (typeof value !== 'string' || value.length !== size || !/^[0-9a-f]+$/u.test(value)) invalid();
}
function request(value: ArticleInboxCaptureRequest): void {
    exact(value, requestKeys); if (value.schemaVersion !== 1) invalid(); guid(value.requestId); site(value.expectedSiteScope);
    text(value.title, 256, 1024, true); text(value.markdownContent, 200000, 800000, false);
    if ([value.title, value.markdownContent].every(part => Array.from(part).every(character => white(character.codePointAt(0)!)))) invalid();
}
function receipt(value: ArticleInboxCaptureReceipt): void {
    exact(value, receiptKeys); guid(value.receiptId); guid(value.requestId); integer64(value.ownerAdminPrincipalId);
    if (!Number.isInteger(value.articleId) || value.articleId < 1 || value.articleId > 2147483647
        || value.revisionNo !== 1 || value.draftServerRevision !== '1' || typeof value.isIdempotentReplay !== 'boolean') invalid();
    integer64(value.draftId); integer64(value.revisionId); guid(value.auditReference); digest(value.outboxEventId, 32);
    digest(value.auditDigest); digest(value.sourceDigest); digest(value.contentDigest);
    if (integer64(value.occurredAtUtcTicks) > 3155378975999999999n) invalid();
}
function response(value: ArticleInboxCaptureResponse): void {
    exact(value, responseKeys); if (value.schemaVersion !== 1) invalid(); guid(value.requestId);
    integer64(value.authenticatedAdminPrincipalId); site(value.requestSiteScope);
    if (value.receipt !== null) {
        receipt(value.receipt);
        if (value.receipt.requestId.toLowerCase() !== value.requestId.toLowerCase()
            || value.receipt.ownerAdminPrincipalId !== value.authenticatedAdminPrincipalId) invalid();
    }
}
class Writer {
    private readonly bytes: number[] = [];
    byte(value: number): void { this.bytes.push(value); }
    i32(value: number): void { for (let n = 0; n < 4; n++) this.byte(value >>> (n * 8) & 255); }
    i64(value: string): void { let bits = integer64(value); for (let n = 0; n < 8; n++) { this.byte(Number(bits & 255n)); bits >>= 8n; } }
    uuid(value: string): void { const hex = value.replaceAll('-', ''); for (let n = 0; n < 32; n += 2) this.byte(Number.parseInt(hex.slice(n, n + 2), 16)); }
    text(value: string): void { const bytes = encoder.encode(value); this.i32(bytes.length); for (const byte of bytes) this.byte(byte); }
    finish(): Uint8Array { return Uint8Array.from(this.bytes); }
}
class Reader {
    private offset = 0; private readonly view: DataView;
    constructor(private readonly bytes: Uint8Array, limit: number) {
        if (!(bytes instanceof Uint8Array) || bytes.length > limit) invalid(); this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    take(size: number): number { if (size < 0 || size > this.bytes.length - this.offset) invalid(); const old = this.offset; this.offset += size; return old; }
    byte(): number { return this.view.getUint8(this.take(1)); }
    bool(): boolean { const value = this.byte(); if (value > 1) invalid(); return value === 1; }
    i32(): number { return this.view.getInt32(this.take(4), true); }
    i64(): string { const value = this.view.getBigInt64(this.take(8), true).toString(); integer64(value); return value; }
    uuid(): string { const start = this.take(16); const hex = Array.from(this.bytes.subarray(start, start + 16), n => n.toString(16).padStart(2, '0')).join('');
        const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; guid(value); return value; }
    text(limit: number): string { const size = this.i32(); if (size < 0 || size > limit) invalid(); const start = this.take(size); return decoder.decode(this.bytes.subarray(start, start + size)); }
    finish(): void { if (this.offset !== this.bytes.length) invalid(); }
}
export function encodeArticleInboxCaptureRequest(value: ArticleInboxCaptureRequest): Uint8Array {
    request(value); const writer = new Writer(); writer.i32(1); writer.uuid(value.requestId); writer.text(value.expectedSiteScope);
    writer.text(value.title); writer.text(value.markdownContent); return writer.finish();
}
export function decodeArticleInboxCaptureRequest(bytes: Uint8Array): ArticleInboxCaptureRequest {
    const reader = new Reader(bytes, 801568); const value: ArticleInboxCaptureRequest = { schemaVersion: reader.i32() as 1,
        requestId: reader.uuid(), expectedSiteScope: reader.text(512), title: reader.text(1024), markdownContent: reader.text(800000) };
    reader.finish(); request(value); return value;
}
export function encodeArticleInboxCaptureResponse(value: ArticleInboxCaptureResponse): Uint8Array {
    response(value); const writer = new Writer(); writer.i32(1); writer.uuid(value.requestId); writer.i64(value.authenticatedAdminPrincipalId);
    writer.text(value.requestSiteScope); writer.byte(value.receipt === null ? 0 : 1);
    if (value.receipt) { const r = value.receipt; writer.uuid(r.receiptId); writer.uuid(r.requestId); writer.i64(r.ownerAdminPrincipalId);
        writer.i32(r.articleId); writer.i64(r.draftId); writer.i64(r.draftServerRevision); writer.i64(r.revisionId); writer.i32(r.revisionNo);
        writer.text(r.outboxEventId); writer.uuid(r.auditReference); writer.text(r.auditDigest); writer.text(r.sourceDigest);
        writer.text(r.contentDigest); writer.i64(r.occurredAtUtcTicks); writer.byte(r.isIdempotentReplay ? 1 : 0); }
    return writer.finish();
}
export function decodeArticleInboxCaptureResponse(bytes: Uint8Array): ArticleInboxCaptureResponse {
    const reader = new Reader(bytes, 882); const schema = reader.i32(); const requestId = reader.uuid();
    const owner = reader.i64(); const scope = reader.text(512); let r: ArticleInboxCaptureReceipt | null = null;
    if (reader.bool()) r = { receiptId: reader.uuid(), requestId: reader.uuid(), ownerAdminPrincipalId: reader.i64(),
        articleId: reader.i32(), draftId: reader.i64(), draftServerRevision: reader.i64(), revisionId: reader.i64(), revisionNo: reader.i32(),
        outboxEventId: reader.text(32), auditReference: reader.uuid(), auditDigest: reader.text(64), sourceDigest: reader.text(64),
        contentDigest: reader.text(64), occurredAtUtcTicks: reader.i64(), isIdempotentReplay: reader.bool() };
    reader.finish(); const value: ArticleInboxCaptureResponse = { schemaVersion: schema as 1, requestId,
        authenticatedAdminPrincipalId: owner, requestSiteScope: scope, receipt: r }; response(value); return value;
}
export function matchesArticleInboxCaptureRequest(input: ArticleInboxCaptureRequest, output: ArticleInboxCaptureResponse): boolean {
    try { request(input); response(output); return input.requestId.toLowerCase() === output.requestId.toLowerCase()
        && input.expectedSiteScope === output.requestSiteScope; } catch { return false; }
}
