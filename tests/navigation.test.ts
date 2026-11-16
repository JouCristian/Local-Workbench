import { describe, expect, it } from 'vitest';
import { dateIntent, menuIntent, orderDirection } from '../src/presentation/navigation';

describe('navigation intent', () => {
  it('follows vertical sidebar order in both directions', () => {
    expect(menuIntent(0, 3)).toEqual({ axis: 'y', direction: 1 });
    expect(menuIntent(3, 0)).toEqual({ axis: 'y', direction: -1 });
  });
  it('follows calendar order across weeks and years', () => {
    expect(dateIntent('2026-11-04', '2026-11-21')).toEqual({ axis: 'x', direction: 1 });
    expect(dateIntent('2026-11-21', '2026-11-04')).toEqual({ axis: 'x', direction: -1 });
    expect(orderDirection('2027-01-01', '2026-12-31')).toBe(-1);
  });
});
