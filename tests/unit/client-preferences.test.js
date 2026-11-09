/** @jest-environment jsdom */

'use strict';

const { loadPreferences } = require('../helpers/load-client-module');

let prefs;

beforeEach(() => {
  prefs = loadPreferences();
  localStorage.clear();
  delete document.documentElement.dataset.accent;
  delete document.documentElement.dataset.motion;
});

describe('appearance preferences', () => {
  test('a fresh device starts on teal with full motion', () => {
    expect(prefs.readAccent()).toBe('teal');
    expect(prefs.readMotion()).toBe(false);
    expect(prefs.ACCENTS.map((entry) => entry.id)).toEqual(['teal', 'indigo', 'rose', 'amber']);
  });

  test('every family carries both members of its pair', () => {
    for (const entry of prefs.ACCENTS) {
      expect(entry.light).toMatch(/^#[0-9a-f]{6}$/);
      expect(entry.deep).toMatch(/^#[0-9a-f]{6}$/);
      expect(entry.light).not.toBe(entry.deep);
    }
  });

  test('saving an accent stores it and repaints the root in the same call', () => {
    expect(prefs.saveAccent('indigo')).toBe('indigo');
    expect(localStorage.getItem('inchat-accent')).toBe('indigo');
    expect(document.documentElement.dataset.accent).toBe('indigo');
  });

  test('a hostile stored value cannot invent a family or a key', () => {
    localStorage.setItem('inchat-accent', 'chartreuse');
    expect(prefs.readAccent()).toBe('teal');
    expect(prefs.saveAccent('chartreuse')).toBe('teal');
    expect(document.documentElement.dataset.accent).toBe('teal');
  });

  test('reduced motion is stored as a word, not as whatever was passed', () => {
    expect(prefs.saveMotion(true)).toBe(true);
    expect(localStorage.getItem('inchat-motion')).toBe('reduced');
    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(prefs.readMotion()).toBe(true);
    expect(prefs.saveMotion(false)).toBe(false);
    expect(localStorage.getItem('inchat-motion')).toBe('full');
    expect(document.documentElement.dataset.motion).toBe('full');
  });

  test('only the exact reduced flag counts, so a stale value keeps full motion', () => {
    localStorage.setItem('inchat-motion', 'REDUCED');
    expect(prefs.readMotion()).toBe(false);
    localStorage.setItem('inchat-motion', '1');
    expect(prefs.readMotion()).toBe(false);
  });

  test('applyPreferences restores both attributes at startup', () => {
    localStorage.setItem('inchat-accent', 'rose');
    localStorage.setItem('inchat-motion', 'reduced');
    prefs.applyPreferences();
    expect(document.documentElement.dataset.accent).toBe('rose');
    expect(document.documentElement.dataset.motion).toBe('reduced');
  });

  test('storage that throws degrades to the defaults instead of crashing', () => {
    const getItem = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') });
    try {
      expect(prefs.readAccent()).toBe('teal');
      expect(prefs.readMotion()).toBe(false);
    } finally {
      getItem.mockRestore();
    }
  });
});
