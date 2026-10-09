import {
    encodeDocumentExportRevisionChoicesRequest, encodeDocumentExportSourceCaptureRequest, encodeDocumentExportSourceChoicesResponse
} from '@/codecs/binary/documentExportSourceOptionsWire.generated';
import type {
    DocumentExportRevisionChoicesRequest, DocumentExportSourceCaptureRequest, DocumentExportSourceChoiceResponse,
    DocumentExportSourceChoicesResponse
} from '@/codecs/binary/documentExportSourceOptionsWire.generated';

import type { DocumentExportWireUiOptions } from './documentExportWireUiPort';

/** Freeze the unbound selector; the original catalog alone allocates SourceVersion. */
export function captureDocumentExportSourceCaptureRequest(request: DocumentExportSourceCaptureRequest): DocumentExportSourceCaptureRequest
{
    const captured = Object.freeze({ sources: Object.freeze(request.sources.map(source => Object.freeze({
        kind: source.kind, articleId: source.articleId, draftKey: source.draftKey,
        revisionId: source.revisionId, publicationId: source.publicationId
    }))) });
    encodeDocumentExportSourceCaptureRequest(captured);
    return captured;
}

/** ArticleId remains the actual positive Int32 input; no Int64-to-Number conversion. */
export function captureDocumentExportRevisionChoicesRequest(request: DocumentExportRevisionChoicesRequest): DocumentExportRevisionChoicesRequest
{
    const captured = Object.freeze({ articleId: request.articleId });
    encodeDocumentExportRevisionChoicesRequest(captured);
    return captured;
}

/**
 * Consume only a real authorized response projection. The response does not
 * contain privacy policy, capabilities or locale; the original host supplies them.
 * The sole generated encoder validates coordinates, distinct choices and bounds.
 */
export function mapDocumentExportSourceChoices(
    response: DocumentExportSourceChoicesResponse,
    privateForSource: (choice: Readonly<DocumentExportSourceChoiceResponse>) => boolean
): DocumentExportWireUiOptions['sources']
{
    const captured = Object.freeze({ choices: Object.freeze(response.choices.map(choice => Object.freeze({
        choiceId: choice.choiceId, label: choice.label, coordinate: Object.freeze({ ...choice.coordinate })
    }))) });
    encodeDocumentExportSourceChoicesResponse(captured);
    return Object.freeze(captured.choices.map(choice =>
    {
        const privateSource = privateForSource(choice);
        if (typeof privateSource !== 'boolean')
        {
            throw new TypeError('document_export_source_privacy_unavailable');
        }
        return Object.freeze({ id: choice.choiceId, label: choice.label, coordinate: choice.coordinate, private: privateSource });
    }));
}
