const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function invalid(): never { throw new RangeError('document_export_payload_invalid'); }
function whitespace(code: number): boolean {
    return code === 32 || code === 133 || code === 160 || code === 5760 || code >= 8192 && code <= 8202
        || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288;
}
function text(value: unknown, reason: boolean): asserts value is string {
    if (typeof value !== 'string' || value.length > (reason ? 2048 : 192)) invalid();
    let nonWhitespace = false;
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if (code < 32 || code >= 127 && code <= 159 || code >= 0xd800 && code <= 0xdfff) invalid();
        if (!whitespace(code)) nonWhitespace = true;
    }
    if (!reason && !nonWhitespace) invalid();
}
function integer64(value: unknown): bigint {
    if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(value)) invalid();
    const parsed = BigInt(value);
    if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) invalid();
    return parsed;
}
function checkField(type: string, value: unknown, key: string): void {
    if (type.endsWith('?')) { if (value !== null) checkField(type.slice(0, -1), value, key); return; }
    if (type.startsWith('IReadOnlyList<')) {
        if (!Array.isArray(value) || value.length > (key === 'attempts' ? 3 : 50)) invalid();
        for (const item of value) checkRecord(type.slice(14, -1), item);
    } else if (type === 'string') {
        text(value, key === 'reason');
        if (key.endsWith('Digest') && !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid();
        if (key === 'formatId' && !['self-contained-html', 'pdf', 'docx', 'epub'].includes(value)) invalid();
    } else if (type === 'long') {
        const parsed = integer64(value);
        if (['articleId', 'revisionId', 'publicationId', 'sourceVersion', 'version'].includes(key) && parsed <= 0n
            || key === 'length' && parsed < 0n
            || key.endsWith('AtUnixMs') && (parsed < -62135596800000n || parsed > 253402300799999n)) invalid();
    } else if (type === 'int') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) invalid();
    } else if (type === 'bool') { if (typeof value !== 'boolean') invalid(); }
    else checkRecord(type, value);
}
function checkRecord(type: string, value: unknown): asserts value is Record<string, unknown> {
    const fields = schemas[type];
    if (!fields || !value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).length !== fields.length || !fields.every(([key]) => Object.hasOwn(value, key))) invalid();
    const record = value as Record<string, unknown>;
    for (const [key, fieldType] of fields) checkField(fieldType, record[key], key);
    if (type === 'DocumentExportSource') {
        if (record.kind === 1 ? record.draftKey === null || record.revisionId !== null || record.publicationId !== null
            : record.kind === 2 ? record.draftKey !== null || record.revisionId === null || record.publicationId !== null
                : record.kind === 3 ? record.draftKey !== null || record.revisionId === null || record.publicationId === null : true) invalid();
    }
    if (Object.hasOwn(record, 'status') && ((record.status as number) < 1 || (record.status as number) > 10)) invalid();
    if (Object.hasOwn(record, 'expiresAtUnixMs') && integer64(record.expiresAtUnixMs) <= integer64(record.createdAtUnixMs)) invalid();
    if (type === 'DocumentExportAttempt' && record.finishedAtUnixMs !== null && integer64(record.finishedAtUnixMs) < integer64(record.startedAtUnixMs)) invalid();
    if (type === 'DocumentExportJobResponse') {
        const attempts = record.attempts as DocumentExportAttempt[];
        if (attempts.some((attempt, index) => attempt.number !== index + 1)) invalid();
    }
    if (type === 'DocumentExportPageResponse') {
        const jobs = record.jobs as DocumentExportJobResponse[];
        if ((record.offset as number) < 0 || (record.limit as number) < 1 || (record.limit as number) > 50 || jobs.length > (record.limit as number)
            || record.hasMore && jobs.length !== record.limit || new Set(jobs.map(job => job.taskId)).size !== jobs.length) invalid();
    }
}
class Reader {
    private readonly data: Uint8Array;
    private readonly view: DataView;
    private offset = 0;
    constructor(data: Uint8Array) { this.data = data; this.view = new DataView(data.buffer, data.byteOffset, data.byteLength); }
    take(count: number): number { if (count < 0 || count > this.data.length - this.offset) invalid(); const start = this.offset; this.offset += count; return start; }
    int32(): number { return this.view.getInt32(this.take(4), true); }
    int64(): string { return this.view.getBigInt64(this.take(8), true).toString(); }
    boolean(): boolean { const value = this.data[this.take(1)]; if (value > 1) invalid(); return value === 1; }
    string(reason: boolean): string { const length = this.int32(); if (length < 0 || length > (reason ? 2048 : 192) * 4) invalid(); const start = this.take(length); return decoder.decode(this.data.subarray(start, start + length)); }
    consumed(): boolean { return this.offset === this.data.length; }
    field(type: string, key: string): unknown {
        if (type.endsWith('?')) return this.boolean() ? this.field(type.slice(0, -1), key) : null;
        if (type.startsWith('IReadOnlyList<')) { const count = this.int32(); if (count < 0 || count > (key === 'attempts' ? 3 : 50)) invalid(); return Array.from({ length: count }, () => this.record(type.slice(14, -1))); }
        if (type === 'int') return this.int32();
        if (type === 'long') return this.int64();
        if (type === 'bool') return this.boolean();
        if (type === 'string') return this.string(key === 'reason');
        return this.record(type);
    }
    record(type: string): Record<string, unknown> { const result: Record<string, unknown> = {}; for (const [key, fieldType] of schemas[type]) result[key] = this.field(fieldType, key); return result; }
}
class Writer {
    private readonly chunks: Uint8Array[] = [];
    private length = 0;
    private add(bytes: Uint8Array): void { this.chunks.push(bytes); this.length += bytes.length; }
    int32(value: number): void { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, value, true); this.add(bytes); }
    field(type: string, value: unknown): void {
        if (type.endsWith('?')) { this.add(Uint8Array.of(value === null ? 0 : 1)); if (value !== null) this.field(type.slice(0, -1), value); }
        else if (type.startsWith('IReadOnlyList<')) { const values = value as Record<string, unknown>[]; this.int32(values.length); for (const item of values) this.record(type.slice(14, -1), item); }
        else if (type === 'int') this.int32(value as number);
        else if (type === 'long') { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, integer64(value), true); this.add(bytes); }
        else if (type === 'bool') this.add(Uint8Array.of(value ? 1 : 0));
        else if (type === 'string') { const bytes = encoder.encode(value as string); this.int32(bytes.length); this.add(bytes); }
        else this.record(type, value as Record<string, unknown>);
    }
    record(type: string, value: Record<string, unknown>): void { for (const [key, fieldType] of schemas[type]) this.field(fieldType, value[key]); }
    finish(budget: number): Uint8Array { if (this.length > budget) invalid(); const result = new Uint8Array(this.length); let offset = 0; for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
}
function encodeRoot(type: string, value: unknown): Uint8Array { checkRecord(type, value); const writer = new Writer(); writer.int32(1); writer.record(type, value); return writer.finish(budgets[type]); }
function decodeRoot(type: string, payload: Uint8Array): Record<string, unknown> { if (!(payload instanceof Uint8Array) || payload.length < 4 || payload.length > budgets[type]) invalid(); const reader = new Reader(payload); if (reader.int32() !== 1) invalid(); const value = reader.record(type); if (!reader.consumed()) invalid(); checkRecord(type, value); return value; }
