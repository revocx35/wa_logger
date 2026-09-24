import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, RouterProvider, createBrowserRouter, useLocation } from 'react-router';
import type { AppState } from '../../shared/api';
import { Icon } from './components/Icon';
import { Spinner } from './components/ui';
import { LoginPage, RecoverPage, SetupRecoveryPage, SignupPage } from './pages/Auth';
import { MainLayout } from './pages/MainLayout';
import { ChatsPage, DeletedPage, NotFoundPage, SearchPage, WaWebPage } from './pages/Pages';
import { SettingsPage } from './pages/Settings';
import { SetupLinkPage } from './pages/SetupLink';
import { AppStateProvider, useAppState } from './state/AppState';
import './styles.css';

const PUBLIC_WHEN_LOGGED_OUT = ['/login', '/recover'];
const AUTH_PAGES = ['/signup', '/login', '/recover', '/setup/link'];

/** Where the current user belongs; null = stay on this path. */
export function routeFor(s: AppState, path: string, pendingRecoveryKey: boolean): string | null {
  if (!s.hasOwner) return path === '/signup' ? null : '/signup';
  if (!s.authenticated) return PUBLIC_WHEN_LOGGED_OUT.includes(path) ? null : '/login';
  if (pendingRecoveryKey) return path === '/setup/recovery' ? null : '/setup/recovery';
  if (!s.onboardingComplete) return path === '/setup/link' || path === '/setup/recovery' ? null : '/setup/link';
  if (AUTH_PAGES.includes(path)) return '/';
  return null;
}

function Root() {
  const { state, loading, pendingRecoveryKey, refresh } = useAppState();
  const location = useLocation();
  if (loading && !state) {
    return (
      <div className="fullscreen-center">
        <Spinner size={32} />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="fullscreen-center">
        <Icon name="warning" size={40} />
        <p>Cannot reach the wa_logger server.</p>
        <button className="btn" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }
  const target = routeFor(state, location.pathname, !!pendingRecoveryKey);
  if (target && target !== location.pathname) return <Navigate to={target} replace />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { path: '/signup', element: <SignupPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/recover', element: <RecoverPage /> },
      { path: '/setup/recovery', element: <SetupRecoveryPage /> },
      { path: '/setup/link', element: <SetupLinkPage /> },
      {
        element: <MainLayout />,
        children: [
          { path: '/', element: <ChatsPage /> },
          { path: '/chat/:chatId', element: <ChatsPage /> },
          { path: '/deleted', element: <DeletedPage /> },
          { path: '/search', element: <SearchPage /> },
          { path: '/wa-web', element: <WaWebPage /> },
          { path: '/settings', element: <SettingsPage /> },
          { path: '*', element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppStateProvider>
      <RouterProvider router={router} />
    </AppStateProvider>
  </StrictMode>,
);
