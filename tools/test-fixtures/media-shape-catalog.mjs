import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateJsonSchema } from '../test-matrix/schema-validator/validate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const mediaShapeCatalogFile = path.join(root, 'config/testing/media-shape-catalog.json');
export const mediaShapeCatalogSchemaFile = path.join(root, 'config/schemas/media-shape-catalog.schema.json');

export const MEDIA_ASPECT_IDS = Object.freeze(['1x1', '3x2', '3x4', '4x3', '9x16', '16x9']);
export const MEDIA_CONSUMER_CLASSES = Object.freeze(['aot', 'archive', 'cache', 'crop', 'detail', 'fallback', 'home-cover', 'hydration', 'lazy', 'scale']);
export const MEDIA_FORMAT_IDS = Object.freeze(['jpeg', 'png', 'svg', 'webp']);
export const MEDIA_POSITIVE_SHAPE_IDS = Object.freeze([
    'jpeg-landscape-photo',
    'jpeg-portrait-orientation',
    'no-cover',
    'png-alpha',
    'png-opaque',
    'raster-large-bounded',
    'raster-small',
    'svg-vector',
    'webp-landscape',
    'webp-square'
]);
export const MEDIA_NEGATIVE_SHAPE_IDS = Object.freeze([
    'negative-corrupt-header',
    'negative-mime-extension-mismatch',
    'negative-missing-404',
    'negative-oversized-dimensions',
    'negative-truncated',
    'negative-unsafe-path',
    'negative-unsupported-format',
    'negative-zero-byte'
]);

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const stableIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const expectedFaults = Object.freeze([
    'availability',
    'byte-state',
    'declaration-consistency',
    'dimensions-admission',
    'format-support',
    'header-magic',
    'path-safety',
    'payload-completeness'
]);
let cachedValidation = null;

export function stableMediaStringify(value)
{
    if (value === null || typeof value !== 'object')
    {
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
    {
        return `[${value.map(stableMediaStringify).join(',')}]`;
    }
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableMediaStringify(value[key])}`).join(',')}}`;
}

export function mediaContentDigest(value)
{
    const copy = structuredClone(value);
    delete copy.contentDigest;
    return `sha256:${createHash('sha256').update(stableMediaStringify(copy)).digest('hex')}`;
}

export function sealMediaDocument(value)
{
    const result = structuredClone(value);
    result.contentDigest = mediaContentDigest(result);
    return result;
}

