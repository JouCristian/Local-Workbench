import { z } from 'zod';

export const accents = [
  { id: 'blue', label: '雾蓝' },
  { id: 'teal', label: '青绿' },
  { id: 'green', label: '森林' },
  { id: 'violet', label: '紫罗兰' },
  { id: 'rose', label: '玫瑰' },
  { id: 'amber', label: '琥珀' },
  { id: 'graphite', label: '石墨' },
] as const;
export type Accent = (typeof accents)[number]['id'];
export const accentSchema = z.enum([
  'blue',
  'teal',
  'green',
  'violet',
  'rose',
  'amber',
  'graphite',
]);
export const layoutSchema = z.object({
  columns: z.number().min(0.32).max(0.72),
  rows: z.number().min(0.4).max(0.82),
});
export type DashboardLayout = z.infer<typeof layoutSchema>;
export const defaultLayout: DashboardLayout = { columns: 0.6, rows: 0.72 };
export function readLayout(value: string | undefined): DashboardLayout {
  try {
    return layoutSchema.parse(JSON.parse(value ?? ''));
  } catch {
    return { ...defaultLayout };
  }
}
export const clampSplit = (value: number, axis: 'columns' | 'rows') =>
  Math.max(axis === 'columns' ? 0.32 : 0.4, Math.min(axis === 'columns' ? 0.72 : 0.82, value));
