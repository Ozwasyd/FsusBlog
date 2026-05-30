type ApiUploadProgress = {
  loaded: number
  total?: number
}

export type ApiRequestConfig = {
  signal?: AbortSignal
  onUploadProgress?: (event: ApiUploadProgress) => void
  requiresPow?: boolean
}
