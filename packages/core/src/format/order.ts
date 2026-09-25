/**
 * Order keys: short strings that sort (plain string comparison) in display
 * order, with a key between any two keys, so moving a block only ever
 * changes that block's key.
 *
 * Keys are an integer part (a head letter giving its length, then base-62
 * digits) and an optional fraction: `a0`, `a1`, … `az`, `b00`, …; inserting
 * between `a1` and `a2` gives `a1V`. Appending at the end increments the
 * integer part, so keys stay short however long a list grows. This is the
 * well-known "fractional indexing" scheme (as in Figma / rocicorp).
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SMALLEST_INTEGER = `A${'0'.repeat(26)}`

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2
  throw new Error(`Invalid order key head: ${head}`)
}

function integerPart(key: string): string {
  const n = integerLength(key[0])
  if (n > key.length) throw new Error(`Invalid order key: ${key}`)
  return key.slice(0, n)
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int[0])) throw new Error(`Invalid integer part: ${int}`)
  for (const c of int.slice(1)) if (!DIGITS.includes(c)) throw new Error(`Invalid integer part: ${int}`)
}

/** Throws unless `key` is a well-formed order key. */
export function validateOrderKey(key: string): void {
  if (!key || key === SMALLEST_INTEGER) throw new Error(`Invalid order key: ${key}`)
  const int = integerPart(key)
  validateInteger(int)
  const frac = key.slice(int.length)
  for (const c of frac) if (!DIGITS.includes(c)) throw new Error(`Invalid order key: ${key}`)
  if (frac.endsWith('0')) throw new Error(`Invalid order key: ${key}`)
}

export function isValidOrderKey(key: string): boolean {
  try {
    validateOrderKey(key)
    return true
  } catch {
    return false
  }
}

/** A fraction strictly between `a` and `b` (b null = 1). No trailing zeros. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`)
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) throw new Error('Trailing zero')
  if (b !== null) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0
  const db = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))]
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return DIGITS[da] + midpoint(a.slice(1), null)
}

function incrementInteger(x: string): string | null {
  validateInteger(x)
  const [head, ...digits] = x.split('')
  let carry = true
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1
    if (d === DIGITS.length) digits[i] = '0'
    else {
      digits[i] = DIGITS[d]
      carry = false
    }
  }
  if (!carry) return head + digits.join('')
  if (head === 'Z') return 'a0'
  if (head === 'z') return null
  const h = String.fromCharCode(head.charCodeAt(0) + 1)
  if (h > 'a') digits.push('0')
  else digits.pop()
  return h + digits.join('')
}

function decrementInteger(x: string): string | null {
  validateInteger(x)
  const [head, ...digits] = x.split('')
  let borrow = true
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1
    if (d === -1) digits[i] = DIGITS[DIGITS.length - 1]
    else {
      digits[i] = DIGITS[d]
      borrow = false
    }
  }
  if (!borrow) return head + digits.join('')
  if (head === 'a') return `Z${DIGITS[DIGITS.length - 1]}`
  if (head === 'A') return null
  const h = String.fromCharCode(head.charCodeAt(0) - 1)
  if (h < 'Z') digits.push(DIGITS[DIGITS.length - 1])
  else digits.pop()
  return h + digits.join('')
}

/**
 * A key that sorts strictly between `a` and `b` (either may be null for
 * "the start" / "the end"). Throws if `a >= b` or either key is malformed;
 * callers renumber the list in that case.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateOrderKey(a)
  if (b !== null) validateOrderKey(b)
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`)
  if (a === null) {
    if (b === null) return 'a0'
    const ib = integerPart(b)
    const fb = b.slice(ib.length)
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb)
    if (ib < b) return ib
    const dec = decrementInteger(ib)
    if (dec === null) throw new Error('Cannot decrement any more')
    return dec
  }
  if (b === null) {
    const ia = integerPart(a)
    const fa = a.slice(ia.length)
    const inc = incrementInteger(ia)
    return inc === null ? ia + midpoint(fa, null) : inc
  }
  const ia = integerPart(a)
  const fa = a.slice(ia.length)
  const ib = integerPart(b)
  const fb = b.slice(ib.length)
  if (ia === ib) return ia + midpoint(fa, fb)
  const inc = incrementInteger(ia)
  if (inc === null) throw new Error('Cannot increment any more')
  if (inc < b) return inc
  return ia + midpoint(fa, null)
}

/** `n` keys in order, all strictly between `a` and `b`. */
export function keysBetween(a: string | null, b: string | null, n: number): string[] {
  const out: string[] = []
  let prev = a
  if (b === null) {
    for (let i = 0; i < n; i++) out.push((prev = keyBetween(prev, null)))
    return out
  }
  // Bisect so keys stay short when squeezing many between two neighbours.
  if (n === 0) return out
  if (n === 1) return [keyBetween(a, b)]
  const mid = Math.floor(n / 2)
  const m = keyBetween(a, b)
  return [...keysBetween(a, m, mid), m, ...keysBetween(m, b, n - mid - 1)]
}
