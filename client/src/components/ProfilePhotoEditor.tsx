import React, { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  file: File;
  displayName: string;
  username: string;
  onCancel: () => void;
  onApply: (file: File) => void;
}

// Профиль у нас вертикальный. Итоговый файл всегда готовим в тех же 3:4,
// чтобы один и тот же снимок предсказуемо работал и hero-фоном профиля,
// и источником для круглого аватара (там браузер берёт центральный квадрат).
const OUT_W = 1200;
const OUT_H = 1600;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3;
const ZOOM_STEP = 0.1;

const ProfilePhotoEditor: React.FC<Props> = ({ file, displayName, username, onCancel, onApply }) => {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [flipX, setFlipX] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const rotated = rotation % 180 !== 0;
  const rotatedW = rotated ? size.h : size.w;
  const rotatedH = rotated ? size.w : size.h;
  const baseScale = Math.max(OUT_W / rotatedW, OUT_H / rotatedH);
  const scale = baseScale * zoom;

  const clamp = (x: number, y: number, nextZoom = zoom) => {
    const nextScale = baseScale * nextZoom;
    const renderedW = rotatedW * nextScale;
    const renderedH = rotatedH * nextScale;
    const maxX = Math.max(0, (renderedW - OUT_W) / 2);
    const maxY = Math.max(0, (renderedH - OUT_H) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  };

  useEffect(() => {
    setOffset((current) => clamp(current.x, current.y));
    // baseScale/rotated dimensions уже изменились вместе с rotation/size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotation, size.w, size.h]);

  const reset = () => {
    setZoom(1);
    setRotation(0);
    setFlipX(false);
    setOffset({ x: 0, y: 0 });
  };

  const rotateLeft = () => {
    setRotation((value) => (value + 270) % 360);
    setOffset({ x: 0, y: 0 });
  };

  const changeZoom = (value: number) => {
    const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    setZoom(nextZoom);
    setOffset((current) => clamp(current.x, current.y, nextZoom));
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const element = previewRef.current;
    if (!element) return;
    element.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag.current || !previewRef.current) return;
    const rect = previewRef.current.getBoundingClientRect();
    // Координаты состояния хранятся в пикселях итогового 1200×1600 кадра.
    // Отдельные коэффициенты X/Y не дают накопиться искажению от округления CSS.
    const ratioX = OUT_W / rect.width;
    const ratioY = OUT_H / rect.height;
    const nextX = drag.current.ox + (event.clientX - drag.current.x) * ratioX;
    const nextY = drag.current.oy + (event.clientY - drag.current.y) * ratioY;
    setOffset(clamp(nextX, nextY));
  };

  const endDrag = () => { drag.current = null; };

  const apply = async () => {
    setBusy(true);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();

      const canvas = document.createElement('canvas');
      canvas.width = OUT_W;
      canvas.height = OUT_H;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas недоступен');

      // Не растягиваем исходник под 3:4: сначала считаем cover-scale, затем
      // рисуем изображение с одинаковым коэффициентом по обеим осям.
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#10161d';
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      ctx.translate(OUT_W / 2 + offset.x, OUT_H / 2 + offset.y);
      ctx.rotate(rotation * Math.PI / 180);
      ctx.scale(flipX ? -scale : scale, scale);
      ctx.drawImage(image, -size.w / 2, -size.h / 2, size.w, size.h);

      // Формат намеренно меняется: сервер получает уже подготовленный JPEG,
      // а не исходный PNG/WebP/HEIC-подобный файл с телефона.
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => result ? resolve(result) : reject(new Error('Не удалось подготовить фото')),
          'image/jpeg',
          0.9,
        );
      });
      const base = file.name.replace(/\.[^.]+$/, '') || 'profile';
      onApply(new File([blob], `${base}-profile.jpg`, { type: 'image/jpeg' }));
    } finally {
      setBusy(false);
    }
  };

  // ВАЖНО: проценты считаются относительно кадра 3:4. Ширина и высота
  // вычисляются независимо через OUT_W/OUT_H, но scale у них общий — поэтому
  // квадратный исходник остаётся квадратным и в редакторе, и после сохранения.
  const imageStyle: React.CSSProperties = {
    width: `${(size.w * scale / OUT_W) * 100}%`,
    height: `${(size.h * scale / OUT_H) * 100}%`,
    maxWidth: 'none',
    maxHeight: 'none',
    left: `${50 + (offset.x / OUT_W) * 100}%`,
    top: `${50 + (offset.y / OUT_H) * 100}%`,
    transform: `translate(-50%, -50%) rotate(${rotation}deg) scaleX(${flipX ? -1 : 1})`,
  };

  const name = displayName || username;
  const stopPointer = (event: React.PointerEvent) => event.stopPropagation();

  return (
    <div className="photo-editor-backdrop" role="dialog" aria-modal="true" aria-label="Редактор фото профиля">
      <div className="photo-editor-modal">
        <div className="photo-editor-head">
          <div className="photo-editor-head-copy">
            <h2>Настройте положение фото</h2>
            <p>Перемещайте и масштабируйте фотографию. Так она будет выглядеть в профиле и аватаре.</p>
          </div>
          <button type="button" className="photo-editor-close" onClick={onCancel} aria-label="Закрыть">×</button>
        </div>

        <div className="photo-editor-workspace">
          <div
            ref={previewRef}
            className="photo-editor-preview"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={(event) => {
              event.preventDefault();
              changeZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
            }}
          >
            <img
              src={url}
              alt=""
              draggable={false}
              onLoad={(event) => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
              style={imageStyle}
            />

            <div className="photo-editor-fade" />
            {/* Центральный квадрат именно отсюда превращается в круглый Avatar
                с object-fit: cover. Круг не меняет crop, а показывает его. */}
            <div className="photo-editor-avatar-guide" aria-hidden="true" />

            <div className="photo-editor-profile-sample" aria-hidden="true">
              <strong>{name}</strong>
              <span><i /> в сети</span>
            </div>

            <div className="photo-editor-overlay-controls" onPointerDown={stopPointer}>
              <div className="photo-editor-zoom-control" aria-label="Масштаб фотографии">
                <button type="button" onClick={() => changeZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label="Уменьшить">−</button>
                <span>{Math.round(zoom * 100)}%</span>
                <button type="button" onClick={() => changeZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label="Увеличить">+</button>
              </div>
              <div className="photo-editor-tool-group">
                <button type="button" onClick={rotateLeft} title="Повернуть на 90° против часовой стрелки" aria-label="Повернуть на 90° против часовой стрелки">↶</button>
                <button type="button" className={flipX ? 'is-active' : ''} onClick={() => setFlipX((value) => !value)} title="Отразить по вертикали" aria-label="Отразить по вертикали">↔</button>
                <button type="button" onClick={reset} title="Вернуть исходное положение" aria-label="Сбросить">⛶</button>
              </div>
            </div>
          </div>

          <div className="photo-editor-preview-section">
            <div className="photo-editor-preview-title">Предпросмотр</div>
            <div className="photo-editor-mini-previews">
              <div className="photo-editor-mini-card">
                <div className="photo-editor-mini-circle" aria-hidden="true">
                  <div className="photo-editor-mini-circle-frame">
                    <img src={url} alt="" style={imageStyle} />
                  </div>
                </div>
                <div><strong>Круглый аватар</strong><span>Списки и сообщения</span></div>
              </div>

              <div className="photo-editor-mini-card">
                <div className="photo-editor-mini-profile" aria-hidden="true">
                  <img src={url} alt="" style={imageStyle} />
                  <div className="photo-editor-mini-profile-fade" />
                  <b>{name}</b>
                </div>
                <div><strong>Полный профиль</strong><span>Вертикальный 3:4</span></div>
              </div>
            </div>
          </div>
        </div>

        <div className="photo-editor-footer">
          <button type="button" className="btn-secondary" onClick={onCancel}>Отмена</button>
          <button type="button" className="btn-primary" disabled={busy || size.w <= 1} onClick={apply}>
            {busy ? 'Подготовка…' : 'Сохранить фото'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ProfilePhotoEditor;
