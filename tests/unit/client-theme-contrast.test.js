'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The stylesheet is commented in prose; the selectors are what this file reads.
const CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The tokens a theme actually paints with, collected the way the browser would:
 * every rule whose selector is the document root or that theme's attribute, in
 * source order, later declarations winning over earlier ones.
 */
function tokensFor(theme) {
  const tokens = {}
  const rule = /([^{}]+)\{([^{}]*)\}/g
  let match
  while ((match = rule.exec(CSS))) {
    const applies = match[1].split(',').some((selector) => {
      const sel = selector.trim()
      return sel === ':root'
        || (theme === 'dark' && (sel === "[data-theme='dark']" || sel === '[data-theme=dark]'))
        || (theme === 'light' && (sel === "[data-theme='light']" || sel === '[data-theme=light]'))
    })
    if (!applies) continue
    for (const declaration of match[2].split(';')) {
      const separator = declaration.indexOf(':')
      const name = declaration.slice(0, separator).trim()
      if (!name.startsWith('--')) continue
      const value = declaration.slice(separator + 1).trim()
      tokens[name] = value.startsWith('var(') ? tokens[value.slice(4, -1).trim()] || value : value
    }
  }
  return tokens
}

const channel = (hex) => {
  const c = Number.parseInt(hex, 16) / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex) => {
  const rgb = hex.replace('#', '').match(/../g).map(channel)
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}
const ratio = (one, two) => {
  const values = [luminance(one), luminance(two)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}
const mix = (over, under, weight) => {
  const a = over.replace('#', '').match(/../g).map((part) => Number.parseInt(part, 16))
  const b = under.replace('#', '').match(/../g).map((part) => Number.parseInt(part, 16))
  return `#${a.map((value, index) => Math.round(value * weight + b[index] * (1 - weight)).toString(16).padStart(2, '0')).join('')}`
}
const ruleBody = (selector) => {
  const start = CSS.indexOf(`${selector}{`)
  if (start < 0) throw new Error(`${selector} is not in the stylesheet`)
  return CSS.slice(start + selector.length + 1, CSS.indexOf('}', start))
}

describe('the colour of a failure', () => {
  const surfaces = ['--bg', '--surface', '--surface-2', '--elevated']

  test('is a token, so each theme can answer with its own red', () => {
    for (const selector of ['.feed-failure', '.call-row span.missed', '.rich-composer-error', '.call-feedback']) {
      expect(ruleBody(selector)).toMatch(/color:\s*var\(--danger-text\)/)
    }
    expect(tokensFor('dark')['--danger-text']).toMatch(/^#[0-9a-f]{6}$/)
    expect(tokensFor('light')['--danger-text']).toMatch(/^#[0-9a-f]{6}$/)
  })

  test('clears AA on every surface both themes paint', () => {
    for (const theme of ['dark', 'light']) {
      const tokens = tokensFor(theme)
      for (const surface of surfaces) {
        expect(ratio(tokens['--danger-text'], tokens[surface])).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('stays readable inside the tint it sits on', () => {
    for (const theme of ['dark', 'light']) {
      const tokens = tokensFor(theme)
      for (const selector of ['.rich-composer-error', '.call-feedback']) {
        const weight = Number(ruleBody(selector).match(/color-mix\(in srgb,\s*var\(--danger-text\)\s+(\d+)%/)[1]) / 100
        expect(ratio(tokens['--danger-text'], mix(tokens['--danger-text'], tokens['--surface'], weight)))
          .toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  test('the gone-file strip hangs off the stage it covers', () => {
    expect(ruleBody('.media-viewer-stage')).toMatch(/position:\s*relative/)
    expect(ruleBody('.media-viewer-failure')).toMatch(/position:\s*absolute/)
  })

  test('a guest who asked for less motion gets a still skeleton, not a sweeping one', () => {
    const blocks = CSS.match(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/g) || []
    const still = blocks.find((block) => block.includes('.skeleton-bubble'))
    expect(still).toBeDefined()
    expect(still).toMatch(/\.skeleton-bubble\{[^}]*animation:\s*none/)
    expect(still).toMatch(/\.skeleton-bubble\{[^}]*background:\s*var\(--skeleton-base\)/)
  })

  test('the shimmer has a fill of its own, because white on white shows nothing', () => {
    const body = ruleBody('.skeleton-bubble')
    expect(body).toMatch(/linear-gradient\(100deg,\s*var\(--skeleton-base\)/)
    expect(body).toMatch(/var\(--skeleton-shine\)/)
    for (const theme of ['dark', 'light']) {
      const tokens = tokensFor(theme)
      expect(tokens['--skeleton-base']).toBeTruthy()
      expect(tokens['--skeleton-shine']).toBeTruthy()
      expect(tokens['--skeleton-base']).not.toBe(tokens['--skeleton-shine'])
      expect(tokens['--skeleton-base']).not.toBe(tokens['--surface'])
    }
  })

  test('the loading shapes keep the width of the transcript they stand in', () => {
    // The transcript column starts its children, so anything that wants the
    // full width has to ask for it - a five-bubble skeleton otherwise collapses
    // to the width of its own padding.
    expect(ruleBody('.transcript-skeleton')).toMatch(/align-self:\s*stretch/)
    expect(CSS).toMatch(/\.preview-body \.feed-failure[^{}]*\{[^}]*align-self:\s*stretch/)
  })
})
