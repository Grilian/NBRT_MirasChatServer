import React from 'react';

/**
 * Что делать, когда кусок приложения не загрузился.
 *
 * Разделы грузятся отдельными файлами по первому открытию (волна 9). Имена
 * этих файлов содержат хэш содержимого, и при выкладке старые исчезают. Значит
 * у человека, державшего вкладку открытой во время обновления, переход в
 * раздел упирается в файл, которого больше нет: nginx отдаёт на его месте
 * index.html, браузер отказывается считать HTML модулем — и экран становится
 * ПУСТЫМ, без единого слова. Поймано на живой выкладке 08.09.2026.
 *
 * Перезагрузка страницы лечит это полностью, но догадаться до неё человек не
 * может. Здесь мы это и говорим.
 *
 * Сама по себе граница — не замена аккуратной выкладке: старые куски теперь
 * не удаляются сразу (см. docs/DEPLOY.md). Она нужна для окна, когда
 * несовпадение всё-таки случилось: сеть отвалилась на середине, файл вычистили
 * позже, кэш отдал обрывок.
 */
interface Props {
  children: React.ReactNode;
}

interface State {
  failed: boolean;
  /** Отдельно: не загрузился КУСОК или упало само приложение. */
  stale: boolean;
}

/** Похоже ли на «файл раздела не доехал». */
function looksLikeChunkFailure(error: unknown): boolean {
  const text = String((error as Error)?.message || error || '');
  return /dynamically imported module|Loading chunk|Importing a module script failed|MIME type/i.test(text);
}

class ChunkBoundary extends React.Component<Props, State> {
  state: State = { failed: false, stale: false };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, stale: looksLikeChunkFailure(error) };
  }

  componentDidCatch(error: unknown): void {
    // В консоль — целиком: пустой экран без следа не разобрать потом никак.
    console.error('[раздел не загрузился]', error);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="chunk-failure" role="alert">
        <h1 className="chunk-failure-title">
          {this.state.stale ? 'Приложение обновилось' : 'Что-то пошло не так'}
        </h1>
        <p className="chunk-failure-note">
          {this.state.stale
            ? 'Пока эта страница была открыта, вышло обновление. Обновите страницу — всё вернётся на место, ничего не потеряно.'
            : 'Раздел не открылся. Обновите страницу; если повторится — сообщите администратору.'}
        </p>
        <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
          Обновить страницу
        </button>
      </div>
    );
  }
}

export default ChunkBoundary;
