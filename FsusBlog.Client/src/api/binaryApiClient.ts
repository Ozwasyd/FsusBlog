export interface BinaryRequestOptions extends RequestInit {}

export async function binaryRequest(url: string, options?: BinaryRequestOptions): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      Accept: 'application/octet-stream',
      ...(options?.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Binary request failed: ${response.status}`);
  }

  return await response.arrayBuffer();
}
