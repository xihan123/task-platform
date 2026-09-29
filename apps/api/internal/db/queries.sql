-- name: UserByID :one
SELECT * FROM users WHERE id=$1;
-- name: UserByEmail :one
SELECT * FROM users WHERE email=$1;
-- name: Admin :one
SELECT * FROM users WHERE role='ADMIN';
-- name: CreateUser :one
INSERT INTO users(email,password_hash,role,email_verified_at) VALUES($1,$2,$3,$4) RETURNING *;
-- name: TaskByID :one
SELECT * FROM tasks WHERE id=$1;
-- name: CreateTask :one
INSERT INTO tasks(title,summary,description,type,publisher_id) VALUES($1,$2,$3,$4,$5) RETURNING *;
-- name: Conversation :one
SELECT * FROM conversations WHERE task_id=$1;
-- name: EnsureConversation :one
INSERT INTO conversations(task_id) VALUES($1) ON CONFLICT(task_id) DO UPDATE SET task_id=EXCLUDED.task_id RETURNING *;
-- name: MessageByID :one
SELECT * FROM messages WHERE id=$1;
-- name: LatestModeration :one
SELECT * FROM task_moderations WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1;
-- name: ModerationByID :one
SELECT * FROM task_moderations WHERE id=$1;
-- name: ModerationHistory :many
SELECT * FROM task_moderations WHERE task_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100;
-- name: AttachmentByID :one
SELECT * FROM attachments WHERE id=$1;
-- name: TaskAttachments :many
SELECT * FROM attachments WHERE task_id=$1 AND message_id IS NULL AND ready ORDER BY id;
-- name: MessageAttachments :many
SELECT * FROM attachments WHERE message_id=$1 AND ready ORDER BY id;
-- name: AttachmentPolicy :one
SELECT * FROM attachment_policy WHERE id=1;
-- name: EmailCode :one
SELECT * FROM email_codes WHERE email=$1 AND purpose=$2 FOR UPDATE;
-- name: EmailCodeByID :one
SELECT * FROM email_codes WHERE id=$1;
-- name: NotificationByID :one
SELECT * FROM notifications WHERE id=$1;
