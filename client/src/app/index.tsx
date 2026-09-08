import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import '@/shared/styles/index.css';
import App from './App';
import { applyThemePreference, getThemePreference } from '@/shared/lib/theme';
import { applyUnreadBadgeColor, getUnreadBadgeColor } from '@/shared/lib/unreadBadge';

applyThemePreference(getThemePreference());
applyUnreadBadgeColor(getUnreadBadgeColor());

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);