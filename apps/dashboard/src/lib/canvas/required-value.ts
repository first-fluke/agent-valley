/** Preserve canvas invariants with a runtime check instead of a type assertion. */
export function requireCanvasValue<T>(value: T | null | undefined, description: string): T {
  if (value == null) throw new Error(`Office canvas requires ${description}; initialize the layout and canvas first.`)
  return value
}
