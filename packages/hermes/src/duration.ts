import { assert } from './utils/assert.js'

export class Duration {
  private constructor(private _ms: number) {}

  get value() {
    return this._ms
  }

  get ms() {
    return this._ms
  }

  static from(duration: Duration) {
    return new Duration(duration.ms)
  }

  static ofDays(hours: number) {
    assert(hours >= 0, `hours has to be greater or equal 0`)

    return new Duration(hours * 24 * 60 * 60 * 1000)
  }

  static ofHours(hours: number) {
    assert(hours >= 0, `hours has to be greater or equal 0`)

    return new Duration(hours * 60 * 60 * 1000)
  }

  static ofMinutes(minutes: number) {
    assert(minutes >= 0, `minutes has to be greater or equal 0`)

    return new Duration(minutes * 60 * 1000)
  }

  static ofSeconds(seconds: number) {
    assert(seconds >= 0, `seconds has to be greater or equal 0`)

    return new Duration(seconds * 1000)
  }

  static ofMiliseconds(miliseconds: number) {
    assert(miliseconds >= 0, `miliseconds has to be greater or equal 0`)

    return new Duration(miliseconds)
  }
}
