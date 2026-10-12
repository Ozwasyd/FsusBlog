import type { AuthoringWorkspaceSnapshotTransport } from '@/api/authoringWorkspaceSnapshot';
import { encodeAedsFrame } from '@/api/binaryFrame';
import { encodeAuthoringWorkspaceSnapshotRequest } from '@/codecs/binary/authoringWorkspaceSnapshotWire.generated';
import { requestBinaryOnly } from '@/composition/binaryTransport';

import { FrameType } from '@wasm/protocol/frame';

const endpoint = '/api/binary/author/workspace/default';

/** Read server-selected binding coordinates before a source-bound mutation port exists. */
export function readAuthoringWorkspaceSnapshotHttp(signal?: AbortSignal): Promise<unknown>
{
    return requestBinaryOnly({
        binaryUrl: endpoint,
        privateScope: 'admin',
        frameType: FrameType.AuthoringWorkspaceSnapshotResponse,
        signal,
        requestOptions: { method: 'GET', cache: 'no-store' }
    });
}

/** Binds the existing verified-observation API to its private typed HTTP boundary. */
export function createAuthoringWorkspaceSnapshotHttpTransport(sourceDigest: string): AuthoringWorkspaceSnapshotTransport
{
    if (!/^[a-f0-9]{64}$/u.test(sourceDigest))
    {
        throw new RangeError('workspace_snapshot_source_digest_invalid');
    }

    return {
        read: readAuthoringWorkspaceSnapshotHttp,
        write(command, signal)
        {
            return requestBinaryOnly({
                binaryUrl: endpoint,
                privateScope: 'admin',
                frameType: FrameType.AuthoringWorkspaceSnapshotResponse,
                signal,
                requestOptions: {
                    method: 'POST', cache: 'no-store', requiresPow: true,
                    body: encodeAedsFrame(FrameType.AuthoringWorkspaceSnapshotRequest,
                        encodeAuthoringWorkspaceSnapshotRequest({
                            action: 'write', expectedRevision: command.expectedRevision, sourceDigest,
                            layout: command.layout, resetConfirmationDigest: null
                        }))
                }
            });
        },
        reset(command, signal)
        {
            return requestBinaryOnly({
                binaryUrl: endpoint,
                privateScope: 'admin',
                frameType: FrameType.AuthoringWorkspaceSnapshotResponse,
                signal,
                requestOptions: {
                    method: 'POST', cache: 'no-store', requiresPow: true,
                    body: encodeAedsFrame(FrameType.AuthoringWorkspaceSnapshotRequest,
                        encodeAuthoringWorkspaceSnapshotRequest({
                            action: 'reset', expectedRevision: command.expectedRevision, sourceDigest,
                            layout: null, resetConfirmationDigest: command.confirmationDigest
                        }))
                }
            });
        }
    };
}
