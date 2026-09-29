package platform

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"taskplatform/api/internal/db"
)

type messageDTO struct {
	ID             string          `json:"id"`
	ConversationID string          `json:"conversationId"`
	SenderID       string          `json:"senderId"`
	Content        string          `json:"content"`
	CreatedAt      string          `json:"createdAt"`
	Attachments    []attachmentDTO `json:"attachments"`
}
type activityDTO struct {
	ID        string  `json:"id"`
	TaskID    string  `json:"taskId"`
	ActorID   string  `json:"actorId"`
	Type      string  `json:"type"`
	MessageID *string `json:"messageId"`
	CreatedAt string  `json:"createdAt"`
}
type sendInput struct {
	ID            string   `json:"id"`
	Content       *string  `json:"content"`
	AttachmentIDs []string `json:"attachmentIds"`
}

func (a *App) authorizeChat(ctx context.Context, taskID string, user *actor) (db.Task, error) {
	if user == nil {
		return db.Task{}, fail(401, "UNAUTHENTICATED")
	}
	t, e := a.Q.TaskByID(ctx, taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return t, fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return t, e
	}
	if user.Role != "ADMIN" && user.ID != t.PublisherID {
		return t, fail(403, "CONVERSATION_FORBIDDEN")
	}
	return t, nil
}
func (a *App) message(ctx context.Context, m db.Message) (messageDTO, error) {
	files, e := a.Q.MessageAttachments(ctx, &m.ID)
	if e != nil {
		return messageDTO{}, e
	}
	attachments := make([]attachmentDTO, 0, len(files))
	for _, f := range files {
		attachments = append(attachments, toAttachment(f))
	}
	return messageDTO{m.ID, m.ConversationID, m.SenderID, m.Content, stamp(m.CreatedAt), attachments}, nil
}
func (a *App) remaining(ctx context.Context, tx pgx.Tx, conversationID, publisherID string) (int, error) {
	var count int
	e := tx.QueryRow(ctx, "SELECT count(*) FROM messages m WHERE m.conversation_id=$1 AND m.sender_id=$2 AND (NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=$1 AND sender_id<>$2) OR (m.created_at,m.id)>(SELECT created_at,id FROM messages WHERE conversation_id=$1 AND sender_id<>$2 ORDER BY created_at DESC,id DESC LIMIT 1))", conversationID, publisherID).Scan(&count)
	if e != nil {
		return 0, e
	}
	if count >= 3 {
		return 0, nil
	}
	return 3 - count, nil
}
func (a *App) listMessages(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	task, e := a.authorizeChat(r.Context(), taskID, user)
	if e != nil {
		return e
	}
	before := r.URL.Query().Get("before")
	after := r.URL.Query().Get("after")
	if before != "" && after != "" {
		return fail(400, "INVALID_CURSOR")
	}
	cursor := before
	if after != "" {
		cursor = after
	}
	if cursor != "" && !isID(cursor) {
		return fail(400, "VALIDATION_ERROR")
	}
	limit, e := queryLimit(r, 50)
	if e != nil {
		return e
	}
	conversation, e := a.Q.Conversation(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "CONVERSATION_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	var remaining any
	if user.Role != "ADMIN" {
		tx, x := a.DB.Begin(r.Context())
		if x != nil {
			return x
		}
		n, x := a.remaining(r.Context(), tx, conversation.ID, user.ID)
		_ = tx.Rollback(r.Context())
		if x != nil {
			return x
		}
		remaining = n
	}
	canSend := task.Status == "PENDING_REVIEW" || task.Status == "OPEN" || task.Status == "IN_PROGRESS"
	if number, ok := remaining.(int); ok && number == 0 {
		canSend = false
	}
	cursorAt := time.Time{}
	if cursor != "" {
		x := a.DB.QueryRow(r.Context(), "SELECT created_at FROM messages WHERE id=$1 AND conversation_id=$2", cursor, conversation.ID).Scan(&cursorAt)
		if errors.Is(x, pgx.ErrNoRows) {
			return fail(400, "INVALID_CURSOR")
		}
		if x != nil {
			return x
		}
	}
	direction := "DESC"
	condition := ""
	args := []any{conversation.ID}
	if before != "" {
		condition = " AND (created_at,id)<($2,$3)"
		args = append(args, cursorAt, before)
	}
	if after != "" {
		direction = "ASC"
		condition = " AND (created_at,id)>($2,$3)"
		args = append(args, cursorAt, after)
	}
	rows, e := a.DB.Query(r.Context(), "SELECT id,conversation_id,sender_id,content,created_at FROM messages WHERE conversation_id=$1"+condition+" ORDER BY created_at "+direction+",id "+direction+" LIMIT $"+strconv.Itoa(len(args)+1), append(args, limit+1)...)
	if e != nil {
		return e
	}
	messages := []db.Message{}
	for rows.Next() {
		var m db.Message
		if x := rows.Scan(&m.ID, &m.ConversationID, &m.SenderID, &m.Content, &m.CreatedAt); x != nil {
			rows.Close()
			return x
		}
		messages = append(messages, m)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	extra := len(messages) > limit
	if extra {
		messages = messages[:limit]
	}
	if after == "" {
		slices.Reverse(messages)
	}
	items := make([]messageDTO, 0, len(messages))
	for _, m := range messages {
		view, x := a.message(r.Context(), m)
		if x != nil {
			return x
		}
		items = append(items, view)
	}
	var older, newer *string
	if extra && after == "" && len(items) > 0 {
		v := items[0].ID
		older = &v
	}
	if extra && after != "" && len(items) > 0 {
		v := items[len(items)-1].ID
		newer = &v
	}
	jsonOut(w, 200, map[string]any{"conversationId": conversation.ID, "items": items, "olderCursor": older, "newerCursor": newer, "canSend": canSend, "remainingMessages": remaining})
	return nil
}
func (a *App) sendMessage(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	if e = a.rate(r, "chat:rate:"+user.ID, 60, time.Minute); e != nil {
		return remapUnavailable(e, "CHAT_UNAVAILABLE")
	}
	var in sendInput
	if e = body(r, &in); e != nil {
		return e
	}
	if in.Content == nil {
		return fail(400, "VALIDATION_ERROR")
	}
	content := trimmed(*in.Content)
	if in.ID != "" && !isID(in.ID) {
		return fail(400, "VALIDATION_ERROR")
	}
	if len(content) > 5000 || (content == "" && len(in.AttachmentIDs) == 0) {
		return fail(400, "VALIDATION_ERROR")
	}
	if e = validAttachmentIDs(in.AttachmentIDs); e != nil {
		return e
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if e = lockTask(r.Context(), tx, taskID); e != nil {
		return e
	}
	task, e := a.authorizeChat(r.Context(), taskID, user)
	if e != nil {
		return e
	}
	if task.Status == "COMPLETED" || task.Status == "CANCELLED" {
		return fail(409, "CHAT_READ_ONLY")
	}
	conversation, e := db.New(tx).EnsureConversation(r.Context(), taskID)
	if e != nil {
		return e
	}
	if in.ID != "" {
		existing, x := db.New(tx).MessageByID(r.Context(), in.ID)
		if x == nil {
			view, y := a.message(r.Context(), existing)
			if y != nil {
				return y
			}
			same := existing.ConversationID == conversation.ID && existing.SenderID == user.ID && existing.Content == content && sameAttachmentIDs(view.Attachments, in.AttachmentIDs)
			if !same {
				return fail(409, "MESSAGE_CONFLICT")
			}
			jsonOut(w, 201, view)
			return nil
		} else if !errors.Is(x, pgx.ErrNoRows) {
			return x
		}
	}
	if user.Role != "ADMIN" {
		n, x := a.remaining(r.Context(), tx, conversation.ID, user.ID)
		if x != nil {
			return x
		}
		if n == 0 {
			return fail(409, "CHAT_REPLY_LIMIT")
		}
	}
	if in.ID == "" {
		in.ID = id()
	}
	var createdAt time.Time
	e = tx.QueryRow(r.Context(), "SELECT GREATEST(now(),COALESCE(max(created_at)+interval '1 millisecond',now())) FROM messages WHERE conversation_id=$1", conversation.ID).Scan(&createdAt)
	if e != nil {
		return e
	}
	var message db.Message
	e = tx.QueryRow(r.Context(), "INSERT INTO messages(id,conversation_id,sender_id,content,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id,conversation_id,sender_id,content,created_at", in.ID, conversation.ID, user.ID, content, createdAt).Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.Content, &message.CreatedAt)
	if e != nil {
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "23505" {
			return fail(409, "MESSAGE_CONFLICT")
		}
		return e
	}
	if e = a.bindAttachments(r.Context(), tx, user.ID, taskID, in.ID, in.AttachmentIDs); e != nil {
		return e
	}
	var activityID string
	var activityAt time.Time
	e = tx.QueryRow(r.Context(), "INSERT INTO task_activities(task_id,actor_id,type,message_id) VALUES($1,$2,'MESSAGE_SENT',$3) RETURNING id,created_at", taskID, user.ID, in.ID).Scan(&activityID, &activityAt)
	if e != nil {
		return e
	}
	recipientRole := "ADMIN"
	var recipientID any
	if user.Role == "ADMIN" {
		recipientRole = "USER"
		recipientID = task.PublisherID
	}
	var emailStatus string = "SKIPPED"
	if a.Config.EmailEnabled {
		var eligible bool
		if recipientRole == "USER" {
			e = tx.QueryRow(r.Context(), "SELECT status='ACTIVE' AND email_verified_at IS NOT NULL AND message_email_enabled FROM users WHERE id=$1", recipientID).Scan(&eligible)
		} else {
			e = tx.QueryRow(r.Context(), "SELECT status='ACTIVE' AND email_verified_at IS NOT NULL AND message_email_enabled FROM users WHERE role='ADMIN'").Scan(&eligible)
		}
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		if eligible {
			emailStatus = "PENDING"
		}
	}
	var notificationID string
	var emailNext any
	if emailStatus == "PENDING" {
		emailNext = time.Now()
	}
	e = tx.QueryRow(r.Context(), "INSERT INTO notifications(recipient_role,recipient_id,type,message_id,email_status,email_next_attempt_at) VALUES($1,$2,'TASK_MESSAGE',$3,$4,$5) RETURNING id", recipientRole, recipientID, in.ID, emailStatus, emailNext).Scan(&notificationID)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	view, e := a.message(r.Context(), message)
	if e != nil {
		return e
	}
	activity := activityDTO{activityID, taskID, user.ID, "MESSAGE_SENT", &message.ID, activityAt.UTC().Format(time.RFC3339Nano)}
	a.publish(taskID, "message:new", view)
	a.publish(taskID, "task:activity", activity)
	a.enqueueNotification(r.Context(), notificationID)
	jsonOut(w, 201, view)
	return nil
}
func sameAttachmentIDs(got []attachmentDTO, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	actual := make([]string, 0, len(got))
	for _, f := range got {
		actual = append(actual, f.ID)
	}
	sort.Strings(actual)
	expected := append([]string(nil), want...)
	sort.Strings(expected)
	return slices.Equal(actual, expected)
}
func (a *App) conversations(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	limit, e := queryLimit(r, 20)
	if e != nil {
		return e
	}
	cursor := r.URL.Query().Get("cursor")
	if cursor != "" && !isID(cursor) {
		return fail(400, "VALIDATION_ERROR")
	}
	query := "SELECT id,title,status::text FROM tasks WHERE ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM tasks WHERE id=$1))"
	args := []any{nullID(cursor)}
	if user.Role != "ADMIN" {
		query += " AND publisher_id=$2"
		args = append(args, user.ID)
	}
	query += " ORDER BY created_at DESC,id DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)
	rows, e := a.DB.Query(r.Context(), query, args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []map[string]any{}
	for rows.Next() {
		var taskID, title, status string
		if x := rows.Scan(&taskID, &title, &status); x != nil {
			return x
		}
		items = append(items, map[string]any{"taskId": taskID, "title": title, "status": status})
	}
	if e = rows.Err(); e != nil {
		return e
	}
	var next *string
	if len(items) > limit {
		v := items[limit-1]["taskId"].(string)
		next = &v
		items = items[:limit]
	}
	jsonOut(w, 200, map[string]any{"items": items, "nextCursor": next})
	return nil
}

type hub struct {
	mu      sync.Mutex
	clients map[string]map[*wsClient]bool
}
type wsClient struct {
	conn          *websocket.Conn
	userID, token string
	mu            sync.Mutex
}

func newHub() *hub { return &hub{clients: map[string]map[*wsClient]bool{}} }
func (a *App) wsAuthorized(ctx context.Context, c *wsClient, taskID string) bool {
	data, e := a.Redis.Get(ctx, a.sessionKey(c.token)).Result()
	if e != nil {
		return false
	}
	var session struct {
		UserID  string `json:"userId"`
		Version int32  `json:"version"`
	}
	if json.Unmarshal([]byte(data), &session) != nil || session.UserID != c.userID {
		return false
	}
	row, e := a.Q.UserByID(ctx, c.userID)
	if e != nil || row.Status != "ACTIVE" || row.SessionVersion != session.Version {
		return false
	}
	task, e := a.Q.TaskByID(ctx, taskID)
	return e == nil && (row.Role == "ADMIN" || task.PublisherID == c.userID)
}
func (a *App) publish(taskID, event string, value any) {
	raw, _ := json.Marshal(map[string]any{"event": event, "data": value})
	a.Hub.mu.Lock()
	clients := make([]*wsClient, 0, len(a.Hub.clients[taskID]))
	for c := range a.Hub.clients[taskID] {
		clients = append(clients, c)
	}
	a.Hub.mu.Unlock()
	for _, client := range clients {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if !a.wsAuthorized(ctx, client, taskID) {
			_ = client.conn.Close(websocket.StatusPolicyViolation, "session ended")
			cancel()
			continue
		}
		client.mu.Lock()
		_ = client.conn.Write(ctx, websocket.MessageText, raw)
		client.mu.Unlock()
		cancel()
	}
}
func (a *App) events(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	if _, e = a.authorizeChat(r.Context(), taskID, user); e != nil {
		return e
	}
	origin := r.Header.Get("Origin")
	allowed := false
	for _, x := range a.Config.WebOrigins {
		if origin == x {
			allowed = true
		}
	}
	if !allowed {
		return fail(403, "CSRF_REJECTED")
	}
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if e != nil {
		return nil
	}
	client := &wsClient{conn: conn, userID: user.ID, token: a.cookieToken(r)}
	a.Hub.mu.Lock()
	if a.Hub.clients[taskID] == nil {
		a.Hub.clients[taskID] = map[*wsClient]bool{}
	}
	a.Hub.clients[taskID][client] = true
	a.Hub.mu.Unlock()
	defer func() {
		a.Hub.mu.Lock()
		delete(a.Hub.clients[taskID], client)
		a.Hub.mu.Unlock()
		_ = conn.Close(websocket.StatusNormalClosure, "closed")
	}()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		tick := time.NewTicker(15 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if !a.wsAuthorized(ctx, client, taskID) {
					_ = conn.Close(websocket.StatusPolicyViolation, "session ended")
					return
				}
				client.mu.Lock()
				pingCtx, stop := context.WithTimeout(ctx, 5*time.Second)
				x := conn.Ping(pingCtx)
				stop()
				client.mu.Unlock()
				if x != nil {
					return
				}
			}
		}
	}()
	for {
		_, _, e := conn.Read(ctx)
		if e != nil {
			return nil
		}
	}
}
