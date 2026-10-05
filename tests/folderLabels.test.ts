import { describe, expect, it } from 'vitest'
import { distinguishingParents } from '../src/shared/folderLabels'

describe('distinguishingParents', () => {
  it('leaves folders with a name of their own out', () => {
    expect(distinguishingParents(['D:\\a\\one', 'D:\\b\\two']).size).toBe(0)
  })

  it('gives folders with the same name their nearest parent', () => {
    const m = distinguishingParents(['D:\\client-a\\work', 'D:\\client-b\\Work', 'D:\\x\\other'])
    expect([...m]).toEqual([
      ['d:\\client-a\\work', 'client-a'],
      ['d:\\client-b\\work', 'client-b']
    ])
  })

  it('goes further up when the nearest parents are the same too', () => {
    const m = distinguishingParents(['D:\\one\\src\\work', 'D:\\two\\SRC\\work'])
    expect(m.get('d:\\one\\src\\work')).toBe('one\\src')
    expect(m.get('d:\\two\\src\\work')).toBe('two\\SRC')
  })

  it('tells drives apart, and a shallower folder by what it has', () => {
    const m = distinguishingParents(['D:\\work', 'E:\\work', 'E:\\a\\work'])
    expect(m.get('d:\\work')).toBe('D:')
    expect(m.get('e:\\work')).toBe('E:')
    expect(m.get('e:\\a\\work')).toBe('a')
  })

  it('treats paths differing only in case as one folder', () => {
    expect(distinguishingParents(['D:\\a\\work', 'd:\\A\\WORK']).size).toBe(0)
  })

  it('keeps forward slashes', () => {
    expect(distinguishingParents(['/home/a/work', '/home/b/work']).get('/home/a/work')).toBe('a')
  })
})
