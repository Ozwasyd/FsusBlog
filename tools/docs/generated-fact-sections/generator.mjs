/**
 * Deterministic FactObservationReceipt → Markdown generated-section engine.
 * Consumes sealed receipts only; never scans business source or old section bodies
 * to decide new output. Check mode never writes.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readFactObservationReceipt } from '../../fact-extractors/reader.mjs'
import { sealSourceIdentity } from '../../fact-extractors/identity.mjs'
import {
    loadCatalog,
    resolveFactPath,
    root,
    sectionsByDocument,
    validateCatalog
} from './catalog.mjs'
import {
    GeneratedSectionErrorCode,
    makeGeneratedSectionError,
    normalizeDocumentNewlines,
    parseGeneratedMarkers,
    replaceGeneratedSections
} from './markers.mjs'
import { RendererRegistry } from './renderers.mjs'

const lifecycleMetadataPaths = Object.freeze([
    'config/development/document-lifecycle.json',
    'config/development/document-inventory.generated.json'
])

/**
 * Index receipts by extractorId. Accepts public reader views or raw sealed objects.
 */
export function indexReceiptsByExtractor(receipts)
{
    const map = new Map()
    for (const entry of receipts)
    {
        const view = typeof entry === 'string'
            ? readFactObservationReceipt(entry)
            : readFactObservationReceipt(entry)
        if (map.has(view.extractorId))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.CATALOG_INVALID,
                `duplicate receipt for extractor ${view.extractorId}`
            )
        }
        map.set(view.extractorId, view)
    }
    return map
}

export function assertObservationIdentity(receipt, expectedIdentity, label = 'receipt')
{
    if (receipt.status !== 'ok')
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.OBSERVATION_FAILED,
            `${label} status=${receipt.status}; refusing to render`,
            { extractorId: receipt.extractorId, failureReasons: receipt.failureReasons }
        )
    }
    if (!expectedIdentity)
    {
        return true
    }
    if (expectedIdentity.sourceCommit && receipt.sourceCommit !== expectedIdentity.sourceCommit)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.OBSERVATION_STALE,
            `${label} sourceCommit does not match current source (old build/worktree refused)`,
            {
                extractorId: receipt.extractorId,
                receiptSourceCommit: receipt.sourceCommit,
                expectedSourceCommit: expectedIdentity.sourceCommit
            }
        )
    }
    if (expectedIdentity.worktreeFingerprint
        && receipt.worktreeFingerprint !== expectedIdentity.worktreeFingerprint)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.OBSERVATION_STALE,
            `${label} worktreeFingerprint does not match current worktree`,
            {
                extractorId: receipt.extractorId,
                receiptWorktreeFingerprint: receipt.worktreeFingerprint,
                expectedWorktreeFingerprint: expectedIdentity.worktreeFingerprint
            }
        )
    }
    if (expectedIdentity.buildIdentity)
    {
        const actual = receipt.buildIdentity
        const expected = expectedIdentity.buildIdentity
        if (actual == null
            || actual.artifactId !== expected.artifactId
            || actual.receiptDigest !== expected.receiptDigest
            || actual.artifactDigest !== expected.artifactDigest)
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.OBSERVATION_STALE,
                `${label} buildIdentity does not match required build`,
                { extractorId: receipt.extractorId }
            )
        }
    }
    return true
}

export function renderSectionBody(section, observationValue)
{
    return RendererRegistry.render(section.renderer, observationValue, {
        orderPolicy: section.orderPolicy === 'preserve' ? 'preserve' : 'ordinal',
        emptyPolicy: section.emptyPolicy,
        columns: section.columns,
        unit: section.unit,
        projection: section.projection
    })
}

export function renderSectionFromReceipt(section, receipt, expectedIdentity = null)
{
    assertObservationIdentity(receipt, expectedIdentity, section.sectionId)
    if (!receipt.behaviorIds.includes(section.behaviorId))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.OBSERVATION_MISSING_FACT,
            `receipt ${receipt.extractorId} does not cover behavior ${section.behaviorId}`,
            { sectionId: section.sectionId, behaviorId: section.behaviorId }
        )
    }
    if (receipt.extractorId !== section.extractorId)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.OBSERVATION_MISSING_FACT,
            `section ${section.sectionId} expects extractor ${section.extractorId}, got ${receipt.extractorId}`,
            { sectionId: section.sectionId }
        )
    }
    const value = resolveFactPath(receipt.observations, section.factPath)
    if (value === undefined)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.OBSERVATION_MISSING_FACT,
            `factPath ${section.factPath} missing from receipt ${receipt.extractorId}`,
            { sectionId: section.sectionId, factPath: section.factPath }
        )
    }
    // Intentionally ignore any previous section body — render from observation only.
    return renderSectionBody(section, value)
}

function readDocument(repositoryRoot, documentPath)
{
    const absolute = path.join(repositoryRoot, documentPath)
    if (!existsSync(absolute))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.SECTION_MISSING_MARKER,
            `document missing: ${documentPath}`,
            { documentPath }
        )
    }
    return normalizeDocumentNewlines(readFileSync(absolute, 'utf8'))
}

/**
 * Validate marker ↔ catalog ownership for one document and return desired replacements.
 */
