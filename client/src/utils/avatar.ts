const PALETTE = ['#7a8f6e', '#b58f1f', '#8f6b52', '#5f8f8a', '#8a6f8f', '#6e7a8f'];

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
