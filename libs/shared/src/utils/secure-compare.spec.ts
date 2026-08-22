import { secureCompare } from './secure-compare';

describe('secureCompare', () => {
  it('returns true for two identical strings', () => {
    expect(secureCompare('super-secret-key', 'super-secret-key')).toBe(true);
  });

  it('returns false for two different strings of the same length', () => {
    expect(secureCompare('super-secret-key', 'super-secret-koy')).toBe(false);
  });

  it('returns false for two strings of different length, without throwing (triangulation)', () => {
    expect(() => secureCompare('short', 'a-much-longer-key')).not.toThrow();
    expect(secureCompare('short', 'a-much-longer-key')).toBe(false);
  });

  it('returns false when comparing against an empty string', () => {
    expect(secureCompare('some-key', '')).toBe(false);
  });
});
