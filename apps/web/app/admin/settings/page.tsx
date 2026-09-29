'use client';

import { AttachmentSettings } from '../../../components/admin/attachment-settings';
import { useAdminSession } from '../../../components/admin/admin-shell';
import { AccountSettings } from '../../../components/account-settings';

export default function AdminSettingsPage() {
  const { user, passwordReset } = useAdminSession();
  return (
    <>
      <AccountSettings
        key={user.id}
        user={user}
        onPasswordReset={passwordReset}
      />
      <AttachmentSettings />
    </>
  );
}
