import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'

declare module 'node:sqlite' {
  interface StatementSync {
    /**
     * Rows typed by the caller's row interface, e.g. `stmt.all() as ScheduleRow[]`:
     * the assertion's contextual type infers `Row`. Columns stay SQLite output values;
     * without a context the result is the stock `Record<string, SQLOutputValue>[]`.
     */
    all<Row extends { [K in keyof Row]: SQLOutputValue } = Record<string, SQLOutputValue>>(
      ...anonymousParameters: SQLInputValue[]
    ): Row[]
  }
}
