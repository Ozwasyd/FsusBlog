import { encodeAedsFrame } from '@/api/binaryFrame';
import { AuthoringWorkspaceSnapshotApi, type AuthoringWorkspaceSnapshotScope, type AuthoringWorkspaceSnapshotTransport } from '@/api/authoringWorkspaceSnapshot';
import { encodeAuthoringWorkspaceSnapshotRequest } from '@/codecs/binary/authoringWorkspaceSnapshotWire.generated';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import { fsusBinaryRoutes } from '@/generated/fsusBinaryRoutes';

import { FrameType } from '@wasm/protocol/frame';

/** Composes the sole snapshot API with the registered transport; construction does not read, restore or grant readiness. */
export function createAuthoringWorkspaceSnapshotHttpApi(scope: AuthoringWorkspaceSnapshotScope, sourceDigest: string): AuthoringWorkspaceSnapshotApi
{
    return new AuthoringWorkspaceSnapshotApi(createAuthoringWorkspaceSnapshotHttpTransport(sourceDigest), scope, sourceDigest);
}

/** Binds the existing verified-observation API to its private typed HTTP boundary. */
export function createAuthoringWorkspaceSnapshotHttpTransport(sourceDigest: string): AuthoringWorkspaceSnapshotTransport
{
    if (!/^[a-f0-9]{64}$/u.test(sourceDigest))
    {
        throw new RangeError('workspace_snapshot_source_digest_invalid');
    }

    return {
        read(signal)
        {
            return requestBinaryOnly({
                binaryUrl: fsusBinaryRoutes.binary_author_workspace_snapshot_read,
                privateScope: 'admin',
                frameType: FrameType.AuthoringWorkspaceSnapshotResponse,
                signal,
                requestOptions: { method: 'GET', cache: 'no-store' }
            });
        },
        write(command, signal)
        {
            return requestBinaryOnly({
                binaryUrl: fsusBinaryRoutes.binary_author_workspace_snapshot_mutate,
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
                binaryUrl: fsusBinaryRoutes.binary_author_workspace_snapshot_mutate,
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
