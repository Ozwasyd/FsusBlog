export function validateDocumentExportRegistration(protocol, roots)
{
    if (protocol.reservedFrameValues !== undefined && !Array.isArray(protocol.reservedFrameValues))
    {
        throw new Error('document-export registration drift:reservedFrameValues');
    }
    for (const [name, expected] of Object.entries(roots))
    {
        const active = protocol.frameTypes.find(frame => frame.name === name);
        const reserved = protocol.reservedFrameValues?.find(frame => frame?.name === name);
        if (active ? active.value !== expected.value || active.goldenFamily !== expected.family
            : !reserved || reserved.value !== expected.value || reserved.ownerIssue !== 3735)
        {
            throw new Error(`document-export registration drift:${name}`);
        }
    }
}
