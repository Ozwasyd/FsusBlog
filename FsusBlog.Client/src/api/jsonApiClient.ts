export interface JsonRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

export async function jsonRequest<T>(url: string, options?: JsonRequestOptions): Promise<T> {
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
    throw new Error(`JSON request failed: ${response.status}`);
  }

  return await response.json() as T;
}
