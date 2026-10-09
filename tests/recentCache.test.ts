// The bounded cache the Changes tab keeps each project's last unused-worktree list in (#476): the least recently used
// go first past its size, and a new scope (another workspace) empties it.
import { describe, expect, it } from 'vitest'
import { RecentCache } from '../src/shared/recentCache'

describe('RecentCache', () => {
  it('keeps at most its size, dropping the least recently used', () => {
    const c = new RecentCache<number>(3)
    for (const k of ['a', 'b', 'c']) c.set(k, k.charCodeAt(0))
    c.get('a') // a is now the newest
    c.set('d', 4)
    expect(c.size).toBe(3)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(97)
    expect(c.get('c')).toBe(99)
    expect(c.get('d')).toBe(4)
  })

  it('a key set again is the newest, not a second entry', () => {
    const c = new RecentCache<string>(2)
    c.set('a', '1')
    c.set('b', '2')
    c.set('a', '3')
    c.set('c', '4')
    expect(c.size).toBe(2)
    expect(c.get('a')).toBe('3')
    expect(c.get('b')).toBeUndefined()
  })

  it('empties when its scope changes, never when it is the same', () => {
    const c = new RecentCache<number>(5)
    c.scope('D:\\ws1').set('p', 1)
    expect(c.scope('D:\\ws1').get('p')).toBe(1)
    expect(c.scope('D:\\ws2').get('p')).toBeUndefined()
    expect(c.size).toBe(0)
    c.set('q', 2)
    expect(c.scope(null).size).toBe(0)
  })

  it('stays bounded however many keys pass through it', () => {
    const c = new RecentCache<number>(20)
    for (let i = 0; i < 1000; i++) c.set(`p${i}`, i)
    expect(c.size).toBe(20)
    expect(c.get('p999')).toBe(999)
    expect(c.get('p979')).toBeUndefined()
  })
})
