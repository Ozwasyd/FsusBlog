import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const verifierFile = fileURLToPath(new URL('./media-codec-verifier.py', import.meta.url));
const codecIdentity = Object.freeze({ pillow: '12.3.0', jpeg: '6.2', jpegTurbo: '3.1.4.1', webp: '1.6.0', zlib: '1.3.1' });
const verifiedBytes = new Map();

export function verifyDecodedMediaBytes(bytes)
{
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4 * 1024 * 1024)
    {
        throw new Error('media codec encoded byte budget exceeded');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (verifiedBytes.has(digest))
    {
        return structuredClone(verifiedBytes.get(digest));
    }
    const execution = spawnSync('python3', [verifierFile], {
        input: bytes,
        timeout: 5000,
        maxBuffer: 8192,
        windowsHide: true
    });
    if (execution.error || execution.status !== 0)
    {
        throw new Error(`media codec unavailable or decode refused: ${execution.error?.code
            ?? execution.stderr.toString('utf8').slice(0, 512)}`);
    }
    const facts = JSON.parse(execution.stdout.toString('utf8'));
    if (facts.schema !== 'fsusblog.media-codec-observation.v1'
        || Object.keys(facts.codec ?? {}).length !== Object.keys(codecIdentity).length
        || Object.entries(codecIdentity).some(([key, value]) => facts.codec[key] !== value)
        || !/^sha256:[a-f0-9]{64}$/u.test(facts.pixelDigest ?? '')
        || !/^sha256:[a-f0-9]{64}$/u.test(facts.orientedPixelDigest ?? ''))
    {
        throw new Error('media codec observation identity or pixel digest invalid');
    }
    if (verifiedBytes.size === 16)
    {
        verifiedBytes.delete(verifiedBytes.keys().next().value);
    }
    verifiedBytes.set(digest, facts);
    return structuredClone(facts);
}
