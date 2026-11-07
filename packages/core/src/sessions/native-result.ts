export const MAX_NATIVE_RESULT_LENGTH = 256_000

export function nativeResultLimitMessage(vendor: string): string {
  return `${vendor} final answer exceeds ${MAX_NATIVE_RESULT_LENGTH} characters. Return a smaller response and write large deliverables to files.`
}

/** Complete answer within the shared bound; overflow discards the text and stays sticky until reset(). */
export class BoundedResultText {
  private value = ""
  private overflowed = false

  get text(): string {
    return this.value
  }

  get exceeded(): boolean {
    return this.overflowed
  }

  append(chunk: string): void {
    if (this.overflowed) return
    if (chunk.length > MAX_NATIVE_RESULT_LENGTH - this.value.length) {
      this.overflowed = true
      this.value = ""
      return
    }
    this.value += chunk
  }

  reset(): void {
    this.value = ""
    this.overflowed = false
  }
}
