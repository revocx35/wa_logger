import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { WaStatePill } from '../components/ui';
import { useAppState } from '../state/AppState';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Chats', icon: 'chats', end: true },
  { to: '/deleted', label: 'Deleted', icon: 'deleted' },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/wa-web', label: 'WA Web', icon: 'monitor' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export function MainLayout() {
  const { wa, refresh } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const inChat = location.pathname.startsWith('/chat/');

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
      navigate('/login', { replace: true });
    }
  };

  const needsAttention = wa && (wa.state === 'disconnected' || wa.state === 'qr');

  return (
    <div className={inChat ? 'app-shell in-chat' : 'app-shell'}>
      <nav className="rail" aria-label="Main">
        <div className="rail-top">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => (isActive || (n.to === '/' && inChat) ? 'rail-item active' : 'rail-item')}
              title={n.label}
            >
              <Icon name={n.icon} size={22} />
              <span className="rail-label">{n.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="rail-bottom">
          <NavLink to="/wa-web" className="rail-status" title={wa?.detail ?? 'WhatsApp status'}>
            <WaStatePill status={wa} compact />
          </NavLink>
          <button className="rail-item" onClick={logout} title="Log out">
            <Icon name="logout" size={22} />
            <span className="rail-label">Log out</span>
          </button>
        </div>
      </nav>
      <main className="app-main">
        {needsAttention ? (
          <div className="banner warn">
            <Icon name="warning" size={18} />
            <span>
              WhatsApp is {wa.state === 'qr' ? 'not linked' : 'disconnected'} — new messages are not being logged.{' '}
              <NavLink to="/wa-web">Open WA Web</NavLink> to relink.
            </span>
          </div>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
