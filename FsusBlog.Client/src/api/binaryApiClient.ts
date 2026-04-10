export interface BinaryRequestOptions extends RequestInit {}

export class BinaryRequestError extends Error {
  readonly status: number;
  readonly buffer: ArrayBuffer;

  constructor(status: number, message: string, buffer: ArrayBuffer) {
    super(message);
    this.status = status;
    this.buffer = buffer;
  }
}

export async function binaryRequest(url: string, options?: BinaryRequestOptions): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      Accept: 'application/octet-stream',
      ...(options?.headers ?? {})
    }
  });

  const buffer = await response.arrayBuffer();

  if (!response.ok) {
    throw new BinaryRequestError(response.status, `Binary request failed: ${response.status}`, buffer);
  }

  return buffer;
}
