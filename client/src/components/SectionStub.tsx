import React from 'react';
import { SectionMeta } from './NavRail';

interface SectionStubProps {
  section: SectionMeta;
  onBack: () => void;
}

// Заглушка раздела, который уже есть на рельсе, но ещё не реализован.
// Показывает, чем раздел станет, чтобы пустой экран читался как «скоро», а не
// как поломка.
const SectionStub: React.FC<SectionStubProps> = ({ section, onBack }) => (
  <div className="section-stub">
    <div className="section-stub-card">
      <div className="section-stub-icon">{section.icon}</div>
      <div className="section-stub-title">{section.label}</div>
      <div className="section-stub-tag">В разработке</div>
      <p className="section-stub-text">{section.summary}</p>
      <button type="button" className="btn-primary section-stub-back" onClick={onBack}>
        Вернуться к чатам
      </button>
    </div>
  </div>
);

export default SectionStub;
