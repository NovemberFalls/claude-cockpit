import { describe, it, expect } from 'vitest';
import {
  THEMES,
  getTheme,
  listThemes,
  getSavedTheme,
  applyThemeToDOM,
} from '../themes/themeData.js';

const REQUIRED_PROPERTIES = [
  'id', 'label', 'group',
  'bg', 'bgSurface', 'bgElevated', 'bgHighlight',
  'fg', 'fgDim', 'fgMuted',
  'accent', 'accentWarm',
  'green', 'red', 'yellow', 'purple', 'cyan',
  'border',
  'hexBase', 'hexGlow', 'hexGlowIntensity',
  'fontFamily', 'scanlines',
];

describe('THEMES object', () => {
  it('exists and has entries', () => {
    expect(THEMES).toBeDefined();
    expect(typeof THEMES).toBe('object');
    const keys = Object.keys(THEMES);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('contains both dark and light variants', () => {
    const groups = new Set(Object.values(THEMES).map((t) => t.group));
    expect(groups.has('dark')).toBe(true);
    expect(groups.has('light')).toBe(true);
  });

  it('has 20 themes (10 palettes x 2 variants)', () => {
    expect(Object.keys(THEMES)).toHaveLength(20);
  });
});

describe('theme properties', () => {
  const themeEntries = Object.entries(THEMES);

  it.each(themeEntries)(
    '%s has all required properties',
    (_id, theme) => {
      for (const prop of REQUIRED_PROPERTIES) {
        expect(theme).toHaveProperty(prop);
      }
    },
  );

  it.each(themeEntries)(
    '%s has a valid group value (dark or light)',
    (_id, theme) => {
      expect(['dark', 'light']).toContain(theme.group);
    },
  );

  it.each(themeEntries)(
    '%s id matches its key in THEMES',
    (id, theme) => {
      expect(theme.id).toBe(id);
    },
  );
});

describe('getTheme', () => {
  it('returns a theme object for a valid id', () => {
    const theme = getTheme('tokyo-night-dark');
    expect(theme).toBeDefined();
    expect(theme.id).toBe('tokyo-night-dark');
  });

  it('returns null for an invalid id', () => {
    expect(getTheme('nonexistent-theme')).toBeNull();
  });
});

describe('listThemes', () => {
  it('returns an array with id, label, and group for each theme', () => {
    const list = listThemes();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(Object.keys(THEMES).length);
    for (const entry of list) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('label');
      expect(entry).toHaveProperty('group');
    }
  });
});

describe('getSavedTheme', () => {
  it('returns null when no theme is stored', () => {
    localStorage.clear();
    expect(getSavedTheme()).toBeNull();
  });
});

describe('applyThemeToDOM', () => {
  it('is a function', () => {
    expect(typeof applyThemeToDOM).toBe('function');
  });

  it('sets CSS custom properties on document.documentElement', () => {
    const theme = THEMES['tokyo-night-dark'];
    applyThemeToDOM(theme);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--bg')).toBe(theme.bg);
    expect(style.getPropertyValue('--accent')).toBe(theme.accent);
    expect(style.getPropertyValue('--text-primary')).toBe(theme.fg);
  });

  it('does nothing when called with a falsy value', () => {
    // Should not throw
    expect(() => applyThemeToDOM(null)).not.toThrow();
    expect(() => applyThemeToDOM(undefined)).not.toThrow();
  });
});