export function loadMediaShapeCatalog(file = mediaShapeCatalogFile)
{
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function containsForbiddenLocator(value, key = '')
{
    if (Array.isArray(value))
    {
        return value.some((item) => containsForbiddenLocator(item, key));
    }
    if (!value || typeof value !== 'object')
    {
        return typeof value === 'string'
      && (path.isAbsolute(value) || /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value) || /^https?:\/\//iu.test(value));
    }
    return Object.entries(value).some(([childKey, child]) =>
    {
        if (/(?:absolute)?path|publicurl|storagepath/iu.test(childKey))
        {
            return true;
        }
        return containsForbiddenLocator(child, childKey);
    });
}

function validateFormat(shape, formats, errors)
{
    if (shape.format === null)
    {
        return;
    }
    const format = formats.get(shape.format);
    if (!format)
    {
        if (shape.validityClass === 'negative-invalid' && shape.faultCondition === 'format-support')
        {
            return;
        }
        errors.push(`shape ${shape.id} references unknown format ${shape.format}`);
        return;
    }
    const declarationMismatch = shape.validityClass === 'negative-invalid'
    && shape.faultCondition === 'declaration-consistency';
    if (!declarationMismatch && shape.mime !== format.mime)
    {
        errors.push(`shape ${shape.id} MIME does not match format authority`);
    }
    if (!declarationMismatch && !format.extensions?.includes(shape.extension))
    {
        errors.push(`shape ${shape.id} extension does not match format authority`);
    }
    if (shape.alpha === true && format.supportsAlpha !== true)
    {
        errors.push(`shape ${shape.id} declares alpha for a non-alpha format`);
    }
}

export function validateMediaShapeCatalog(
    catalog = loadMediaShapeCatalog(),
    schema = JSON.parse(fs.readFileSync(mediaShapeCatalogSchemaFile, 'utf8'))
)
{
    let validationKey;
    try
    {
        validationKey = stableMediaStringify({ catalog, schema });
    }
    catch
    {
        return ['media shape catalog structure cannot be serialized'];
    }
    if (cachedValidation?.key === validationKey)
    {
        return [...cachedValidation.errors];
    }
    const errors = [];
    if (schema.$id !== 'fsusblog.media-shape-catalog.v1' || schema.additionalProperties !== false)
    {
        errors.push('media shape schema must be closed and versioned');
    }
    try
    {
        errors.push(...validateJsonSchema(catalog, schema).map((error) => `media shape catalog schema: ${error}`));
    }
    catch (error)
    {
        return [...errors, `media shape catalog schema cannot be validated: ${error.message}`];
    }
    if (!catalog || typeof catalog !== 'object'
        || !['formats', 'aspects', 'shapes'].every((key) => Array.isArray(catalog[key])
            && catalog[key].every((item) => item && typeof item === 'object'))
        || !catalog.shapes.every((shape) => Array.isArray(shape.consumerClasses)))
    {
        return errors.length ? errors : ['media shape catalog structure is invalid'];
    }
    if (catalog.schema !== 'fsusblog.media-shape-catalog.v1' || catalog.owner !== 'media-shape-catalog')
    {
        errors.push('media shape catalog identity or owner is invalid');
    }
    if (!digestPattern.test(catalog.contentDigest ?? '') || catalog.contentDigest !== mediaContentDigest(catalog))
    {
        errors.push('media shape catalog content digest is invalid');
    }
    const formats = new Map((catalog.formats ?? []).map((item) => [item.id, item]));
    if (JSON.stringify([...formats.keys()]) !== JSON.stringify(MEDIA_FORMAT_IDS))
    {
        errors.push('media format registry must exactly cover jpeg, png, svg, and webp');
    }
    for (const format of formats.values())
    {
        if (!stableIdPattern.test(format.id ?? '') || typeof format.factOwner !== 'string' || format.factOwner !== 'independent-media-codec-verifier')
        {
            errors.push(`format ${format.id} lacks the independent fact owner`);
        }
        if (!Array.isArray(format.extensions) || format.extensions.length === 0 || new Set(format.extensions).size !== format.extensions.length)
        {
            errors.push(`format ${format.id} extensions are invalid`);
        }
    }
    if (JSON.stringify((catalog.aspects ?? []).map((item) => item.id)) !== JSON.stringify(MEDIA_ASPECT_IDS))
    {
        errors.push('media aspect registry is incomplete');
    }
    const aspects = new Map((catalog.aspects ?? []).map((item) => [item.id, item]));
    for (const aspect of aspects.values())
    {
        if (!Number.isInteger(aspect.width) || !Number.isInteger(aspect.height) || aspect.width < 1 || aspect.height < 1 || aspect.centerSafe !== true || typeof aspect.cropExpectation !== 'string')
        {
            errors.push(`aspect ${aspect.id} contract is invalid`);
        }
        if (aspect.id !== `${aspect.width}x${aspect.height}`
            || aspect.cropExpectation !== (aspect.width < aspect.height ? 'portrait-center-safe' : 'center-safe'))
        {
            errors.push(`aspect ${aspect.id} geometry does not match its identity or crop expectation`);
        }
    }
    if (JSON.stringify(catalog.consumerClasses) !== JSON.stringify(MEDIA_CONSUMER_CLASSES))
    {
        errors.push('media consumer applicability registry is incomplete');
    }
    const shapes = Array.isArray(catalog.shapes) ? catalog.shapes : [];
    const ids = shapes.map((item) => item.id);
    const expectedIds = [...MEDIA_POSITIVE_SHAPE_IDS, ...MEDIA_NEGATIVE_SHAPE_IDS];
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds))
    {
        errors.push('media shape matrix is incomplete or reordered');
    }
    if (new Set(ids).size !== ids.length)
    {
        errors.push('media shape IDs must be unique');
    }
    const byId = new Map(shapes.map((item) => [item.id, item]));
    const faults = [];
    for (const shape of shapes)
    {
        if (!stableIdPattern.test(shape.id ?? ''))
        {
            errors.push(`shape ${shape.id} has an unstable ID`);
        }
        if (!digestPattern.test(shape.contentDigest ?? '') || shape.contentDigest !== mediaContentDigest(shape))
        {
            errors.push(`shape ${shape.id} content digest is invalid`);
        }
        if (!['canonical-positive', 'negative-invalid'].includes(shape.validityClass))
        {
            errors.push(`shape ${shape.id} validity class is invalid`);
        }
        if (!Array.isArray(shape.consumerClasses) || shape.consumerClasses.some((item) => !MEDIA_CONSUMER_CLASSES.includes(item)) || new Set(shape.consumerClasses).size !== shape.consumerClasses.length)
        {
            errors.push(`shape ${shape.id} consumer classes are invalid`);
        }
        validateFormat(shape, formats, errors);
        if (shape.aspectClass !== null && !aspects.has(shape.aspectClass))
        {
            errors.push(`shape ${shape.id} references unknown aspect ${shape.aspectClass}`);
        }
        if (containsForbiddenLocator(shape))
        {
            errors.push(`shape ${shape.id} stores a path or public URL`);
        }
        if (shape.validityClass === 'canonical-positive')
        {
            if (shape.faultCondition !== null)
            {
                errors.push(`positive shape ${shape.id} cannot declare a fault`);
            }
            if (shape.id === 'no-cover')
            {
                for (const key of ['format', 'mime', 'extension', 'width', 'height', 'aspectClass', 'alpha', 'orientation', 'byteDigestRef', 'decodedDigestRef'])
                {
                    if (shape[key] !== null)
                    {
                        errors.push(`no-cover must keep ${key} null`);
                    }
                }
                if (shape.assetIdentityRequired !== false || shape.expectedFallback !== 'explicit-no-cover')
                {
                    errors.push('no-cover cannot create a default asset');
                }
            }
            else
            {
                if (!['success', 'success-bounded', 'success-safe-vector'].includes(shape.expectedDecode)
                    || shape.expectedFallback !== 'none' || Object.hasOwn(shape, 'sourceShapeId'))
                {
                    errors.push(`positive shape ${shape.id} decode/fallback authority is invalid`);
                }
                if (!Number.isInteger(shape.width) || !Number.isInteger(shape.height) || shape.width < 1 || shape.height < 1)
                {
                    errors.push(`positive shape ${shape.id} dimensions are invalid`);
                }
                const orientedWidth = [6, 8].includes(shape.orientation) ? shape.height : shape.width;
                const orientedHeight = [6, 8].includes(shape.orientation) ? shape.width : shape.height;
                const aspect = aspects.get(shape.aspectClass);
                if (!aspect || orientedWidth * aspect.height !== orientedHeight * aspect.width
                    || shape.expectedCrop !== aspect.cropExpectation)
                {
                    errors.push(`positive shape ${shape.id} aspect or crop geometry is invalid`);
                }
                if (shape.width > 8192 || shape.height > 8192 || shape.width * shape.height > 2_000_000)
                {
                    errors.push(`positive shape ${shape.id} exceeds bounded dimensions`);
                }
                if (typeof shape.alpha !== 'boolean' || ![1, 3, 6, 8].includes(shape.orientation))
                {
                    errors.push(`positive shape ${shape.id} alpha or orientation is invalid`);
                }
                if (shape.assetIdentityRequired !== true || shape.byteDigestRef !== `generated:${shape.id}:bytes` || shape.decodedDigestRef !== `generated:${shape.id}:decoded`)
                {
                    errors.push(`positive shape ${shape.id} lacks AssetId-compatible generator refs`);
                }
            }
        }
        else
        {
            faults.push(shape.faultCondition);
            if (!expectedFaults.includes(shape.faultCondition))
            {
                errors.push(`negative shape ${shape.id} fault is invalid`);
            }
            if (!MEDIA_POSITIVE_SHAPE_IDS.includes(shape.sourceShapeId))
            {
                errors.push(`negative shape ${shape.id} source is not canonical positive`);
            }
            const source = byId.get(shape.sourceShapeId);
            const allowedChanges = shape.faultCondition === 'declaration-consistency' ? ['mime', 'extension']
                : shape.faultCondition === 'dimensions-admission' ? ['width', 'height', 'aspectClass']
                    : shape.faultCondition === 'format-support' ? ['format', 'mime', 'extension'] : [];
            const facts = ['format', 'mime', 'extension', 'width', 'height', 'aspectClass', 'alpha', 'orientation'];
            const changed = source ? facts.filter((key) => shape[key] !== source[key]) : [];
            if (!source || source.id === 'no-cover' || source.validityClass !== 'canonical-positive'
                || changed.some((key) => !allowedChanges.includes(key))
                || (shape.faultCondition === 'declaration-consistency' && changed.length !== 1)
                || (shape.faultCondition === 'dimensions-admission' && shape.width <= 8192 && shape.height <= 8192))
            {
                errors.push(`negative shape ${shape.id} violates single-fault source facts`);
            }
            if (shape.assetIdentityRequired !== false || shape.decodedDigestRef !== null || shape.consumerClasses.length !== 1 || shape.consumerClasses[0] !== 'fallback')
            {
                errors.push(`negative shape ${shape.id} can contaminate positive consumers`);
            }
            if (!String(shape.expectedFallback).startsWith('media.'))
            {
                errors.push(`negative shape ${shape.id} lacks a stable reason`);
            }
        }
    }
    if (JSON.stringify([...faults].sort()) !== JSON.stringify([...expectedFaults].sort()))
    {
        errors.push('negative media fault classes must be exact and single-fault');
    }
    for (const id of MEDIA_NEGATIVE_SHAPE_IDS)
    {
        const shape = byId.get(id);
        if (shape && shape.sourceShapeId === id)
        {
            errors.push(`negative shape ${id} cannot source itself`);
        }
    }
    const positive = shapes.filter((item) => item.validityClass === 'canonical-positive');
    for (const requiredFormat of MEDIA_FORMAT_IDS)
    {
        if (!positive.some((item) => item.format === requiredFormat))
        {
            errors.push(`positive matrix lacks real ${requiredFormat}`);
        }
    }
    if (!positive.some((item) => item.format === 'jpeg' && item.orientation === 6))
    {
        errors.push('positive matrix lacks oriented JPEG');
    }
    if (!positive.some((item) => item.format === 'png' && item.alpha === true) || !positive.some((item) => item.format === 'png' && item.alpha === false))
    {
        errors.push('positive matrix lacks PNG alpha and opaque cases');
    }
    if (!positive.some((item) => item.id === 'webp-landscape') || !positive.some((item) => item.id === 'webp-square'))
    {
        errors.push('positive matrix lacks WebP landscape and square');
    }
    cachedValidation = { key: validationKey, errors: [...errors] };
    return errors;
}

export function scanMediaShapeCatalogAuthority({ repositoryRoot = root } = {})
{
    const owners = fs.readdirSync(path.join(repositoryRoot, 'config/testing'))
        .filter((name) => name.endsWith('.json'))
        .flatMap((name) =>
        {
            try
            {
                const value = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'config/testing', name), 'utf8'));
                return value.owner === 'media-shape-catalog' ? [name] : [];
            }
            catch
            {
                return [];
            }
        });
    return JSON.stringify(owners) === JSON.stringify(['media-shape-catalog.json'])
        ? []
        : [`media shape catalog must have one authority, found ${owners.join(', ') || 'none'}`];
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const errors = [...validateMediaShapeCatalog(), ...scanMediaShapeCatalogAuthority()];
    if (errors.length)
    {
        process.stderr.write(`${errors.join('\n')}\n`);
        process.exitCode = 1;
    }
    else
    {
        process.stdout.write('media shape catalog is valid\n');
    }
}
