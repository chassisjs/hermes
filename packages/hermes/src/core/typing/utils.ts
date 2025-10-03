export function assertNever(_: never): never {
  throw new Error(`ASSERT_NEVER`)
}
export function assertSomething(_: unknown & {}) {}
export const literalObject = <T>(value: T) => value
