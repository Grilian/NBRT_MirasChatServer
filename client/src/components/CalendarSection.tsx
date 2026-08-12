import React from 'react';
import CalendarWidget from '../calendar/CalendarWidget';
import { SectionMeta } from './NavRail';

interface CalendarSectionProps {
  section: SectionMeta;
  onBack: () => void;
  /** Растёт по сокет-событию calendar_changed — см. Chat.tsx. */
  changeToken?: number;
}

// Раздел — тонкая обёртка над виджетом: вся работа календаря живёт в
// client/src/calendar/ и не зависит от того, откуда его открыли.
//
// scope намеренно не задан: в разделе календарь показывает объединение всех
// доступных слоёв — общий, личный, дни рождения, а со временем и пространства.
// Ограничение одной областью нужно врезкам вроде списка событий в карточке
// пространства, а не полному календарю.
const CalendarSection: React.FC<CalendarSectionProps> = ({ onBack, changeToken }) => (
  <CalendarWidget onBack={onBack} changeToken={changeToken} />
);

export default CalendarSection;
