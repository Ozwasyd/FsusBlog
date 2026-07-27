/**
 * FSUSBLOG-GENERATED section marker protocol.
 * begin/end must be paired, unique by sectionId, and non-nested.
 * Marker interiors are generator-owned; parsers never treat interior text as authority.
 */

export const generatedMarkerPrefix = 'FSUSBLOG-GENERATED'
export const beginMarkerPattern = /<!--\s*FSUSBLOG-GENERATED:BEGIN\s+([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)\s*-->/gu
export const endMarkerPattern = /<!--\s*FSUSBLOG-GENERATED:END\s+([a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)\s*-->/gu

export const GeneratedSectionErrorCode = Object.freeze({
    MARKER_UNPAIRED: 'GENERATED_SECTION_MARKER_UNPAIRED',
    MARKER_NESTED: 'GENERATED_SECTION_MARKER_NESTED',
    MARKER_DUPLICATE_ID: 'GENERATED_SECTION_MARKER_DUPLICATE_ID',
    MARKER_MISMATCH: 'GENERATED_SECTION_MARKER_MISMATCH',
    MARKER_INVALID: 'GENERATED_SECTION_MARKER_INVALID',
    MARKER_COMPAT: 'GENERATED_SECTION_MARKER_COMPAT',
    SECTION_UNKNOWN: 'GENERATED_SECTION_UNKNOWN',
    SECTION_ORPHAN_MARKER: 'GENERATED_SECTION_ORPHAN_MARKER',
    SECTION_MISSING_MARKER: 'GENERATED_SECTION_MISSING_MARKER',
    RENDERER_UNKNOWN: 'GENERATED_SECTION_RENDERER_UNKNOWN',
    RENDERER_SHAPE: 'GENERATED_SECTION_RENDERER_SHAPE',
    EMPTY_POLICY: 'GENERATED_SECTION_EMPTY_POLICY',
    OBSERVATION_STALE: 'GENERATED_SECTION_OBSERVATION_STALE',
    OBSERVATION_FAILED: 'GENERATED_SECTION_OBSERVATION_FAILED',
    OBSERVATION_MISSING_FACT: 'GENERATED_SECTION_OBSERVATION_MISSING_FACT',
    FACT_DUPLICATE_OWNER: 'GENERATED_SECTION_FACT_DUPLICATE_OWNER',
    CATALOG_INVALID: 'GENERATED_SECTION_CATALOG_INVALID',
    CHECK_DRIFT: 'GENERATED_SECTION_CHECK_DRIFT',
    WRITE_FORBIDDEN: 'GENERATED_SECTION_WRITE_FORBIDDEN',
    LIFECYCLE_MUTATION: 'GENERATED_SECTION_LIFECYCLE_MUTATION',
    SECOND_REGISTRY: 'GENERATED_SECTION_SECOND_REGISTRY',
    BASELINE_ALLOWLIST: 'GENERATED_SECTION_BASELINE_ALLOWLIST',
    WARNING_ONLY: 'GENERATED_SECTION_WARNING_ONLY'
})

export function makeGeneratedSectionError(code, message, details = {})
{
    const error = new Error(message)
    error.code = code
    error.details = details
    return error
}

export function formatBeginMarker(sectionId)
{
    return `<!-- FSUSBLOG-GENERATED:BEGIN ${sectionId} -->`
}

export function formatEndMarker(sectionId)
{
    return `<!-- FSUSBLOG-GENERATED:END ${sectionId} -->`
}

export function wrapGeneratedSection(sectionId, bodyMarkdown)
{
    const body = bodyMarkdown.length === 0 ? '' : `${bodyMarkdown.replace(/\n+$/u, '')}\n`
    return `${formatBeginMarker(sectionId)}\n${body}${formatEndMarker(sectionId)}`
}

/**
 * Parse all generated markers in a Markdown document.
 * Returns ordered sections with absolute character offsets into the original text.
 * Does not interpret interior content as input for rendering.
 */
export function parseGeneratedMarkers(source, documentPath = '<input>')
{
    assertNoCompatMarkers(source, documentPath)

    const beginMatches = [...source.matchAll(beginMarkerPattern)]
    const endMatches = [...source.matchAll(endMarkerPattern)]

    // Reject malformed variants that look like markers but fail the strict pattern.
    const looseBegin = [...source.matchAll(/<!--\s*FSUSBLOG-GENERATED:BEGIN\b[^>]*-->/gu)]
    const looseEnd = [...source.matchAll(/<!--\s*FSUSBLOG-GENERATED:END\b[^>]*-->/gu)]
    if (looseBegin.length !== beginMatches.length || looseEnd.length !== endMatches.length)
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.MARKER_INVALID,
            `invalid FSUSBLOG-GENERATED marker syntax in ${documentPath}`,
            { documentPath }
        )
    }

    const events = []
    for (const match of beginMatches)
    {
        events.push({
            kind: 'begin',
            sectionId: match[1],
            index: match.index,
            length: match[0].length,
            text: match[0]
        })
    }
    for (const match of endMatches)
    {
        events.push({
            kind: 'end',
            sectionId: match[1],
            index: match.index,
            length: match[0].length,
            text: match[0]
        })
    }
    events.sort((left, right) => left.index - right.index || (left.kind === 'begin' ? -1 : 1))

    const open = []
    const sections = []
    const seenIds = new Set()

    for (const event of events)
    {
        if (event.kind === 'begin')
        {
            if (open.length > 0)
            {
                throw makeGeneratedSectionError(
                    GeneratedSectionErrorCode.MARKER_NESTED,
                    `nested generated section begin ${event.sectionId} inside ${open[open.length - 1].sectionId} in ${documentPath}`,
                    { documentPath, sectionId: event.sectionId }
                )
            }
            if (seenIds.has(event.sectionId))
            {
                throw makeGeneratedSectionError(
                    GeneratedSectionErrorCode.MARKER_DUPLICATE_ID,
                    `duplicate generated section id ${event.sectionId} in ${documentPath}`,
                    { documentPath, sectionId: event.sectionId }
                )
            }
            open.push(event)
            seenIds.add(event.sectionId)
            continue
        }

        if (open.length === 0)
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.MARKER_UNPAIRED,
                `end marker without begin for ${event.sectionId} in ${documentPath}`,
                { documentPath, sectionId: event.sectionId }
            )
        }
        const begin = open.pop()
        if (begin.sectionId !== event.sectionId)
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.MARKER_MISMATCH,
                `end marker ${event.sectionId} does not match open begin ${begin.sectionId} in ${documentPath}`,
                { documentPath, sectionId: event.sectionId, openSectionId: begin.sectionId }
            )
        }

        const contentStart = begin.index + begin.length
        const contentEnd = event.index
        // Drop a single leading newline after BEGIN for stable body extraction.
        let bodyStart = contentStart
        if (source[bodyStart] === '\n') bodyStart += 1
        const body = source.slice(bodyStart, contentEnd)
        sections.push({
            sectionId: begin.sectionId,
            documentPath,
            beginIndex: begin.index,
            endIndex: event.index + event.length,
            bodyStart,
            bodyEnd: contentEnd,
            // Exposed for diagnostics only; never fed into renderers.
            existingBody: body
        })
    }

    if (open.length > 0)
    {
        const missing = open[open.length - 1]
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.MARKER_UNPAIRED,
            `begin marker missing end for ${missing.sectionId} in ${documentPath}`,
            { documentPath, sectionId: missing.sectionId }
        )
    }

    return sections
}

