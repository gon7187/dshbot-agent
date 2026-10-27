// Minimal JSON5 reader for the OpenClaw config.
//
// OpenClaw writes `openclaw.json` with comments, unquoted keys, single-quoted
// strings and trailing commas, and JSON5 numbers (`0x7b`, `+1`, `.5`, `5.`,
// `Infinity`, `NaN`) are valid there too. The migration must read it without
// pulling a dependency into the repository, so this module is a small
// recursive-descent parser of the whole JSON5 grammar (https://spec.json5.org).

/** Parse a JSON5 document. Throws a generic error without quoting the input. */
export function parseJson5(text: string): unknown {
  const parser = new Parser(text)
  parser.skip()
  const value = parser.value()
  parser.skip()
  if (!parser.done()) parser.fail('лишний текст после значения')
  return value
}

const ID_START = /[\p{L}\p{Nl}$_]/u
const ID_PART = /[\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$_\u200c\u200d]/u
const SPACE = /[\t\n\v\f\r \u00a0\u2028\u2029\ufeff\p{Zs}]/u
const LINE_END = /[\n\r\u2028\u2029]/
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }

class Parser {
  private readonly text: string
  private index = 0

  constructor(text: string) {
    this.text = text
  }

  done(): boolean {
    return this.index >= this.text.length
  }

  fail(reason: string): never {
    throw new Error(`JSON5: ${reason} (позиция ${this.index})`)
  }

  /** Skip whitespace and both kinds of comments. */
  skip(): void {
    const text = this.text
    while (this.index < text.length) {
      const char = text[this.index] as string
      if (SPACE.test(char)) {
        this.index += 1
        continue
      }
      if (char === '/' && text[this.index + 1] === '/') {
        this.index += 2
        while (this.index < text.length && !LINE_END.test(text[this.index] as string)) this.index += 1
        continue
      }
      if (char === '/' && text[this.index + 1] === '*') {
        const end = text.indexOf('*/', this.index + 2)
        if (end < 0) this.fail('незакрытый комментарий')
        this.index = end + 2
        continue
      }
      return
    }
  }

  value(): unknown {
    const char = this.text[this.index]
    if (char === undefined) this.fail('неожиданный конец')
    if (char === '{') return this.object()
    if (char === '[') return this.array()
    if (char === '"' || char === "'") return this.string()
    if (char === '-' || char === '+' || char === '.' || (char >= '0' && char <= '9')) return this.number()
    const word = this.identifier()
    if (word === 'true') return true
    if (word === 'false') return false
    if (word === 'null') return null
    if (word === 'Infinity') return Infinity
    if (word === 'NaN') return NaN
    return this.fail('неизвестное значение')
  }

  private object(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    this.index += 1
    this.skip()
    while (this.text[this.index] !== '}') {
      const key = this.text[this.index] === '"' || this.text[this.index] === "'" ? this.string() : this.identifier()
      this.skip()
      if (this.text[this.index] !== ':') this.fail('ожидалось «:»')
      this.index += 1
      this.skip()
      // An own property even for `__proto__`, exactly like JSON.parse.
      Object.defineProperty(result, key, { value: this.value(), enumerable: true, writable: true, configurable: true })
      this.skip()
      if (this.text[this.index] === ',') {
        this.index += 1
        this.skip()
        continue
      }
      if (this.text[this.index] !== '}') this.fail('ожидалось «,» или «}»')
    }
    this.index += 1
    return result
  }

  private array(): unknown[] {
    const result: unknown[] = []
    this.index += 1
    this.skip()
    while (this.text[this.index] !== ']') {
      result.push(this.value())
      this.skip()
      if (this.text[this.index] === ',') {
        this.index += 1
        this.skip()
        continue
      }
      if (this.text[this.index] !== ']') this.fail('ожидалось «,» или «]»')
    }
    this.index += 1
    return result
  }

  /** IdentifierName of ES5.1, including `\uXXXX` escapes. */
  private identifier(): string {
    let out = ''
    for (;;) {
      let char = this.text[this.index]
      if (char === undefined) break
      if (char === '\\') {
        if (this.text[this.index + 1] !== 'u') this.fail('неверная escape-последовательность в имени')
        char = String.fromCharCode(this.hex(this.index + 2, 4))
        if (!(out === '' ? ID_START : ID_PART).test(char)) this.fail('неверный символ в имени')
        out += char
        this.index += 6
        continue
      }
      const point = String.fromCodePoint(this.text.codePointAt(this.index) as number)
      if (!(out === '' ? ID_START : ID_PART).test(point)) break
      out += point
      this.index += point.length
    }
    if (out === '') this.fail('ожидалось имя или значение')
    return out
  }

  private hex(at: number, length: number): number {
    const digits = this.text.slice(at, at + length)
    if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) this.fail('неверная escape-последовательность')
    return Number.parseInt(digits, 16)
  }

  private string(): string {
    const quote = this.text[this.index]
    let out = ''
    this.index += 1
    for (;;) {
      const char = this.text[this.index]
      if (char === undefined) this.fail('незакрытая строка')
      if (char === quote) {
        this.index += 1
        return out
      }
      if (char === '\n' || char === '\r') this.fail('перевод строки внутри строки')
      if (char !== '\\') {
        out += char
        this.index += 1
        continue
      }
      const next = this.text[this.index + 1]
      if (next === undefined) this.fail('незакрытая строка')
      this.index += 2
      const simple = SIMPLE_ESCAPES[next]
      if (simple !== undefined) {
        out += simple
        continue
      }
      if (next === '0') {
        if (/[0-9]/.test(this.text[this.index] ?? '')) this.fail('восьмеричная escape-последовательность')
        out += '\0'
        continue
      }
      if (next === 'x' || next === 'u') {
        const length = next === 'x' ? 2 : 4
        out += String.fromCharCode(this.hex(this.index, length))
        this.index += length
        continue
      }
      // A line continuation: the escaped line terminator is dropped.
      if (next === '\r') {
        if (this.text[this.index] === '\n') this.index += 1
        continue
      }
      if (LINE_END.test(next)) continue
      if (/[1-9]/.test(next)) this.fail('восьмеричная escape-последовательность')
      out += next
    }
  }

  private number(): number {
    const rest = this.text.slice(this.index)
    const match =
      /^([+-]?)(?:(Infinity)|(NaN)|0[xX]([0-9a-fA-F]+)|((?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?))/.exec(rest)
    if (match === null) return this.fail('неверное число')
    const after = rest[match[0].length]
    if (after !== undefined && (ID_PART.test(after) || after === '.')) this.fail('неверное число')
    this.index += match[0].length
    const sign = match[1] === '-' ? -1 : 1
    if (match[2] !== undefined) return sign * Infinity
    if (match[3] !== undefined) return NaN
    if (match[4] !== undefined) return sign * Number.parseInt(match[4], 16)
    return sign * Number(match[5])
  }
}
