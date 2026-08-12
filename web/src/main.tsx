import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './styles.css';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { HistoryPage } from './pages/HistoryPage';
import { JobsPage } from './pages/JobsPage';
import { JqlPage } from './pages/JqlPage';
import { MemoryPage } from './pages/MemoryPage';
import { ReposPage } from './pages/ReposPage';
import { ResultsPage } from './pages/ResultsPage';
import { SettingsPage } from './pages/SettingsPage';

const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'jql', element: <JqlPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'repos', element: <ReposPage /> },
      { path: 'jobs', element: <JobsPage /> },
      { path: 'issue/:issueKey/:repoId', element: <ResultsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
