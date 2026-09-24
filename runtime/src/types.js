export class DatabaseError extends Error {
  constructor(operation, cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(`${operation}: ${message}`)
    this.name = "DatabaseError"
    this.operation = operation
    this.cause = cause
  }
}
