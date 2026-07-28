import React from 'react';
import { SectionMeta } from './NavRail';

interface CalendarSectionProps {
  section: SectionMeta;
  onBack: () => void;
}

// У календаря свой экран, а не общая заглушка SectionStub: работа над ним уже
// идёт, и сотруднику это стоит показать. С «В разработке» на всех разделах
// сразу непонятно, где действительно что-то происходит, а где пункт стоит на
// рельсе просто на будущее.
const CalendarSection: React.FC<CalendarSectionProps> = ({ section, onBack }) => (
  <div className="section-stub">
    <div className="section-stub-card">
      <div className="section-stub-icon">{section.icon}</div>
      <div className="section-stub-title">{section.label}</div>
      <div className="section-stub-tag is-started">Разработка начата</div>
      <p className="section-stub-text">{section.summary}</p>
      <button type="button" className="btn-primary section-stub-back" onClick={onBack}>
        Вернуться к чатам
      </button>
    </div>
  </div>
);

export default CalendarSection;
