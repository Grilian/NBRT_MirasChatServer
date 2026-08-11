import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ImageLightboxProps {
  url: string;
  onClose: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 8;
// Во сколько раз увеличивает двойной тап/клик — промежуточная ступень, с
// которой удобно рассматривать детали и так же легко вернуться обратно.
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
// Сдвиг, после которого касание перестаёт считаться «кликом мимо картинки» и
// не закрывает просмотр: палец при перетаскивании всегда немного дрожит.
const DRAG_SLOP_PX = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Просмотр картинки во весь экран с увеличением: колесо на ПК, щипок на
 * телефоне, двойной тап/клик — переключение туда-обратно. Увеличенную картинку
 * можно таскать.
 *
 * Слушатели wheel и touchmove вешаются вручную и НЕ пассивными: React
 * регистрирует оба типа пассивно (17+), а из пассивного обработчика
 * preventDefault не работает вовсе — без него колесо прокручивало бы страницу
 * под просмотром, а щипок масштабировал бы саму страницу вместе с интерфейсом.
 */
const ImageLightbox: React.FC<ImageLightboxProps> = ({ url, onClose }) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // Жест читается и меняется внутри нативных обработчиков, поэтому живёт в
  // ref: состояние там было бы всегда на рендер устаревшим.
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pinch = useRef<{ distance: number; midX: number; midY: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; moved: boolean } | null>(null);
  const lastTap = useRef(0);

  const apply = useCallback((next: { scale: number; x: number; y: number }) => {
    const img = imgRef.current;
    const box = overlayRef.current;
    let { scale: s, x, y } = next;
    s = clamp(s, MIN_SCALE, MAX_SCALE);

    // На единичном масштабе картинка всегда по центру: иначе она «залипала»
    // сдвинутой после того, как её уменьшили обратно.
    if (s <= MIN_SCALE || !img || !box) {
      view.current = { scale: s, x: s <= MIN_SCALE ? 0 : x, y: s <= MIN_SCALE ? 0 : y };
    } else {
      // Дальше края таскать некуда — упираем, чтобы картинка не улетала за
      // пределы экрана и её не приходилось «искать» обратно.
      const limitX = Math.max(0, (img.offsetWidth * s - box.clientWidth) / 2);
      const limitY = Math.max(0, (img.offsetHeight * s - box.clientHeight) / 2);
      view.current = { scale: s, x: clamp(x, -limitX, limitX), y: clamp(y, -limitY, limitY) };
    }

    setScale(view.current.scale);
    setOffset({ x: view.current.x, y: view.current.y });
  }, []);

  // Масштабирование вокруг точки (курсора или середины щипка): точка картинки
  // под пальцем должна остаться на месте, иначе кадр уезжает и приходится
  // догонять его перетаскиванием.
  const zoomAt = useCallback((nextScale: number, pointX: number, pointY: number) => {
    const box = overlayRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const px = pointX - (rect.left + rect.width / 2);
    const py = pointY - (rect.top + rect.height / 2);

    const { scale: s, x, y } = view.current;
    const s2 = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    apply({ scale: s2, x: px - (s2 / s) * (px - x), y: py - (s2 / s) * (py - y) });
  }, [apply]);

  const toggleZoom = useCallback((pointX: number, pointY: number) => {
    zoomAt(view.current.scale > MIN_SCALE + 0.01 ? MIN_SCALE : DOUBLE_TAP_SCALE, pointX, pointY);
  }, [zoomAt]);

  const reset = useCallback(() => apply({ scale: 1, x: 0, y: 0 }), [apply]);

  useEffect(() => { reset(); }, [url, reset]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const box = overlayRef.current;
    if (!box) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Экспонента, а не сложение: шаг колеса должен менять масштаб на
      // постоянную долю, иначе вблизи минимума увеличение ползёт, а на
      // большом — прыгает.
      zoomAt(view.current.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    };

    const distanceOf = (t: TouchList) => Math.hypot(
      t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY,
    );

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        drag.current = null;
        pinch.current = {
          distance: distanceOf(e.touches),
          midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
          midY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
        return;
      }

      if (e.touches.length === 1) {
        pinch.current = null;
        const t = e.touches[0];
        drag.current = {
          startX: t.clientX, startY: t.clientY,
          baseX: view.current.x, baseY: view.current.y, moved: false,
        };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinch.current) {
        e.preventDefault();
        const distance = distanceOf(e.touches);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        if (pinch.current.distance > 0) {
          zoomAt(view.current.scale * (distance / pinch.current.distance), midX, midY);
        }
        pinch.current = { distance, midX, midY };
        return;
      }

      // Одним пальцем таскаем только увеличенную картинку: на единичном
      // масштабе двигать нечего, и жест должен остаться обычным касанием.
      const d = drag.current;
      if (!d || e.touches.length !== 1 || view.current.scale <= MIN_SCALE) return;
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - d.startX;
      const dy = t.clientY - d.startY;
      if (Math.abs(dx) > DRAG_SLOP_PX || Math.abs(dy) > DRAG_SLOP_PX) d.moved = true;
      apply({ scale: view.current.scale, x: d.baseX + dx, y: d.baseY + dy });
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) pinch.current = null;

      const d = drag.current;
      drag.current = null;
      if (!d || d.moved) return;

      // Двойной тап — та же ступень увеличения, что и двойной клик мышью.
      const now = Date.now();
      const t = e.changedTouches[0];
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        if (t) { e.preventDefault(); toggleZoom(t.clientX, t.clientY); }
        return;
      }
      lastTap.current = now;
    };

    box.addEventListener('wheel', onWheel, { passive: false });
    box.addEventListener('touchstart', onTouchStart, { passive: false });
    box.addEventListener('touchmove', onTouchMove, { passive: false });
    box.addEventListener('touchend', onTouchEnd, { passive: false });
    return () => {
      box.removeEventListener('wheel', onWheel);
      box.removeEventListener('touchstart', onTouchStart);
      box.removeEventListener('touchmove', onTouchMove);
      box.removeEventListener('touchend', onTouchEnd);
    };
  }, [apply, zoomAt, toggleZoom]);

  // Перетаскивание мышью — для увеличенной картинки на ПК.
  const onMouseDown = (e: React.MouseEvent) => {
    if (view.current.scale <= MIN_SCALE) return;
    e.preventDefault();
    const baseX = view.current.x;
    const baseY = view.current.y;
    const startX = e.clientX;
    const startY = e.clientY;

    const move = (ev: MouseEvent) => {
      apply({ scale: view.current.scale, x: baseX + (ev.clientX - startX), y: baseY + (ev.clientY - startY) });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const zoomed = scale > MIN_SCALE + 0.01;

  return (
    <div
      ref={overlayRef}
      className={'lightbox-overlay' + (zoomed ? ' is-zoomed' : '')}
      // Закрывает только клик мимо картинки. По самой картинке click не
      // всплывает (см. stopPropagation ниже), а перетаскивание клика вообще
      // не порождает.
      onClick={onClose}
    >
      <button
        type="button"
        className="lightbox-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        aria-label="Закрыть"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>

      {zoomed && (
        <button
          type="button"
          className="lightbox-reset"
          onClick={(e) => { e.stopPropagation(); reset(); }}
        >
          Сбросить масштаб
        </button>
      )}

      <img
        ref={imgRef}
        src={url}
        alt=""
        className="lightbox-img"
        draggable={false}
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => { e.stopPropagation(); toggleZoom(e.clientX, e.clientY); }}
        onMouseDown={onMouseDown}
      />
    </div>
  );
};

export default ImageLightbox;
