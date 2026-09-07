// Цвета подложки под БЕЛЫЕ инициалы, поэтому каждый доведён до 4.5:1 с белым.
// Замерено 07.09.2026: у четырёх из шести прежних значений контраст был 3.0–4.4,
// то есть инициалы читались хуже нормы. Оттенки сохранены, изменена яркость.
const PALETTE = ['#687a5f', '#907119', '#8f6b52', '#537c77', '#876c8c', '#6a758a'];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

export function initialsForName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const second = parts.length > 1 ? (parts[1][0] || '') : '';
  return (first + second).toUpperCase();
}
