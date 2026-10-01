import { describe, expect, it } from 'vitest'
import { isTyping } from '../src/shared/terminalInput'

describe('isTyping', () => {
  it("ignores xterm's replies to the program", () => {
    for (const reply of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[12;40R',
      '\x1b[?62;22c',
      '\x1b[>0;276;0c',
      '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\',
      '\x1b]10;rgb:cccc/cccc/cccc\x07',
      '\x1bP>|xterm.js(5.5.0)\x1b\\',
      '\x1b[?1u\x1b]11;rgb:0000/0000/0000\x1b\\'
    ])
      expect(isTyping(reply), JSON.stringify(reply)).toBe(false)
  })

  it('counts keys, Enter and pastes as typing', () => {
    for (const keys of ['a', '\r', '\x7f', '\x03', 'hello world', '\x1b[200~pasted\x1b[201~']) expect(isTyping(keys), JSON.stringify(keys)).toBe(true)
  })
})
