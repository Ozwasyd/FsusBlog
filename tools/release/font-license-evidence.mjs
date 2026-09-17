import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const FONT_LICENSE_EVIDENCE_SCHEMA = 'fsusblog.font.license.v1';

const KNOWN_LICENSES = new Set(['Apache-2.0', 'MIT', 'OFL-1.1']);
const KNOWN_SOURCE_KINDS = new Set(['local-vendored', 'npm-fontsource']);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FONT_ID_PATTERN = /^fsusblog\.font\.[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function validateFontLicenseEvidence(summary)
{
    const errors = [];
    if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    {
        return ['font license evidence must be an object'];
    }
    if (summary.schema !== FONT_LICENSE_EVIDENCE_SCHEMA)
    {
        errors.push(`schema must be ${FONT_LICENSE_EVIDENCE_SCHEMA}`);
    }
    if (summary.status !== 'ok')
    {
        errors.push(`status must be ok, got ${String(summary.status)}`);
    }
    if (!Array.isArray(summary.fonts))
    {
        errors.push('fonts must be an array');
    }
    if (!Array.isArray(summary.violations) || summary.violations.length !== 0)
    {
        errors.push('violations must be an empty array');
    }

    const ids = new Set();
    for (const [index, font] of (summary.fonts ?? []).entries())
    {
        const label = `fonts[${index}]`;
        if (!font || typeof font !== 'object' || Array.isArray(font))
        {
            errors.push(`${label} must be an object`);
            continue;
        }
        if (!FONT_ID_PATTERN.test(String(font.id ?? '')))
        {
            errors.push(`${label}.id is invalid`);
        }
        else if (ids.has(font.id))
        {
            errors.push(`${label}.id is duplicated`);
        }
        ids.add(font.id);
        if (!KNOWN_LICENSES.has(font.license))
        {
            errors.push(`${label}.license is unknown`);
        }
        if (typeof font.source !== 'string'
            || !/^.+@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(font.source)
            || font.source.includes('://')
            || font.source.startsWith('//'))
        {
            errors.push(`${label}.source is invalid`);
        }
        if (font.hashVerified !== true)
        {
            errors.push(`${label}.hashVerified must be true`);
        }
    }
    return errors;
}

export function readAndValidateFontLicenseEvidence(file)
{
    const resolved = path.resolve(file);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
    {
        throw new Error('font license evidence must be a regular non-symlink file');
    }
    const summary = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    const errors = validateFontLicenseEvidence(summary);
    if (errors.length > 0)
    {
        throw new Error(errors.join('; '));
    }
    return summary;
}

export function generateFontLicenseEvidence(registryRoot)
{
    const resolvedRoot = path.resolve(registryRoot);
    const registryFile = path.join(resolvedRoot, 'registry.json');
    const document = fs.existsSync(registryFile)
        ? JSON.parse(fs.readFileSync(registryFile, 'utf8'))
        : { fonts: [] };
    const fonts = [];
    const violations = [];
    if (!Array.isArray(document.fonts))
    {
        throw new Error('font registry fonts must be an array');
    }

    for (const entry of document.fonts
        .filter((candidate) => candidate?.builtIn !== true)
        .sort((left, right) => String(left?.id).localeCompare(String(right?.id))))
    {
        const fontId = FONT_ID_PATTERN.test(String(entry?.id ?? ''))
            ? entry.id
            : 'fsusblog.font.invalid';
        let manifest = null;
        let source = null;
        try
        {
            manifest = JSON.parse(entry.manifestJson);
            source = JSON.parse(entry.licenseSourceJson);
        }
        catch
        {
            addViolation(violations, 'font_metadata_invalid', fontId);
        }

        const manifestFaces = Array.isArray(manifest?.faces) ? manifest.faces : [];
        const registryFaces = Array.isArray(entry?.faces) ? entry.faces : [];
        const sourceValid = source
            && KNOWN_SOURCE_KINDS.has(source.kind)
            && typeof source.package === 'string'
            && typeof source.version === 'string'
            && typeof source.upstream === 'string'
            && source.kind === manifest?.source?.kind
            && source.package === manifest?.source?.package
            && source.version === manifest?.source?.version
            && source.upstream === manifest?.source?.upstream
            && !source.package.includes('://')
            && !source.upstream.includes('://');
        const metadataValid = manifest
            && manifest.id === entry.id
            && KNOWN_LICENSES.has(manifest.license?.name)
            && typeof entry.licenseText === 'string'
            && entry.licenseText.trim().length > 0
            && sourceValid
            && manifestFaces.length > 0
            && manifestFaces.length === registryFaces.length;
        if (!metadataValid)
        {
            addViolation(violations, 'font_metadata_invalid', fontId);
        }

        let hashVerified = metadataValid;
        for (const face of registryFaces)
        {
            const hash = String(face?.contentHash ?? '');
            const declared = manifestFaces.some((candidate) =>
                candidate?.contentHash === hash
                && candidate?.weight === face?.weight
                && candidate?.style === face?.style);
            if (!SHA256_PATTERN.test(hash) || !declared)
            {
                addViolation(violations, 'font_metadata_invalid', fontId);
                hashVerified = false;
                continue;
            }

            const assetFile = path.join(resolvedRoot, 'assets', `${hash}.woff2`);
            if (!fs.existsSync(assetFile))
            {
                addViolation(violations, 'font_asset_missing', fontId);
                hashVerified = false;
                continue;
            }
            const stat = fs.lstatSync(assetFile);
            const content = stat.isFile() && !stat.isSymbolicLink()
                ? fs.readFileSync(assetFile)
                : null;
            const actualHash = content
                ? crypto.createHash('sha256').update(content).digest('hex')
                : '';
            if (!content
                || stat.size !== face.sizeBytes
                || actualHash !== hash)
            {
                addViolation(violations, 'font_asset_hash_mismatch', fontId);
                hashVerified = false;
            }
        }

        fonts.push({
            id: fontId,
            license: String(manifest?.license?.name ?? 'unknown'),
            source: `${String(source?.package ?? 'unknown')}@${String(source?.version ?? '0.0.0')}`,
            hashVerified
        });
    }

    return {
        schema: FONT_LICENSE_EVIDENCE_SCHEMA,
        status: violations.length === 0 ? 'ok' : 'blocked',
        fonts,
        violations: violations.sort((left, right) =>
            left.fontId.localeCompare(right.fontId) || left.code.localeCompare(right.code))
    };
}

export function writeFontLicenseEvidence(registryRoot, outputFile)
{
    const evidence = generateFontLicenseEvidence(registryRoot);
    const resolved = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temporary = path.join(
        path.dirname(resolved),
        `.font-license-${process.pid}-${crypto.randomUUID()}.tmp`);
    try
    {
        fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600
        });
        fs.renameSync(temporary, resolved);
    }
    finally
    {
        fs.rmSync(temporary, { force: true });
    }
    return evidence;
}

