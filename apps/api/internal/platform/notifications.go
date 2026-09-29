package platform

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"taskplatform/api/internal/db"
)

func (a *App) notifications(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	return a.listNotifications(w, r, user)
}
func (a *App) adminNotifications(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "ADMIN")
	if e != nil {
		return e
	}
	return a.listNotifications(w, r, user)
}
func (a *App) listNotifications(w http.ResponseWriter, r *http.Request, user *actor) error {
	role := user.Role
	var recipient any
	if role == "USER" {
		recipient = user.ID
	}
	rows, e := a.DB.Query(r.Context(), "SELECT n.id,n.type::text,COALESCE(m.task_id,ta.task_id,c.task_id),n.moderation_id,n.message_id,n.activity_id,n.created_at FROM notifications n LEFT JOIN task_moderations m ON n.moderation_id=m.id LEFT JOIN task_activities ta ON n.activity_id=ta.id LEFT JOIN messages msg ON n.message_id=msg.id LEFT JOIN conversations c ON msg.conversation_id=c.id WHERE n.recipient_role=$1 AND ($2::uuid IS NULL OR n.recipient_id=$2) ORDER BY n.created_at DESC,n.id DESC LIMIT 100", role, recipient)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var ID, kind, taskID string
		var moderationID, messageID, activityID *string
		var at time.Time
		if e = rows.Scan(&ID, &kind, &taskID, &moderationID, &messageID, &activityID, &at); e != nil {
			return e
		}
		items = append(items, map[string]any{"id": ID, "type": kind, "taskId": taskID, "moderationId": moderationID, "messageId": messageID, "activityId": activityID, "createdAt": at.UTC().Format(time.RFC3339Nano)})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	jsonOut(w, 200, items)
	return nil
}
func (a *App) preferences(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	row, e := a.Q.UserByID(r.Context(), user.ID)
	if e != nil {
		return e
	}
	var at *string
	if row.EmailVerifiedAt.Valid {
		s := stamp(row.EmailVerifiedAt)
		at = &s
	}
	jsonOut(w, 200, map[string]any{"emailVerifiedAt": at, "messageEmailEnabled": row.MessageEmailEnabled})
	return nil
}
func (a *App) updatePreferences(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	var input struct {
		Enabled *bool `json:"messageEmailEnabled"`
	}
	if e = body(r, &input); e != nil {
		return e
	}
	if input.Enabled == nil {
		return fail(400, "VALIDATION_ERROR")
	}
	row, e := a.Q.UserByID(r.Context(), user.ID)
	if e != nil {
		return e
	}
	if *input.Enabled && !row.EmailVerifiedAt.Valid {
		return fail(403, "EMAIL_NOT_VERIFIED")
	}
	_, e = a.DB.Exec(r.Context(), "UPDATE users SET message_email_enabled=$1,updated_at=now() WHERE id=$2", *input.Enabled, user.ID)
	if e != nil {
		return e
	}
	if !*input.Enabled {
		_, _ = a.DB.Exec(r.Context(), "UPDATE notifications SET email_status='SKIPPED',email_next_attempt_at=NULL,email_lease_token=NULL,email_lease_until=NULL WHERE email_status IN ('PENDING','PROCESSING') AND ((recipient_role='ADMIN' AND $1='ADMIN') OR recipient_id=$2)", user.Role, user.ID)
	}
	return a.preferences(w, r)
}
func (a *App) presence(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	tabID, e := presenceID(r)
	if e != nil {
		return e
	}
	key := a.Config.RedisPrefix + "presence:" + user.ID
	now := time.Now()
	script := "redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',ARGV[1]);redis.call('ZADD',KEYS[1],ARGV[2],ARGV[3]);return redis.call('EXPIRE',KEYS[1],30)"
	if e = a.Redis.Eval(r.Context(), script, []string{key}, now.UnixMilli(), now.Add(30*time.Second).UnixMilli(), tabID).Err(); e != nil {
		return fail(503, "NOTIFICATION_UNAVAILABLE")
	}
	w.WriteHeader(204)
	return nil
}
func (a *App) leavePresence(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	tabID, e := presenceID(r)
	if e != nil {
		return e
	}
	if e = a.Redis.ZRem(r.Context(), a.Config.RedisPrefix+"presence:"+user.ID, tabID).Err(); e != nil {
		return fail(503, "NOTIFICATION_UNAVAILABLE")
	}
	w.WriteHeader(204)
	return nil
}
func presenceID(r *http.Request) (string, error) {
	var input struct {
		TabID string `json:"tabId"`
	}
	if e := body(r, &input); e != nil {
		return "", e
	}
	if !isID(input.TabID) {
		return "", fail(400, "VALIDATION_ERROR")
	}
	return input.TabID, nil
}
func (a *App) online(ctx context.Context, userID string) bool {
	vals, e := a.Redis.ZRangeByScore(ctx, a.Config.RedisPrefix+"presence:"+userID, &redis.ZRangeBy{Min: strconv.FormatInt(time.Now().UnixMilli()+1, 10), Max: "+inf", Offset: 0, Count: 1}).Result()
	return e == nil && len(vals) > 0
}
func (a *App) users(w http.ResponseWriter, r *http.Request) error {
	limit, e := queryLimit(r, 20)
	if e != nil {
		return e
	}
	cursor := r.URL.Query().Get("cursor")
	if cursor != "" && !isID(cursor) {
		return fail(400, "VALIDATION_ERROR")
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "ACTIVE" && status != "DISABLED" {
		return fail(400, "VALIDATION_ERROR")
	}
	email := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("email")))
	if len(email) > 254 {
		return fail(400, "VALIDATION_ERROR")
	}
	rows, e := a.DB.Query(r.Context(), "SELECT id,email,role::text,status::text,created_at FROM users WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM users WHERE id=$1)) AND ($2='' OR status::text=$2) AND ($3='' OR email LIKE '%'||$3||'%') ORDER BY created_at DESC,id DESC LIMIT $4", nullID(cursor), status, email, limit+1)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []userDTO{}
	for rows.Next() {
		var dto userDTO
		var at time.Time
		if e = rows.Scan(&dto.ID, &dto.Email, &dto.Role, &dto.Status, &at); e != nil {
			return e
		}
		dto.CreatedAt = at.UTC().Format(time.RFC3339Nano)
		items = append(items, dto)
	}
	if e = rows.Err(); e != nil {
		return e
	}
	var next *string
	if len(items) > limit {
		v := items[limit-1].ID
		next = &v
		items = items[:limit]
	}
	jsonOut(w, 200, map[string]any{"items": items, "nextCursor": next})
	return nil
}
func (a *App) userStatus(w http.ResponseWriter, r *http.Request) error {
	userID, e := paramID(r)
	if e != nil {
		return e
	}
	var input struct {
		Status string `json:"status" validate:"oneof=ACTIVE DISABLED"`
	}
	if e = body(r, &input); e != nil {
		return e
	}
	if e = a.valid(input); e != nil {
		return e
	}
	row, e := a.Q.UserByID(r.Context(), userID)
	if e != nil {
		return fail(404, "USER_NOT_FOUND")
	}
	if row.Role == "ADMIN" {
		return fail(403, "ADMIN_PROTECTED")
	}
	_, e = a.DB.Exec(r.Context(), "UPDATE users SET status=$1,session_version=session_version+1,updated_at=now() WHERE id=$2 AND role='USER'", input.Status, userID)
	if e != nil {
		return e
	}
	row.Status = db.UserStatus(input.Status)
	jsonOut(w, 200, toUser(row))
	return nil
}
