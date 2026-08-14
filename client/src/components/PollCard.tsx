import React, { useEffect, useMemo, useState } from 'react';
import Avatar from './Avatar';
import { Poll } from '../types/poll';
import { registerBackInterceptor } from '../utils/backInterceptors';

interface PollCardProps {
  poll: Poll;
  onVote: (pollId: number, optionIds: number[]) => void;
  onAddOption: (pollId: number, text: string) => void;
  selectionMode?: boolean;
}

function sameSelection(a: number[], b: number[]) {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every((id) => right.has(id));
}

function voterName(voter: { display_name?: string | null; username: string }) {
  return voter.display_name || voter.username;
}

const PollCard: React.FC<PollCardProps> = ({ poll, onVote, onAddOption, selectionMode = false }) => {
  const [selected, setSelected] = useState<number[]>(poll.user_option_ids || []);
  const [customOption, setCustomOption] = useState('');
  const [submittedOption, setSubmittedOption] = useState<string | null>(null);
  const [votersOpen, setVotersOpen] = useState(false);
  const [, setDeadlineTick] = useState(0);

  useEffect(() => setSelected(poll.user_option_ids || []), [poll.user_option_ids]);

  // Аппаратный Back закрывает список голосов, а не уводит с экрана из-под него
  // (общее правило для всех оверлеев, см. utils/backInterceptors).
  useEffect(() => {
    if (!votersOpen) return undefined;
    return registerBackInterceptor(() => setVotersOpen(false));
  }, [votersOpen]);

  useEffect(() => {
    if (!submittedOption) return;
    const normalized = submittedOption.toLocaleLowerCase('ru-RU');
    const wasAdded = poll.options.some((option) => option.text.toLocaleLowerCase('ru-RU') === normalized);
    if (!wasAdded) return;
    setCustomOption((current) => (
      current.trim().toLocaleLowerCase('ru-RU') === normalized ? '' : current
    ));
    setSubmittedOption(null);
  }, [poll.options, submittedOption]);

  useEffect(() => {
    if (!poll.closes_at || poll.closed_at) return;
    const refresh = () => setDeadlineTick((tick) => tick + 1);
    const delay = Math.max(0, poll.closes_at - Date.now());
    const timer = window.setTimeout(refresh, Math.min(delay + 50, 2147483647));
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [poll.closes_at, poll.closed_at]);

  const closed = !!poll.closed_at || (!!poll.closes_at && poll.closes_at <= Date.now());
  const locked = poll.has_voted && !poll.allow_change_vote;
  const showResults = poll.has_voted || closed;
  const selectionChanged = !sameSelection(selected, poll.user_option_ids || []);
  const canSubmit = !closed && !locked && selected.length > 0 && (!poll.has_voted || selectionChanged);
  const votersExist = poll.options.some((option) => option.voters && option.voters.length > 0);

  const deadlineLabel = useMemo(() => {
    if (!poll.closes_at) return null;
    return new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
    }).format(new Date(poll.closes_at));
  }, [poll.closes_at]);

  const toggle = (optionId: number) => {
    if (selectionMode || closed || locked) return;
    setSelected((current) => {
      if (!poll.multiple_choice) return [optionId];
      return current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId];
    });
  };

  const submitCustomOption = () => {
    if (selectionMode) return;
    const text = customOption.trim();
    if (!text || !poll.can_add_option || closed) return;
    onAddOption(poll.id, text);
    // Очищаем только после poll_updated с реально добавленным вариантом. При
    // дубле/лимите/обрыве сети введённый текст остаётся и не теряется.
    setSubmittedOption(text);
  };

  return (
    <div className={'poll-card' + (closed ? ' is-closed' : '')}>
      {poll.description && <div className="poll-description">{poll.description}</div>}
      <div className="poll-question">{poll.question}</div>
      <div className="poll-kind">
        {closed ? 'Опрос завершён' : poll.multiple_choice ? 'Опрос · несколько ответов' : 'Опрос'}
      </div>

      <div className="poll-options">
        {poll.options.map((option) => {
          const checked = selected.includes(option.id);
          return (
            <button
              type="button"
              key={option.id}
              className={'poll-option' + (checked ? ' is-selected' : '') + (option.is_winner ? ' is-winner' : '')}
              onClick={() => toggle(option.id)}
              disabled={closed || locked}
            >
              <span className={'poll-choice ' + (poll.multiple_choice ? 'is-multiple' : 'is-single')} aria-hidden="true">
                {checked && <svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>}
              </span>
              <span className="poll-option-content">
                <span className="poll-option-line">
                  {showResults && <strong>{option.percentage}%</strong>}
                  <span>{option.text}</span>
                  {showResults && <span className="poll-option-count">{option.vote_count}</span>}
                </span>
                {showResults && (
                  <span className="poll-progress"><span style={{ width: `${option.percentage}%` }} /></span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {poll.can_add_option && !closed && (
        <div className="poll-custom-option">
          <span className="poll-custom-plus">＋</span>
          <input
            value={customOption}
            maxLength={100}
            onChange={(event) => setCustomOption(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submitCustomOption(); } }}
            placeholder="Добавить свой вариант"
            aria-label="Добавить свой вариант"
          />
          <button type="button" onClick={submitCustomOption} disabled={!customOption.trim()} aria-label="Добавить вариант">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
      )}

      {!closed && !locked && (
        <button type="button" className="poll-submit" disabled={!canSubmit} onClick={() => { if (!selectionMode) onVote(poll.id, selected); }}>
          {poll.has_voted ? 'Изменить голос' : 'Проголосовать'}
        </button>
      )}

      {locked && <div className="poll-locked-hint">Ответ зафиксирован автором опроса</div>}
      {deadlineLabel && <div className="poll-deadline">{closed ? 'Завершён' : 'До'} {deadlineLabel}</div>}

      {showResults && (
        poll.show_voter_names && votersExist ? (
          <button type="button" className="poll-voters-open" onClick={() => { if (!selectionMode) setVotersOpen(true); }}>
            Посмотреть голоса ({poll.total_voters})
          </button>
        ) : (
          <div className="poll-total">{poll.total_voters} {poll.total_voters === 1 ? 'голос' : 'голосов'}</div>
        )
      )}

      {/* Список голосов лежит ВНУТРИ сообщения (PollCard рисуется в пузыре), и
          хотя сам он position: fixed поверх экрана, его события всплывают по
          дереву прямо в жесты строки .msg — тап по списку открывал контекстное
          меню сообщения ПОД ним, а удержание входило в режим выделения. Поэтому
          гасим здесь весь ввод целиком, а не только клик: всплытие идёт по
          React-дереву, и вынос в портал сам по себе от него не спасает. */}
      {votersOpen && (
        <div
          className="poll-voters-layer"
          onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) setVotersOpen(false); }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchEnd={(event) => event.stopPropagation()}
          onContextMenu={(event) => { event.stopPropagation(); event.preventDefault(); }}
        >
          <div className="poll-voters-sheet" role="dialog" aria-modal="true" aria-label="Голоса в опросе">
            <div className="poll-voters-head">
              <div><strong>{poll.question}</strong><span>{poll.total_voters} голосов</span></div>
              <button type="button" onClick={() => setVotersOpen(false)} aria-label="Закрыть">×</button>
            </div>
            <div className="poll-voters-list">
              {poll.options.filter((option) => option.voters?.length).map((option) => (
                <section key={option.id}>
                  <h4>{option.text} — {option.percentage}% <span>{option.vote_count}</span></h4>
                  {option.voters!.map((voter) => (
                    <div className="poll-voter" key={`${option.id}-${voter.id}`}>
                      <Avatar name={voterName(voter)} avatarPath={voter.avatar_path} size="sm" />
                      <span>{voterName(voter)}</span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PollCard;
