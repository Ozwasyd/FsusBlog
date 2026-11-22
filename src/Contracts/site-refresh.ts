import { ApiError, decodeSuccess } from './aeds.ts';
import { post, request } from './internal/http.ts';
import { FrameType, WireRoutes } from './wire.generated.ts';

export function siteRefreshAvailable(signal?: AbortSignal): Promise<boolean> {
  return readFlag(WireRoutes.SiteRefreshAvailability, signal);
}

export function hasSiteRefreshCookie(signal?: AbortSignal): Promise<boolean> {
  return readFlag(WireRoutes.SiteRefreshStatus, signal);
}

export function rotateSiteRefresh(signal?: AbortSignal): Promise<void> {
  return post(WireRoutes.SiteRefreshRotate, FrameType.EmptySuccess, decodeSuccess, signal);
}

export function signOutSiteRefresh(signal?: AbortSignal): Promise<void> {
  return post(WireRoutes.SiteRefreshSignOut, FrameType.EmptySuccess, decodeSuccess, signal);
}

async function readFlag(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request(path, FrameType.EmptySuccess, decodeSuccess, signal);
    return true;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 404)) return false;
    throw error;
  }
}