export function assertNoCompatMarkers(source, documentPath = '<input>')
{
    const compatPatterns = [
        /<!--\s*FSUSBLOG-GENERATED-LEGACY:/iu,
        /<!--\s*FSUSBLOG-GENERATED-V\d+:/iu,
        /<!--\s*fsus-generated:/iu,
        /<!--\s*BEGIN\s+GENERATED\s+SECTION/iu
    ]
    for (const pattern of compatPatterns)
    {
        if (pattern.test(source))
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.MARKER_COMPAT,
                `compatibility generated-section marker is forbidden in ${documentPath}`,
                { documentPath }
            )
        }
    }
}

/**
 * Replace owned marker ranges with freshly rendered bodies.
 * Exterior prose is preserved byte-for-byte; interiors are fully replaced.
 * Never reads existingBody to decide new content.
 */
export function replaceGeneratedSections(source, replacements)
{
    if (!(replacements instanceof Map) && !Array.isArray(replacements))
    {
        throw makeGeneratedSectionError(
            GeneratedSectionErrorCode.MARKER_INVALID,
            'replacements must be a Map or array of {sectionId, body}'
        )
    }
    const map = replacements instanceof Map
        ? replacements
        : new Map(replacements.map((entry) => [entry.sectionId, entry.body]))

    const sections = parseGeneratedMarkers(source)
    if (sections.length === 0)
    {
        return source
    }

    let output = ''
    let cursor = 0
    for (const section of sections)
    {
        if (!map.has(section.sectionId))
        {
            // Leave unowned markers untouched only when caller did not supply a replacement.
            // Catalog-driven generator always supplies every owned section.
            output += source.slice(cursor, section.endIndex)
            cursor = section.endIndex
            continue
        }
        const body = map.get(section.sectionId)
        if (typeof body !== 'string')
        {
            throw makeGeneratedSectionError(
                GeneratedSectionErrorCode.RENDERER_SHAPE,
                `replacement body for ${section.sectionId} must be a string`
            )
        }
        output += source.slice(cursor, section.beginIndex)
        output += wrapGeneratedSection(section.sectionId, body)
        cursor = section.endIndex
    }
    output += source.slice(cursor)
    return normalizeDocumentNewlines(output)
}

export function normalizeDocumentNewlines(text)
{
    return text.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
}
