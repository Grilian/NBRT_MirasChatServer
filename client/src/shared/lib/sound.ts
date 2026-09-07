// Звук уведомления синтезируем через WebAudio, а не грузим mp3: файл пришлось
// бы класть в public/ и тащить в три сборки (веб, Electron, Capacitor), причём
// в Electron рендерер работает с file://, где относительные пути к статике
// ведут себя иначе. Короткая двухнотная трель кодом — ноль ассетов и
// одинаковое поведение везде.

let audioContext: AudioContext | null = null;
let unlocked = false;

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function getContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
    return audioContext;
  } catch {
    return null;
  }
}

// Браузер не даёт проигрывать звук до первого действия пользователя: контекст
// создаётся в состоянии 'suspended' и молча глотает всё, что в него пишут.
// Ловим первый же клик/нажатие клавиши и «размораживаем» контекст, иначе
// первое (а иногда и все последующие) уведомление приходит беззвучно.
export function primeNotificationSound(): void {
  if (unlocked) return;

  const unlock = () => {
    unlocked = true;
    const ctx = getContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };

  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

function playTone(ctx: AudioContext, frequency: number, startAt: number, duration: number, peakGain: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startAt);

  // Мгновенный старт/стоп синуса даёт щелчок — поэтому короткая атака и
  // экспоненциальное затухание.
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

/** Мягкий сигнал о входящем сообщении. */
export function playIncomingSound(): void {
  const ctx = getContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  try {
    const now = ctx.currentTime;
    playTone(ctx, 880, now, 0.12, 0.09);
    playTone(ctx, 1174.7, now + 0.09, 0.16, 0.07);
  } catch {
    // звук — не критичная функция, молча пропускаем
  }
}
