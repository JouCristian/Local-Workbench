export type MotionIntent = { axis: 'x' | 'y' | 'z'; direction: 1 | -1; origin?: string };
export const zoomIntent = (direction: 1 | -1, origin = '50% 35%'): MotionIntent => ({
  axis: 'z',
  direction,
  origin,
});
export function elementOrigin(element: HTMLElement): string {
  const pane = element.closest('.view-switch-pane')?.getBoundingClientRect(),
    rect = element.getBoundingClientRect();
  if (!pane?.width || !pane.height) return '50% 35%';
  const x = Math.max(0, Math.min(100, ((rect.x + rect.width / 2 - pane.x) / pane.width) * 100));
  const y = Math.max(0, Math.min(100, ((rect.y + rect.height / 2 - pane.y) / pane.height) * 100));
  return `${x}% ${y}%`;
}
export const orderDirection = (from: number | string, to: number | string): 1 | -1 =>
  to >= from ? 1 : -1;
export const menuIntent = (from: number, to: number): MotionIntent => ({
  axis: 'y',
  direction: orderDirection(from, to),
});
export const dateIntent = (from: string, to: string): MotionIntent => ({
  axis: 'x',
  direction: orderDirection(from, to),
});
