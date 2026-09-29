import type { AttachmentDto, AttachmentPolicyDto } from './types';
import { apiRequest, ApiClientError } from './api-client';

export const attachmentsApi = {
  async policy(signal?: AbortSignal): Promise<AttachmentPolicyDto> {
    return (
      await apiRequest('attachments/policy', 'GET', undefined, signal)
    ).json();
  },
  async configure(input: AttachmentPolicyDto): Promise<AttachmentPolicyDto> {
    return (
      await apiRequest('admin/settings/attachments', 'PATCH', input)
    ).json();
  },
  async upload(file: File): Promise<AttachmentDto> {
    const form = new FormData();
    form.append('file', file);
    return (await apiRequest('attachments', 'POST', form)).json();
  },
  async discard(id: string) {
    await apiRequest(`attachments/${id}`, 'DELETE');
  },
  async download(file: AttachmentDto) {
    const response = await apiRequest(`attachments/${file.id}/download`, 'GET');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = file.fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};

export function attachmentError(error: unknown): string {
  const messages: Record<string, string> = {
    ATTACHMENT_TOO_LARGE:
      '文件超过当前上限，请使用不限速网盘，并在任务或讨论中提供分享链接。',
    ATTACHMENT_DRAFT_LIMIT:
      '最多暂存 10 个未提交附件，请移除不需要的附件后再上传。',
    ATTACHMENT_INVALID: '附件已过期或不可用，请移除后重新上传。',
    ATTACHMENT_EXPIRED: '附件已过期删除。',
    ATTACHMENT_NOT_FOUND: '附件不存在或无权访问。',
    ATTACHMENT_FORBIDDEN: '无权操作此附件。',
    RATE_LIMITED: '上传过于频繁，请稍后重试。',
    UNAUTHENTICATED: '登录已失效，请重新登录。',
  };
  return error instanceof ApiClientError
    ? (messages[error.code] ?? '附件操作失败，请重试。')
    : '附件操作失败，请重试。';
}
