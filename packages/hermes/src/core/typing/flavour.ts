export const __FLAVOUR_TYPE__ = Symbol('__flavour')

export type WithFlavour<T extends string> = {
  readonly __flavour?: T
}

export type WithoutFlavour<T> = Omit<T, '__flavour'>

export type Flavour<K, T> = K & {
  readonly __flavour?: T
}
