/**
 * Profile page: shows the signed-in account, lets the user update email /
 * display name (PATCH /users/me), and change the password (POST /auth/password
 * with a client-side confirmation check before hitting the server).
 */
import { useState } from 'react';

import { api, ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const inputClass =
  'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500';
const labelClass = 'block text-xs font-medium text-slate-400';
const buttonClass =
  'rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-50';

function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'request failed';
}

export function ProfilePage(): React.JSX.Element {
  const { user, refresh } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordMsg, setPasswordMsg] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  if (!user) {
    return <div className="text-sm text-slate-400">No active session.</div>;
  }

  async function saveProfile(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMsg(null);
    setProfileError(null);
    try {
      const patch: { email?: string; displayName?: string } = {};
      if (email !== user?.email) patch.email = email;
      if (displayName !== user?.displayName) patch.displayName = displayName;
      if (Object.keys(patch).length === 0) {
        setProfileMsg('Nothing to update.');
        return;
      }
      await api.updateProfile(patch);
      await refresh();
      setProfileMsg('Profile updated.');
    } catch (err) {
      setProfileError(errorText(err));
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match.');
      return;
    }
    setSavingPassword(true);
    setPasswordError(null);
    setPasswordMsg(null);
    try {
      await api.changePassword({ currentPassword, newPassword });
      setPasswordMsg('Password changed. Use the new password at your next login.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPasswordError(errorText(err));
    } finally {
      setSavingPassword(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-cyan-500/15 text-xl font-bold text-cyan-300">
            {user.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-100">{user.displayName}</h2>
            <p className="text-sm text-slate-400">{user.email}</p>
          </div>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className={labelClass}>Username</dt>
            <dd className="mt-0.5 text-slate-200">{user.username}</dd>
          </div>
          <div>
            <dt className={labelClass}>Role</dt>
            <dd className="mt-0.5 text-slate-200">{user.role}</dd>
          </div>
          <div>
            <dt className={labelClass}>Status</dt>
            <dd className="mt-0.5 text-slate-200">{user.active ? 'active' : 'disabled'}</dd>
          </div>
          <div>
            <dt className={labelClass}>Member since</dt>
            <dd className="mt-0.5 text-slate-200">{user.createdAt.slice(0, 10)}</dd>
          </div>
        </dl>
      </div>

      <form
        onSubmit={(e) => void saveProfile(e)}
        className="rounded-xl border border-slate-800 bg-slate-900 p-6"
      >
        <h3 className="text-sm font-medium text-slate-300">Profile details</h3>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="profile-email" className={labelClass}>
              Email
            </label>
            <input
              id="profile-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${inputClass} mt-1`}
            />
          </div>
          <div>
            <label htmlFor="profile-display-name" className={labelClass}>
              Display name
            </label>
            <input
              id="profile-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={`${inputClass} mt-1`}
            />
          </div>
        </div>
        {profileMsg && <p className="mt-3 text-xs text-emerald-400">{profileMsg}</p>}
        {profileError && (
          <div role="alert" className="mt-3 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-300">
            {profileError}
          </div>
        )}
        <button
          type="submit"
          disabled={savingProfile}
          className={`${buttonClass} mt-4`}
        >
          {savingProfile ? 'Saving…' : 'Save profile'}
        </button>
      </form>

      <form
        onSubmit={(e) => void changePassword(e)}
        className="rounded-xl border border-slate-800 bg-slate-900 p-6"
      >
        <h3 className="text-sm font-medium text-slate-300">Change password</h3>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label htmlFor="current-password" className={labelClass}>
              Current password
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={`${inputClass} mt-1`}
            />
          </div>
          <div>
            <label htmlFor="new-password" className={labelClass}>
              New password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={`${inputClass} mt-1`}
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className={labelClass}>
              Confirm new password
            </label>
            <input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={`${inputClass} mt-1`}
            />
          </div>
        </div>
        {passwordMsg && <p className="mt-3 text-xs text-emerald-400">{passwordMsg}</p>}
        {passwordError && (
          <div role="alert" className="mt-3 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-300">
            {passwordError}
          </div>
        )}
        <button
          type="submit"
          disabled={savingPassword || !currentPassword || newPassword.length < 8}
          className={`${buttonClass} mt-4`}
        >
          {savingPassword ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}
