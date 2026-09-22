/**
 * Colour themes. A theme is a preset name plus optional overrides for the
 * two colours that matter most: the sidebar (also the top bar and, on
 * Windows, the title-bar controls) and the accent. Everything else is
 * derived so a custom colour never needs six more inputs.
 */
import type { ThemeSettings } from './types'

export interface ThemePreset {
  id: string
  label: string
  sidebar: string
  accent: string
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: 'graphite', label: 'Graphite', sidebar: '#1f2933', accent: '#0f9d8a' },
  { id: 'ocean', label: 'Ocean', sidebar: '#153048', accent: '#2f80ed' },
  { id: 'forest', label: 'Forest', sidebar: '#1e3a2f', accent: '#3aa76d' },
  { id: 'ember', label: 'Ember', sidebar: '#3a2320', accent: '#e07a2f' },
  { id: 'aubergine', label: 'Aubergine', sidebar: '#3f0e40', accent: '#007a5a' },
  { id: 'paper', label: 'Paper', sidebar: '#ececee', accent: '#1264a3' }
]

export const DEFAULT_THEME: ThemeSettings = { preset: 'graphite' }

export interface ResolvedTheme {
  sidebarBg: string
  sidebarFg: string
  sidebarMuted: string
  sidebarHover: string
  sidebarActive: string
  /** Top bar: slightly darker than the sidebar so the two read as separate surfaces. */
  topbarBg: string
  accent: string
  accentFg: string
  /** True when the sidebar is light and needs dark text. */
  lightSidebar: boolean
}

const HEX_RE = /^#?([0-9a-f]{6})$/i

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_RE.test(v.trim())
}

export function normalizeHex(v: string): string {
  const m = HEX_RE.exec(v.trim())
  return m ? `#${m[1].toLowerCase()}` : '#000000'
}

function rgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex).slice(1)
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function hex([r, g, b]: [number, number, number]): string {
  const c = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** Mix `color` towards `target` by `amount` (0–1). */
export function mix(color: string, target: string, amount: number): string {
  const a = rgb(color)
  const b = rgb(target)
  return hex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount])
}

/** Relative luminance (WCAG), 0 dark → 1 light. */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function sanitizeTheme(t: Partial<ThemeSettings> | undefined | null): ThemeSettings {
  const preset = t?.preset && THEME_PRESETS.some((p) => p.id === t.preset) ? t.preset : DEFAULT_THEME.preset
  const out: ThemeSettings = { preset }
  if (isHexColor(t?.sidebar)) out.sidebar = normalizeHex(t!.sidebar!)
  if (isHexColor(t?.accent)) out.accent = normalizeHex(t!.accent!)
  return out
}

export function resolveTheme(t: ThemeSettings | undefined | null): ResolvedTheme {
  const clean = sanitizeTheme(t)
  const preset = THEME_PRESETS.find((p) => p.id === clean.preset) ?? THEME_PRESETS[0]
  const sidebarBg = clean.sidebar ?? preset.sidebar
  const accent = clean.accent ?? preset.accent
  const light = luminance(sidebarBg) > 0.4
  return {
    sidebarBg,
    sidebarFg: light ? mix(sidebarBg, '#000000', 0.82) : mix(sidebarBg, '#ffffff', 0.86),
    sidebarMuted: light ? mix(sidebarBg, '#000000', 0.5) : mix(sidebarBg, '#ffffff', 0.55),
    sidebarHover: light ? mix(sidebarBg, '#000000', 0.07) : mix(sidebarBg, '#ffffff', 0.08),
    sidebarActive: accent,
    topbarBg: light ? mix(sidebarBg, '#000000', 0.06) : mix(sidebarBg, '#000000', 0.22),
    accent,
    accentFg: luminance(accent) > 0.5 ? '#111111' : '#ffffff',
    lightSidebar: light
  }
}

/** CSS custom properties for the renderer to set on `:root`. */
export function themeCssVars(t: ThemeSettings | undefined | null): Record<string, string> {
  const r = resolveTheme(t)
  return {
    '--sidebar-bg': r.sidebarBg,
    '--sidebar-fg': r.sidebarFg,
    '--sidebar-muted': r.sidebarMuted,
    '--sidebar-hover': r.sidebarHover,
    '--sidebar-active': r.sidebarActive,
    '--topbar-bg': r.topbarBg,
    '--accent': r.accent,
    '--accent-fg': r.accentFg
  }
}
