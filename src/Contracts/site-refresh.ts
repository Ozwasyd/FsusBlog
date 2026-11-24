import { ApiError, decodeSuccess } from './aeds.ts';
import { postEmpty, request } from './internal/http.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export const siteRefreshAvailable = (signal?: AbortSignal) => readFlag(WireRoutes.SiteRefreshAvailability, signal);
export const hasSiteRefreshCookie = (signal?: AbortSignal) => readFlag(WireRoutes.SiteRefreshStatus, signal);
export const rotateSiteRefresh = (signal?: AbortSignal) => postEmpty(WireRoutes.SiteRefreshRotate, signal);
export const signOutSiteRefresh = (signal?: AbortSignal) => postEmpty(WireRoutes.SiteRefreshSignOut, signal);

async function readFlag(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request(path, FrameType.EmptySuccess, decodeSuccess, signal);
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return false;
    throw error;
  }
}
