import React, { useMemo, useRef, useState } from 'react';
import { PollDraft } from '../types/poll';

interface PollCreatorProps {
  onClose: () => void;
  onCreate: (draft: PollDraft) => void;
  submitting?: boolean;
}

const MAX_OPTIONS = 12;

interface SettingProps {
  tone: string;
  icon: React.ReactNode;
  title: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children?: React.ReactNode;
}

function PollSetting({ tone, icon, title, hint, checked, onChange, children }: SettingProps) {
  return (
    <div className="poll-setting-wrap">
      <label className="poll-setting">
        <span className={`poll-setting-icon ${tone}`}>{icon}</span>
        <span className="poll-setting-copy">
          <span className="poll-setting-title">{title}</span>
          <span className="poll-setting-hint">{hint}</span>
        </span>
        <span className="switch poll-setting-switch">
          <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
          <span className="switch-track"><span className="switch-thumb" /></span>
        </span>
      </label>
      {checked && children}
    </div>
  );
}

const PollCreator: React.FC<PollCreatorProps> = ({ onClose, onCreate, submitting = false }) => {
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [showVoterNames, setShowVoterNames] = useState(true);
  const [multipleChoice, setMultipleChoice] = useState(false);
  const [allowAddOptions, setAllowAddOptions] = useState(false);
  const [allowChangeVote, setAllowChangeVote] = useState(true);
  const [limited, setLimited] = useState(false);
  const [durationMinutes, setDurationMinutes] = useState(24 * 60);
  const optionRefs = useRef<Array<HTMLInputElement | null>>([]);

  const cleanOptions = useMemo(() => options.map((option) => option.trim()).filter(Boolean), [options]);
  const duplicateOptions = useMemo(() => {
    const normalized = cleanOptions.map((option) => option.toLocaleLowerCase('ru-RU'));
    return new Set(normalized).size !== normalized.length;
  }, [cleanOptions]);
  const canCreate = !!question.trim() && cleanOptions.length >= 2 && !duplicateOptions;

  const updateOption = (index: number, value: string) => {
    setOptions((current) => current.map((option, i) => (i === index ? value.slice(0, 100) : option)));
  };

  const addOption = () => {
    if (options.length >= MAX_OPTIONS) return;
    setOptions((current) => [...current, '']);
    requestAnimationFrame(() => optionRefs.current[options.length]?.focus());
  };

  const removeOption = (index: number) => {
    if (options.length <= 2) return;
    setOptions((current) => current.filter((_, i) => i !== index));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate || submitting) return;
    onCreate({
      question: question.trim(),
      description: description.trim() || undefined,
      options: cleanOptions,
      showVoterNames,
      multipleChoice,
      allowAddOptions,
      allowChangeVote,
      closesAt: limited ? Date.now() + durationMinutes * 60 * 1000 : null,
    });
  };

  return (
    <div className="poll-creator-layer" role="dialog" aria-modal="true" aria-label="Новый опрос" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="poll-creator" onSubmit={submit}>
        <header className="poll-creator-head">
          <button type="button" className="poll-creator-back" onClick={onClose} aria-label="Закрыть" disabled={submitting}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <h2>Новый опрос</h2>
          <button type="submit" className="poll-create-btn" disabled={!canCreate || submitting}>{submitting ? 'Создание…' : 'Создать'}</button>
        </header>

        <div className="poll-creator-scroll">
          <section className="poll-editor-card">
            <div className="poll-editor-label">Вопрос</div>
            <textarea
              autoFocus
              rows={2}
              maxLength={300}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Текст вопроса"
            />
            <textarea
              rows={2}
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Описание (необязательно)"
            />
          </section>

          <section className="poll-editor-card poll-options-editor">
            <div className="poll-editor-label">Варианты ответа</div>
            {options.map((option, index) => (
              <div className="poll-option-editor" key={index}>
                <span className="poll-option-grip" aria-hidden="true">≡</span>
                <input
                  ref={(element) => { optionRefs.current[index] = element; }}
                  value={option}
                  maxLength={100}
                  onChange={(event) => updateOption(index, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && index === options.length - 1 && options.length < MAX_OPTIONS) {
                      event.preventDefault();
                      addOption();
                    }
                  }}
                  placeholder={`Ответ ${index + 1}`}
                />
                {options.length > 2 && (
                  <button type="button" className="poll-option-remove" onClick={() => removeOption(index)} aria-label="Удалить вариант">×</button>
                )}
              </div>
            ))}
            {options.length < MAX_OPTIONS && (
              <button type="button" className="poll-add-option-editor" onClick={addOption}>
                <span>＋</span> Добавить ответ…
              </button>
            )}
          </section>
          <div className="poll-option-limit">
            {options.length < MAX_OPTIONS
              ? `Можно добавить ещё ${MAX_OPTIONS - options.length} вариантов ответа.`
              : 'Достигнут максимум — 12 вариантов ответа.'}
          </div>
          {duplicateOptions && <div className="poll-editor-error">Варианты ответа не должны повторяться.</div>}

          <section className="poll-settings-card">
            <div className="poll-editor-label">Настройки</div>
            <PollSetting
              tone="cyan"
              icon={<svg viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>}
              title="Имена участников"
              hint="Показывать имена рядом с выбранными ответами"
              checked={showVoterNames}
              onChange={setShowVoterNames}
            />
            <PollSetting
              tone="orange"
              icon={<svg viewBox="0 0 24 24"><path d="m4 7 2 2 4-4M13 7h7M4 16l2 2 4-4M13 16h7" /></svg>}
              title="Несколько ответов"
              hint="Можно выбрать больше одного варианта"
              checked={multipleChoice}
              onChange={setMultipleChoice}
            />
            <PollSetting
              tone="green"
              icon={<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /><circle cx="12" cy="12" r="9" /></svg>}
              title="Добавление вариантов"
              hint="Участники смогут предложить свой вариант"
              checked={allowAddOptions}
              onChange={setAllowAddOptions}
            />
            <PollSetting
              tone="purple"
              icon={<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M7 7a7 7 0 0 1 11 2M17 17A7 7 0 0 1 6 15" /></svg>}
              title="Изменение ответа"
              hint="Участники смогут изменить свой выбор"
              checked={allowChangeVote}
              onChange={setAllowChangeVote}
            />
            <PollSetting
              tone="red"
              icon={<svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l3 2M9 2h6" /></svg>}
              title="Ограничение срока"
              hint="Опрос автоматически завершится в заданное время"
              checked={limited}
              onChange={setLimited}
            >
              <select className="poll-duration" value={durationMinutes} onChange={(event) => setDurationMinutes(Number(event.target.value))}>
                <option value={60}>Через 1 час</option>
                <option value={8 * 60}>Через 8 часов</option>
                <option value={24 * 60}>Через 1 день</option>
                <option value={3 * 24 * 60}>Через 3 дня</option>
                <option value={7 * 24 * 60}>Через 7 дней</option>
              </select>
            </PollSetting>
          </section>
        </div>
      </form>
    </div>
  );
};

export default PollCreator;
