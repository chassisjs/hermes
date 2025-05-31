export const __FLAVOUR_TYPE__ = Symbol('__brand')

type StringLiteral<Type> = Type extends string ? (string extends Type ? never : Type) : never

export type WithBrand<T extends string> = {
  readonly __brand?: T
}

export type WithoutBrand<T> = Omit<T, '__brand'>

export type Brand<K, T> = T extends StringLiteral<T> ? WithoutBrand<K> & WithBrand<T> : never
