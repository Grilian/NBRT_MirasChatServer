// Оверлей на значке в панели задач Windows с ЧИСЛОМ непрочитанных.
//
// Раньше main-процесс клал туда заранее нарисованную красную точку: она
// сообщала «что-то есть», но не сколько. Нарисовать цифру в main нечем —
// canvas там нет, а тащить графическую библиотеку в собранное приложение ради
// кружка с числом не стоит. Зато canvas есть здесь, в рендерере: рисуем и
// отдаём готовый PNG строкой, main только превращает её в nativeImage.

const SIZE = 32; // Windows масштабирует оверлей сам, 32px хватает с запасом

/** Красный кружок с числом. Больше 99 показываем как «99+». */
export function renderUnreadBadge(count: number): string | null {
  if (count <= 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.beginPath();
  ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
  ctx.fillStyle = '#e5484d';
  ctx.fill();

  const label = count > 99 ? '99+' : String(count);
  // Трёхзначная подпись в кружок такого размера влезает только уже — поэтому
  // размер шрифта зависит от длины, а не фиксирован.
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${label.length > 2 ? 14 : 19}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, SIZE / 2, SIZE / 2 + 1);

  return canvas.toDataURL('image/png');
}
