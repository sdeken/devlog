import { describe, expect, it } from 'vitest'
import { THEME_PRESETS, luminance, mix, resolveTheme, sanitizeTheme, themeCssVars } from '../src/shared/theme'

describe('theme', () => {
  it('sanitizes presets and overrides', () => {
    expect(sanitizeTheme(undefined)).toEqual({ preset: 'graphite' })
    expect(sanitizeTheme({ preset: 'nope' })).toEqual({ preset: 'graphite' })
    expect(sanitizeTheme({ preset: 'ocean', sidebar: '#ABCDEF', accent: 'red' })).toEqual({ preset: 'ocean', sidebar: '#abcdef' })
    expect(sanitizeTheme({ preset: 'forest', sidebar: '123456' })).toEqual({ preset: 'forest', sidebar: '#123456' })
  })

  it('derives readable text for dark and light sidebars', () => {
    const dark = resolveTheme({ preset: 'graphite' })
    expect(dark.lightSidebar).toBe(false)
    expect(luminance(dark.sidebarFg)).toBeGreaterThan(0.6)
    const light = resolveTheme({ preset: 'paper' })
    expect(light.lightSidebar).toBe(true)
    expect(luminance(light.sidebarFg)).toBeLessThan(0.1)
    expect(resolveTheme({ preset: 'graphite', accent: '#ffff00' }).accentFg).toBe('#111111')
  })

  it('applies overrides and exposes css variables', () => {
    const r = resolveTheme({ preset: 'graphite', sidebar: '#3f0e40', accent: '#007a5a' })
    expect(r.sidebarBg).toBe('#3f0e40')
    expect(r.accent).toBe('#007a5a')
    expect(r.sidebarActive).toBe('#007a5a')
    expect(luminance(r.topbarBg)).toBeLessThan(luminance(r.sidebarBg))
    const vars = themeCssVars({ preset: 'ocean' })
    expect(vars['--sidebar-bg']).toBe(THEME_PRESETS.find((p) => p.id === 'ocean')!.sidebar)
    expect(Object.keys(vars)).toContain('--topbar-bg')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})