function addViolation(violations, code, fontId)
{
    if (!violations.some((item) => item.code === code && item.fontId === fontId))
    {
        violations.push({ code, fontId });
    }
}

if (process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)))
{
    try
    {
        const generateIndex = process.argv.indexOf('--generate');
        if (generateIndex >= 0)
        {
            const registryRoot = process.argv[generateIndex + 1];
            const outputIndex = process.argv.indexOf('--output');
            const output = outputIndex >= 0
                ? process.argv[outputIndex + 1]
                : path.resolve('.tmp/release-evidence/font-license-summary.json');
            if (!registryRoot || !output)
            {
                throw new Error('--generate requires a registry root and --output requires a file');
            }
            const generated = writeFontLicenseEvidence(registryRoot, output);
            if (generated.status !== 'ok')
            {
                throw new Error(`generated evidence is ${generated.status}`);
            }
            console.log(`[font-license] generated fonts=${generated.fonts.length} file=${output}`);
            process.exit(0);
        }

        const file = process.argv[2]
            ?? path.resolve('.tmp/release-evidence/font-license-summary.json');
        const summary = readAndValidateFontLicenseEvidence(file);
        console.log(`[font-license] ok fonts=${summary.fonts.length} file=${file}`);
    }
    catch (error)
    {
        console.error(`[font-license] ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
