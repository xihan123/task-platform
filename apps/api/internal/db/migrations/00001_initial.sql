-- +goose Up
CREATE TYPE "UserRole" AS ENUM ('USER','ADMIN');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE','DISABLED');
CREATE TYPE "TaskStatus" AS ENUM ('PENDING_REVIEW','OPEN','IN_PROGRESS','COMPLETED','CANCELLED');
CREATE TYPE "AiProtocol" AS ENUM ('OPENAI_COMPATIBLE');
CREATE TYPE "ModerationStatus" AS ENUM ('PENDING','PROCESSING','COMPLETED','ERROR','SUPERSEDED');
CREATE TYPE "ModerationDecision" AS ENUM ('PASS','REVIEW','REJECT');
CREATE TYPE "ModerationSource" AS ENUM ('AI','MANUAL');
CREATE TYPE "RiskLevel" AS ENUM ('LOW','MEDIUM','HIGH');
CREATE TYPE "TaskActivityType" AS ENUM ('MESSAGE_SENT','TASK_COMPLETION_REQUESTED','TASK_COMPLETED');
CREATE TYPE "NotificationType" AS ENUM ('TASK_REVISION_REQUESTED','TASK_MODERATION_ERROR','TASK_MODERATION_REVIEW','TASK_MESSAGE','TASK_COMPLETION_REQUESTED');
CREATE TYPE "EmailCodePurpose" AS ENUM ('REGISTER','RESET_PASSWORD','VERIFY_EMAIL');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('SKIPPED','PENDING','PROCESSING','SENT','FAILED');

CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(254) NOT NULL UNIQUE CHECK(email=lower(btrim(email))),
 password_hash text NOT NULL, role "UserRole" NOT NULL DEFAULT 'USER', status "UserStatus" NOT NULL DEFAULT 'ACTIVE',
 email_verified_at timestamptz(3), message_email_enabled boolean NOT NULL DEFAULT false, session_version integer NOT NULL DEFAULT 0,
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_single_admin ON users(role) WHERE role='ADMIN';
CREATE TABLE tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title varchar(160) NOT NULL, summary varchar(500) NOT NULL,
 description text NOT NULL, type varchar(64) NOT NULL, status "TaskStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
 publisher_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at timestamptz(3) NOT NULL DEFAULT now(), updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX tasks_feed ON tasks(created_at DESC,id DESC);
CREATE INDEX tasks_publisher ON tasks(publisher_id);
CREATE TABLE ai_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), base_url varchar(2048) NOT NULL UNIQUE,
 protocol "AiProtocol" NOT NULL DEFAULT 'OPENAI_COMPATIBLE', enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE ai_models (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint_id uuid NOT NULL REFERENCES ai_endpoints(id) ON DELETE CASCADE,
 name varchar(128) NOT NULL, enabled boolean NOT NULL DEFAULT true, UNIQUE(endpoint_id,name)
);
CREATE TABLE ai_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), endpoint_id uuid NOT NULL REFERENCES ai_endpoints(id) ON DELETE CASCADE,
 encrypted_key text NOT NULL, fingerprint char(64) NOT NULL, last4 varchar(4) NOT NULL,
 enabled boolean NOT NULL DEFAULT true, UNIQUE(endpoint_id,fingerprint)
);
CREATE TABLE task_moderations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 input_hash char(64) NOT NULL, prompt_version varchar(32) NOT NULL, status "ModerationStatus" NOT NULL DEFAULT 'PENDING',
 source "ModerationSource" NOT NULL DEFAULT 'AI', reviewer_id uuid REFERENCES users(id) ON DELETE RESTRICT,
 decision "ModerationDecision", risk_level "RiskLevel", categories text[] NOT NULL DEFAULT '{}', reason text,
 confidence double precision CHECK(confidence BETWEEN 0 AND 1), category_match boolean, suggested_type varchar(64),
 error_code varchar(64), attempted_resources text[] NOT NULL DEFAULT '{}' CHECK(cardinality(attempted_resources)<=3),
 lease_token uuid, started_at timestamptz(3), completed_at timestamptz(3), created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX moderations_task ON task_moderations(task_id,created_at DESC,id DESC);
CREATE INDEX moderations_recovery ON task_moderations(status,started_at);
CREATE UNIQUE INDEX moderations_one_active ON task_moderations(task_id) WHERE status IN ('PENDING','PROCESSING');
CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, content text NOT NULL,
 created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX messages_cursor ON messages(conversation_id,created_at,id);
CREATE TABLE task_activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, type "TaskActivityType" NOT NULL,
 message_id uuid UNIQUE REFERENCES messages(id) ON DELETE CASCADE, created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX activities_cursor ON task_activities(task_id,created_at,id);
CREATE UNIQUE INDEX activities_completion_once ON task_activities(task_id,type) WHERE message_id IS NULL;
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_role "UserRole" NOT NULL DEFAULT 'ADMIN', type "NotificationType" NOT NULL,
 moderation_id uuid UNIQUE REFERENCES task_moderations(id) ON DELETE CASCADE,
 message_id uuid UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
 activity_id uuid UNIQUE REFERENCES task_activities(id) ON DELETE CASCADE,
 recipient_id uuid REFERENCES users(id) ON DELETE RESTRICT, created_at timestamptz(3) NOT NULL DEFAULT now(),
 email_status "EmailDeliveryStatus" NOT NULL DEFAULT 'SKIPPED', email_attempts integer NOT NULL DEFAULT 0,
 email_next_attempt_at timestamptz(3), email_lease_token uuid, email_lease_until timestamptz(3), email_sent_at timestamptz(3),
 CHECK(num_nonnulls(moderation_id,message_id,activity_id)=1),
 CHECK((recipient_role='ADMIN' AND recipient_id IS NULL) OR (recipient_role='USER' AND recipient_id IS NOT NULL))
);
CREATE INDEX notifications_recipient ON notifications(recipient_role,recipient_id,created_at);
CREATE INDEX notifications_recovery ON notifications(email_status,email_next_attempt_at);
CREATE TABLE email_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email varchar(254) NOT NULL CHECK(email=lower(btrim(email))),
 purpose "EmailCodePurpose" NOT NULL, code_hash char(64) NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL, consumed_at timestamptz(3), UNIQUE(email,purpose)
);
CREATE INDEX email_codes_expiry ON email_codes(expires_at);
CREATE TABLE attachment_policy (
 id integer PRIMARY KEY DEFAULT 1 CHECK(id=1), retention_days integer NOT NULL DEFAULT 7 CHECK(retention_days BETWEEN 1 AND 36500),
 max_size_mb integer NOT NULL DEFAULT 5 CHECK(max_size_mb>0)
);
INSERT INTO attachment_policy(id) VALUES(1);
CREATE TABLE attachments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 task_id uuid REFERENCES tasks(id) ON DELETE RESTRICT, message_id uuid REFERENCES messages(id) ON DELETE RESTRICT,
 file_name varchar(255) NOT NULL, ready boolean NOT NULL DEFAULT false, size bigint NOT NULL CHECK(size>=0),
 created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL, deleted_at timestamptz(3),
 CHECK(message_id IS NULL OR task_id IS NOT NULL)
);
CREATE INDEX attachments_drafts ON attachments(uploader_id,task_id);
CREATE INDEX attachments_parent ON attachments(task_id,message_id);
CREATE INDEX attachments_expiry ON attachments(deleted_at,expires_at);
