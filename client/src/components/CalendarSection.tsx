import React from 'react';
import CalendarWidget from '../calendar/CalendarWidget';
import { SectionMeta } from './NavRail';

interface CalendarSectionProps {
  section: SectionMeta;
  onBack: () => void;
}

// Раздел — тонкая обёртка над виджетом: вся работа календаря живёт в
// client/src/calendar/ и не зависит от того, откуда его открыли. Когда
// появятся пространства, тот же виджет встанет туда со scope пространства,
// а этот файл останется без изменений.
const CalendarSection: React.FC<CalendarSectionProps> = ({ onBack }) => (
  <CalendarWidget scope={{ kind: 'personal' }} onBack={onBack} />
);

export default CalendarSection;
