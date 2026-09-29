import type {
  AuthUserResponse,
  CredentialsInput,
  RegisterInput,
  ResetPasswordInput,
  EmailPreferencesDto,
} from './types';
import { apiRequest } from './api-client';
export { ApiClientError as AuthApiError } from './api-client';

export const authApi = {
  async register(credentials: RegisterInput): Promise<AuthUserResponse> {
    return (await apiRequest('auth/register', 'POST', credentials)).json();
  },
  async requestCode(
    email: string,
    purpose: 'register' | 'password-reset',
  ): Promise<void> {
    await apiRequest(`auth/${purpose}-code`, 'POST', { email });
  },
  async resetPassword(input: ResetPasswordInput): Promise<void> {
    await apiRequest('auth/reset-password', 'POST', input);
  },
  async requestVerificationCode(): Promise<void> {
    await apiRequest('auth/email-verification-code', 'POST');
  },
  async verifyEmail(code: string): Promise<void> {
    await apiRequest('auth/verify-email', 'POST', { code });
  },
  async emailPreferences(signal?: AbortSignal): Promise<EmailPreferencesDto> {
    return (
      await apiRequest('notifications/preferences', 'GET', undefined, signal)
    ).json();
  },
  async updateEmailPreferences(
    messageEmailEnabled: boolean,
  ): Promise<EmailPreferencesDto> {
    return (
      await apiRequest('notifications/preferences', 'PATCH', {
        messageEmailEnabled,
      })
    ).json();
  },
  async login(credentials: CredentialsInput): Promise<AuthUserResponse> {
    return (await apiRequest('auth/login', 'POST', credentials)).json();
  },
  async me(signal?: AbortSignal): Promise<AuthUserResponse> {
    return (await apiRequest('auth/me', 'GET', undefined, signal)).json();
  },
  async logout(): Promise<void> {
    await apiRequest('auth/logout', 'POST');
  },
};
