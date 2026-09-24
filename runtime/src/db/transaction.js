/**
 * Run a function inside a SQLite transaction (BEGIN / COMMIT / ROLLBACK).
 *
 * node:sqlite's DatabaseSync does not provide a built-in `db.transaction()`
 * helper like better-sqlite3, so we wrap BEGIN/COMMIT/ROLLBACK manually.
 */
let savepointId = 0

const runSavepoint = (db, fn) => {
  const savepoint = `rec_tx_${++savepointId}`
  db.exec(`SAVEPOINT ${savepoint}`)

  try {
    const result = fn()
    db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    return result
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
    db.exec(`RELEASE SAVEPOINT ${savepoint}`)
    throw err
  }
}

export const runTransaction = (db, fn) => {
  if (db.isTransaction) {
    return runSavepoint(db, fn)
  }

  db.exec("BEGIN")
  try {
    const result = fn()
    db.exec("COMMIT")
    return result
  } catch (err) {
    db.exec("ROLLBACK")
    throw err
  }
}
