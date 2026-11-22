import type { AdminSession } from '../../src/Contracts/admin-identity.ts';
import { WireHeaders } from '../../src/Contracts/wire.generated.ts';

export const validProof = 'P'.repeat(43);
export const validPermissionSession = 'a'.repeat(64);
export const altPermissionSession = 'b'.repeat(64);

export function adminSessionFixture(handle: string, generation: bigint) {
  return (permissionSession: string | null = validPermissionSession): AdminSession => ({
    handle, generation, expiresAt: Date.now() + 60_000,
    appearanceEnabled: true, siteConfigEnabled: true,
    ...(permissionSession === null ? {} : { permissionSession }),
  });
}

export function permissionHeader(session: string) {
  return { [WireHeaders.AdminPermissionSession]: session };
}
