export const MAX_NATIVE_RESULT_LENGTH = 256_000

export function nativeResultLimitMessage(vendor: string): string {
  return `${vendor} final answer exceeds ${MAX_NATIVE_RESULT_LENGTH} characters. Return a smaller response and write large deliverables to files.`
}