export function planDocumentSections({
    documentPath,
    source,
    catalogSections,
    receiptsByExtractor,
    expectedIdentity = null
})
{
    const markers = parseGeneratedMarkers(source, documentPath)
    const catalogIds = new Set(catalogSections.map((section) => section.sectionId))
    const markerIds = new Set(markers.map((marker) => marker.sectionId))

    for (const marker of markers)
    {
        if (!catalogIds.has(marker.sectionId))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.SECTION_ORPHAN_MARKER,
                `marker ${marker.sectionId} in ${documentPath} has no catalog owner`,
                { documentPath, sectionId: marker.sectionId }
            )
        }
    }
    for (const section of catalogSections)
    {
        if (!markerIds.has(section.sectionId))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.SECTION_MISSING_MARKER,
                `catalog section ${section.sectionId} missing marker in ${documentPath}`,
                { documentPath, sectionId: section.sectionId }
            )
        }
    }

    const replacements = new Map()
    for (const section of catalogSections)
    {
        const receipt = receiptsByExtractor.get(section.extractorId)
        if (!receipt)
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.OBSERVATION_MISSING_FACT,
                `no receipt supplied for extractor ${section.extractorId} (section ${section.sectionId})`,
                { sectionId: section.sectionId, extractorId: section.extractorId }
            )
        }
        replacements.set(section.sectionId, renderSectionFromReceipt(section, receipt, expectedIdentity))
    }
    return { markers, replacements }
}

export function materializeDocument(source, replacements)
{
    return replaceGeneratedSections(source, replacements)
}

/**
 * Core generate/check entry. Check mode performs zero writes.
 */
export function processGeneratedFactSections(options = {})
{
    const repositoryRoot = options.repositoryRoot ?? root
    const mode = options.mode === 'generate' ? 'generate' : 'check'
    const catalog = options.catalog ?? loadCatalog(repositoryRoot, options.catalogPath)
    validateCatalog(catalog)

    const receiptsByExtractor = options.receiptsByExtractor
        ?? indexReceiptsByExtractor(options.receipts ?? [])

    const expectedIdentity = options.expectedIdentity === undefined
        ? sealSourceIdentity(repositoryRoot)
        : options.expectedIdentity

    // Optional explicit allow of fixture identity when tests inject sealed synthetic identity.
    const identity = expectedIdentity

    const byDocument = sectionsByDocument(catalog)
    const documentPaths = new Set([
        ...byDocument.keys(),
        ...(options.extraDocumentPaths ?? [])
    ])

    // Documents that only have orphan markers still need scanning when catalog is empty?
    // Catalog is authority: only registered documents are processed unless extra paths provided.
    if (documentPaths.size === 0 && catalog.sections.length === 0)
    {
        return {
            mode,
            status: 'ok',
            documents: [],
            written: [],
            drifts: []
        }
    }

    const results = []
    const drifts = []
    const written = []

    for (const documentPath of [...documentPaths].sort())
    {
        const catalogSections = byDocument.get(documentPath) ?? []
        const source = readDocument(repositoryRoot, documentPath)
        const absolute = path.join(repositoryRoot, documentPath)
        const beforeStat = statSync(absolute)
        const beforeBytes = readFileSync(absolute)

        // Guard: generator must never rewrite lifecycle metadata side-paths.
        for (const forbidden of lifecycleMetadataPaths)
        {
            if (path.resolve(repositoryRoot, documentPath) === path.resolve(repositoryRoot, forbidden))
            {
                throw makeGeneratedSectionError(
                    GeneratedSectionErrorCode.LIFECYCLE_MUTATION,
                    'generator must not modify document lifecycle metadata files'
                )
            }
        }

        const plan = planDocumentSections({
            documentPath,
            source,
            catalogSections,
            receiptsByExtractor,
            expectedIdentity: identity
        })
        const next = materializeDocument(source, plan.replacements)
        const changed = next !== source

        if (mode === 'check')
        {
            // Zero-write proof: re-read file and compare mtime/size/bytes after planning.
            const afterBytes = readFileSync(absolute)
            const afterStat = statSync(absolute)
            if (!beforeBytes.equals(afterBytes) || afterStat.mtimeMs !== beforeStat.mtimeMs)
            {
                throw makeGeneratedSectionError(
                    GeneratedSectionErrorCode.WRITE_FORBIDDEN,
                    `check mode mutated ${documentPath}`
                )
            }
            if (changed)
            {
                drifts.push({
                    documentPath,
                    code: GeneratedSectionErrorCode.CHECK_DRIFT,
                    message: `${documentPath} generated sections drift from current observation receipts`
                })
            }
        }
        else if (changed)
        {
            // Generate only replaces owned marker ranges; exterior prose preserved.
            writeFileSync(absolute, next)
            written.push(documentPath)
        }

        results.push({
            documentPath,
            sectionIds: catalogSections.map((section) => section.sectionId),
            changed
        })
    }

    if (mode === 'check' && drifts.length > 0)
    {
        const error = makeGeneratedSectionError(
            GeneratedSectionErrorCode.CHECK_DRIFT,
            drifts.map((entry) => entry.message).join('; ')
        )
        error.drifts = drifts
        throw error
    }

    return {
        mode,
        status: 'ok',
        documents: results,
        written,
        drifts
    }
}

export function assertDeterministicRender(section, observationValue, rounds = 2)
{
    const outputs = []
    for (let index = 0; index < rounds; index += 1)
    {
        outputs.push(renderSectionBody(section, structuredClone(observationValue)))
    }
    for (let index = 1; index < outputs.length; index += 1)
    {
        if (outputs[index] !== outputs[0])
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.RENDERER_SHAPE,
                `non-deterministic render for ${section.sectionId}`
            )
        }
    }
    return outputs[0]
}
