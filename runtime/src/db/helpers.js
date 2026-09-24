import { DatabaseError } from "../types.js"

export const wrapDb = (name, fn) => {
  const wrapped = (db, ...args) => {
    try {
      return fn(db, ...args)
    } catch (err) {
      /* v8 ignore next */
      throw new DatabaseError(name, err)
    }
  }
  return wrapped
}
