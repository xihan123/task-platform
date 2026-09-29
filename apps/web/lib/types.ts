export interface LivenessResponse {
  status: 'ok';
  service: 'api' | 'web';
}

export interface ReadinessResponse {
  status: 'ok' | 'degraded';
  service: 'api';
  checks: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

export interface ApiErrorResponse {
  code: string;
  message: string;
  requestId: string;
}

export type UserRole = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'DISABLED';

export interface UserDto {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
}

export interface CredentialsInput {
  email: string;
  password: string;
}

export interface EmailInput {
  email: string;
}
export interface VerifyEmailInput {
  code: string;
}
export interface RegisterInput extends CredentialsInput, VerifyEmailInput {}
export type ResetPasswordInput = RegisterInput;
export interface EmailPreferencesDto {
  emailVerifiedAt: string | null;
  messageEmailEnabled: boolean;
}
export interface UpdateEmailPreferencesInput {
  messageEmailEnabled: boolean;
}

export interface AuthUserResponse {
  user: UserDto;
}

export type TaskStatus =
  'PENDING_REVIEW' | 'OPEN' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

export interface PublicTaskDto {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: TaskStatus;
  createdAt: string;
}

export interface PrivateTaskDto extends PublicTaskDto {
  description: string;
  publisherId: string;
  updatedAt: string;
  attachments: AttachmentDto[];
  reviewFeedback: {
    reason: string | null;
    source: 'AI' | 'MANUAL';
    reviewedAt: string;
  } | null;
}

export type AdminTaskDto = PrivateTaskDto;
export type TaskDto = PublicTaskDto | PrivateTaskDto | AdminTaskDto;

export interface CreateTaskInput {
  title: string;
  summary: string;
  description: string;
  type: string;
  attachmentIds?: string[];
}

export type UpdateTaskInput = Partial<CreateTaskInput>;

export interface ListTasksQuery {
  limit?: number;
  cursor?: string;
}

export type TaskListScope = 'public' | 'mine';

export interface TaskFeedQuery extends ListTasksQuery {
  scope?: TaskListScope;
}

export interface TaskListResponse {
  items: TaskDto[];
  nextCursor: string | null;
}

export interface PublicTaskStatsDto {
  open: number;
  inProgress: number;
  completed: number;
}

export type ModerationDecision = 'PASS' | 'REVIEW' | 'REJECT';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ModerationStatus =
  'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR' | 'SUPERSEDED';

export interface ModerationResult {
  decision: ModerationDecision;
  riskLevel: RiskLevel;
  categories: string[];
  reason: string;
  confidence: number;
  categoryMatch: boolean;
  suggestedType: string | null;
}

export interface TaskModerationDto {
  id: string;
  taskId: string;
  status: ModerationStatus;
  source: 'AI' | 'MANUAL';
  reviewerId: string | null;
  promptVersion: string;
  decision: ModerationDecision | null;
  riskLevel: RiskLevel | null;
  categories: string[];
  reason: string | null;
  confidence: number | null;
  categoryMatch: boolean | null;
  suggestedType: string | null;
  errorCode: string | null;
  attempts: number;
  createdAt: string;
  completedAt: string | null;
}

export interface AdminNotificationDto {
  id: string;
  type:
    | 'TASK_MODERATION_ERROR'
    | 'TASK_MODERATION_REVIEW'
    | 'TASK_MESSAGE'
    | 'TASK_REVISION_REQUESTED'
    | 'TASK_COMPLETION_REQUESTED';
  taskId: string;
  moderationId: string | null;
  messageId: string | null;
  activityId: string | null;
  createdAt: string;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  attachments: AttachmentDto[];
}

export interface SendMessageInput {
  id?: string;
  content: string;
  attachmentIds?: string[];
}

export interface MessagesQuery {
  before?: string;
  after?: string;
  limit?: number;
}

export interface MessagesPage {
  conversationId: string;
  items: MessageDto[];
  olderCursor: string | null;
  newerCursor: string | null;
  canSend: boolean;
  remainingMessages: number | null;
}

export interface ConversationListResponse {
  items: { taskId: string; title: string; status: TaskStatus }[];
  nextCursor: string | null;
}

export interface TaskActivityDto {
  id: string;
  taskId: string;
  actorId: string;
  type: 'MESSAGE_SENT' | 'TASK_COMPLETION_REQUESTED' | 'TASK_COMPLETED';
  messageId: string | null;
  createdAt: string;
}

export interface TaskCompletionDto {
  taskId: string;
  status: TaskStatus;
  requestedAt: string | null;
}

export type ChatServerEvent =
  | { event: 'message:new'; data: MessageDto }
  | { event: 'task:activity'; data: TaskActivityDto };

export interface AiResourceDto {
  endpointId: string;
  modelId: string;
  keyId: string;
  baseUrl: string;
  model: string;
  protocol: 'OPENAI_COMPATIBLE';
  maskedKey: string;
}

export type AdminTaskView = 'ALL' | TaskStatus | 'HUMAN_REVIEW';

export interface AdminTaskListQuery extends ListTasksQuery {
  view?: AdminTaskView;
}

export interface AdminTaskRow extends AdminTaskDto {
  publisher: Pick<UserDto, 'id' | 'email' | 'status'>;
  moderation: TaskModerationDto | null;
}

export interface AdminTaskListResponse {
  items: AdminTaskRow[];
  nextCursor: string | null;
}

export interface AdminDashboardDto {
  counts: { open: number; inProgress: number; humanReview: number };
  openTasks: PublicTaskDto[];
  inProgressTasks: PublicTaskDto[];
  reviewTasks: PublicTaskDto[];
}

export interface AdminUserListQuery extends ListTasksQuery {
  status?: UserStatus;
  email?: string;
}

export interface AdminUserListResponse {
  items: UserDto[];
  nextCursor: string | null;
}

export interface ManualReviewInput {
  moderationId: string;
  decision: 'PASS' | 'REJECT';
  reason?: string;
  type?: string;
}

export interface AttachmentDto {
  id: string;
  fileName: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  deleted: boolean;
}

export interface AttachmentPolicyDto {
  retentionDays: number;
  maxSizeMb: number;
}

export interface AiEndpointDto {
  id: string;
  baseUrl: string;
  protocol: 'OPENAI_COMPATIBLE';
  enabled: boolean;
  models: { id: string; name: string; enabled: boolean }[];
  keys: { id: string; maskedKey: string; enabled: boolean }[];
}
