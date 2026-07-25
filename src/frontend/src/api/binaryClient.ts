import { binaryRequest } from './binaryApiClient'

export async function getBinary<T = unknown>(url: string): Promise<T> {
    const buffer = await binaryRequest(url)
    const decoder = new TextDecoder()
    const json = decoder.decode(buffer)
    return JSON.parse(json) as T
}
