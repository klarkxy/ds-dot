import { describe, expect, it } from 'vitest'
import { directoriesConflict } from './lock.ts'

describe('directory locks', () => {
  it('recognizes nested paths and directory boundaries', () => {
    expect(directoriesConflict('/work/a/', '/work/a/child', 'linux')).toBe(true)
    expect(directoriesConflict('/work/a', '/work/abc', 'linux')).toBe(false)
    expect(directoriesConflict('/', '/work', 'linux')).toBe(true)
  })
  it('compares Windows paths without case and respects drive roots', () => {
    expect(directoriesConflict('C:\\WORK\\Project\\', 'c:\\work\\project\\Sub', 'win32')).toBe(true)
    expect(directoriesConflict('H:\\', 'H:\\Other', 'win32')).toBe(true)
    expect(directoriesConflict('H:\\Other', 'h:\\', 'win32')).toBe(true)
    expect(directoriesConflict('H:\\', 'D:\\Other', 'win32')).toBe(false)
    expect(directoriesConflict('C:\\work', 'D:\\work', 'win32')).toBe(false)
    expect(directoriesConflict('C:\\work', 'C:\\workshop', 'win32')).toBe(false)
  })
})
