import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const approvalScopeCorpus = JSON.parse(readFileSync(path.join(root,
    'tests/fixtures/protocol/authoring-extension-approval-scope-text-golden.json'), 'utf8'));
export function scopeHostText(vector)
{
    if (vector.utf16Hex === null) return null;
    const bytes = Buffer.from(vector.utf16Hex, 'hex');
    let value = '';
    for (let index = 0; index < bytes.length; index += 2) value += String.fromCharCode(bytes.readUInt16LE(index));
    return value;
}
export function scopePayloadWitness(field, vector)
{
    const base = Buffer.from(approvalScopeCorpus.basePayloadHex, 'hex');
    let start = field.offset;
    let count = field.encodedLength;
    let replacement;
    if (vector.hasHostValue && vector.utf16Hex === null)
    {
        if (field.nullable)
        {
            start = field.nullableOffset;
            count++;
            replacement = Buffer.from([0]);
        }
        else
        {
            replacement = Buffer.alloc(4, 255);
        }
    }
    else
    {
        const utf8 = Buffer.from(vector.utf8Hex, 'hex');
        const length = Buffer.alloc(4);
        length.writeInt32LE(utf8.length);
        replacement = Buffer.concat([length, utf8]);
    }
    // Deliberately mutate one scalar in an original generated payload; no alternate frame codec.
    return Uint8Array.from(Buffer.concat([base.subarray(0, start), replacement, base.subarray(start + count)]));
}
export function scopeNativeWitnesses()
{
    return approvalScopeCorpus.vectors.flatMap(vector => approvalScopeCorpus.fields.map((field, index) => ({
        frameType: approvalScopeCorpus.frameType, name: field.name + '-' + vector.name,
        valid: vector.expectedByField[index], payloadHex: Buffer.from(scopePayloadWitness(field, vector)).toString('hex')
    })));
}
