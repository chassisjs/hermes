import { expect, test } from '@jest/globals'
import { AssertionError } from '../errors.js'
import { parseIncrementalId } from './IncrementalId.js'

test(`parseIncrementalId returns an integer greater than 0`, () => {
  expect(parseIncrementalId(1)).toBe(1)
  expect(parseIncrementalId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  expect(parseIncrementalId('1')).toBe(1)
  expect(parseIncrementalId(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
})

test(`parseIncrementalId throws an AssertionError if the value is not an integer greater than 0`, () => {
  expect(() => parseIncrementalId(0)).toThrow(AssertionError)
  expect(() => parseIncrementalId(-1)).toThrow(AssertionError)
  expect(() => parseIncrementalId(1.5)).toThrow(AssertionError)
  expect(() => parseIncrementalId(NaN)).toThrow(AssertionError)
  expect(() => parseIncrementalId(Infinity)).toThrow(AssertionError)
  expect(() => parseIncrementalId(Number.MAX_SAFE_INTEGER + 1)).toThrow(AssertionError)
  expect(() => parseIncrementalId(undefined)).toThrow(AssertionError)
  expect(() => parseIncrementalId('')).toThrow(AssertionError)
  expect(() => parseIncrementalId('0')).toThrow(AssertionError)
  expect(() => parseIncrementalId('-1')).toThrow(AssertionError)
  expect(() => parseIncrementalId('01')).toThrow(AssertionError)
  expect(() => parseIncrementalId('1.5')).toThrow(AssertionError)
  expect(() => parseIncrementalId('1e3')).toThrow(AssertionError)
  expect(() => parseIncrementalId(' 1')).toThrow(AssertionError)
  expect(() => parseIncrementalId('abc')).toThrow(AssertionError)
  expect(() => parseIncrementalId(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(AssertionError)
  expect(() => parseIncrementalId(1n as unknown as number)).toThrow(AssertionError)
  expect(() => parseIncrementalId(0, 'Wrong id')).toThrow('Wrong id')
})
