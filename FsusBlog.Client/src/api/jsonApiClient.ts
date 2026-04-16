import { appErrorFromStatus, err, ok, type AppResult, unwrapResult } from '@/utils/appError'

export interface JsonRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function jsonRequestResult<T>(url: string, options?: JsonRequestOptions): Promise<AppResult<T>> {
  const requestInit: RequestInit = {
    credentials: 'include',
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options?.headers ?? {})
    },
    body: options?.body === undefined ? undefined : JSON.stringify(options.body)
  };

  const response = await fetch(url, requestInit);
  if (!response.ok) {
    return err(appErrorFromStatus(response.status, `JSON request failed: ${response.status}`));
  }

  return ok(await response.json() as T);
}

export async function jsonRequest<T>(url: string, options?: JsonRequestOptions): Promise<T> {
  return unwrapResult(await jsonRequestResult<T>(url, options))
}
