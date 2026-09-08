import React, { useEffect, useState } from 'react';

/**
 * Заглушка на время загрузки раздела.
 *
 * Три состояния вместо одного «Загрузка…»:
 *
 * 1. Первые доли секунды — НИЧЕГО. Раздел обычно приезжает мгновенно, и
 *    мелькнувшая надпись читается как рывок, а не как забота.
 * 2. Дальше — «Загрузка…».
 * 3. Если затянулось — прямо говорим, что это дольше обычного. Молчаливый
 *    бесконечный «Загрузка…» неотличим от зависшего приложения, а на плохой
 *    связи это самый частый случай.
 */
const SHOW_AFTER_MS = 250;
const SLOW_AFTER_MS = 6000;

const SectionLoading: React.FC = () => {
  const [phase, setPhase] = useState<'hidden' | 'loading' | 'slow'>('hidden');

  useEffect(() => {
    const show = setTimeout(() => setPhase('loading'), SHOW_AFTER_MS);
    const slow = setTimeout(() => setPhase('slow'), SLOW_AFTER_MS);
    return () => { clearTimeout(show); clearTimeout(slow); };
  }, []);

  if (phase === 'hidden') return <div className="section-loading" />;

  return (
    <div className="section-loading" role="status" aria-live="polite">
      {phase === 'slow'
        ? 'Загружается дольше обычного — похоже, связь слабая. Подождите или обновите страницу.'
        : 'Загрузка…'}
    </div>
  );
};

export default SectionLoading;
