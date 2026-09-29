package platform

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"taskplatform/api/internal/db"
)

//go:embed task_categories.json
var categoryFS embed.FS
var categories = func() map[string]bool {
	raw, _ := categoryFS.ReadFile("task_categories.json")
	var rows []struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &rows)
	result := map[string]bool{}
	for _, row := range rows {
		result[row.ID] = true
	}
	return result
}()

type taskInput struct {
	Title         string   `json:"title" validate:"required,max=160"`
	Summary       string   `json:"summary" validate:"required,max=500"`
	Description   string   `json:"description" validate:"required,max=20000"`
	Type          string   `json:"type" validate:"required,max=64"`
	AttachmentIDs []string `json:"attachmentIds,omitempty"`
}
type publicTask struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Summary   string `json:"summary"`
	Type      string `json:"type"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}
type privateTask struct {
	publicTask
	Description    string          `json:"description"`
	PublisherID    string          `json:"publisherId"`
	UpdatedAt      string          `json:"updatedAt"`
	Attachments    []attachmentDTO `json:"attachments"`
	ReviewFeedback *reviewFeedback `json:"reviewFeedback"`
}
type reviewFeedback struct {
	Reason     *string `json:"reason"`
	Source     string  `json:"source"`
	ReviewedAt string  `json:"reviewedAt"`
}

func toPublic(t db.Task) publicTask {
	return publicTask{t.ID, t.Title, t.Summary, t.Type, string(t.Status), stamp(t.CreatedAt)}
}
func stamp(t pgtype.Timestamptz) string { return t.Time.UTC().Format(time.RFC3339Nano) }
func taskHash(t db.Task) string {
	raw, _ := json.Marshal(struct {
		Title       string `json:"title"`
		Summary     string `json:"summary"`
		Description string `json:"description"`
		Type        string `json:"type"`
	}{t.Title, t.Summary, t.Description, t.Type})
	// The existing moderation digest uses ordered JSON fields title, summary, description and type.
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func (a *App) privateTask(ctx context.Context, t db.Task) (privateTask, error) {
	files, e := a.Q.TaskAttachments(ctx, &t.ID)
	if e != nil {
		return privateTask{}, e
	}
	attachments := make([]attachmentDTO, 0, len(files))
	for _, file := range files {
		attachments = append(attachments, toAttachment(file))
	}
	out := privateTask{publicTask: toPublic(t), Description: t.Description, PublisherID: t.PublisherID, UpdatedAt: stamp(t.UpdatedAt), Attachments: attachments}
	latest, e := a.Q.LatestModeration(ctx, t.ID)
	if e == nil && t.Status == "PENDING_REVIEW" && latest.Status == "COMPLETED" && latest.Decision != nil && *latest.Decision == "REJECT" && latest.CompletedAt.Valid {
		out.ReviewFeedback = &reviewFeedback{latest.Reason, string(latest.Source), stamp(latest.CompletedAt)}
	} else if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return privateTask{}, e
	}
	return out, nil
}
func lockTask(ctx context.Context, tx pgx.Tx, id string) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", id)
	return e
}
func taskPath(r *http.Request) string { return chi.URLParam(r, "id") }
func (a *App) taskRate(r *http.Request, userID, scope string) error {
	userLimit, ipLimit := 60, 120
	if scope == "moderation" {
		userLimit, ipLimit = 10, 30
	}
	ipHash := sha256.Sum256([]byte(a.clientIP(r)))
	for _, entry := range []struct {
		key   string
		limit int
	}{{"tasks:rate:" + scope + ":user:" + userID, userLimit}, {"tasks:rate:" + scope + ":ip:" + hex.EncodeToString(ipHash[:]), ipLimit}} {
		if err := a.rate(r, entry.key, entry.limit, time.Minute); err != nil {
			return remapUnavailable(err, "TASKS_UNAVAILABLE")
		}
	}
	return nil
}
func (a *App) createTask(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "USER")
	if e != nil {
		return e
	}
	if e = a.taskRate(r, user.ID, "moderation"); e != nil {
		return e
	}
	var input taskInput
	if e = body(r, &input); e != nil {
		return e
	}
	input.Title = trimmed(input.Title)
	input.Summary = trimmed(input.Summary)
	input.Description = trimmed(input.Description)
	input.Type = trimmed(input.Type)
	if e = a.valid(input); e != nil {
		return e
	}
	if !categories[input.Type] {
		return fail(400, "VALIDATION_ERROR")
	}
	if e = validAttachmentIDs(input.AttachmentIDs); e != nil {
		return e
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	task, e := db.New(tx).CreateTask(r.Context(), db.CreateTaskParams{Title: input.Title, Summary: input.Summary, Description: input.Description, Type: input.Type, PublisherID: user.ID})
	if e != nil {
		return e
	}
	_, e = db.New(tx).EnsureConversation(r.Context(), task.ID)
	if e != nil {
		return e
	}
	if e = a.bindAttachments(r.Context(), tx, user.ID, task.ID, "", input.AttachmentIDs); e != nil {
		return e
	}
	moderationID, e := a.scheduleModeration(r.Context(), tx, task)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	if trace, ok := r.Context().Value(traceKey).(*requestTrace); ok {
		trace.taskID = task.ID
	}
	a.enqueueModeration(r.Context(), moderationID)
	out, e := a.privateTask(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 201, out)
	return nil
}
func (a *App) publicStats(w http.ResponseWriter, r *http.Request) error {
	rows, e := a.DB.Query(r.Context(), "SELECT status::text,count(*) FROM tasks WHERE status IN ('OPEN','IN_PROGRESS','COMPLETED') GROUP BY status")
	if e != nil {
		return e
	}
	defer rows.Close()
	out := map[string]int64{"open": 0, "inProgress": 0, "completed": 0}
	for rows.Next() {
		var status string
		var n int64
		if e = rows.Scan(&status, &n); e != nil {
			return e
		}
		switch status {
		case "OPEN":
			out["open"] = n
		case "IN_PROGRESS":
			out["inProgress"] = n
		case "COMPLETED":
			out["completed"] = n
		}
	}
	if e = rows.Err(); e != nil {
		return e
	}
	jsonOut(w, 200, out)
	return nil
}
func scanTasks(rows pgx.Rows) ([]db.Task, error) {
	items := []db.Task{}
	for rows.Next() {
		var t db.Task
		if e := rows.Scan(&t.ID, &t.Title, &t.Summary, &t.Description, &t.Type, &t.Status, &t.PublisherID, &t.CreatedAt, &t.UpdatedAt); e != nil {
			return nil, e
		}
		items = append(items, t)
	}
	return items, rows.Err()
}

const taskColumns = "id,title,summary,description,type,status,publisher_id,created_at,updated_at"

func (a *App) listTasks(w http.ResponseWriter, r *http.Request) error {
	limit, e := queryLimit(r, 20)
	if e != nil {
		return e
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "public"
	}
	if scope != "public" && scope != "mine" {
		return fail(400, "VALIDATION_ERROR")
	}
	cursor := r.URL.Query().Get("cursor")
	if cursor != "" && !isID(cursor) {
		return fail(400, "VALIDATION_ERROR")
	}
	var rows pgx.Rows
	if scope == "mine" {
		user, x := needRole(r, "USER")
		if x != nil {
			return x
		}
		rows, e = a.DB.Query(r.Context(), "SELECT "+taskColumns+" FROM tasks WHERE publisher_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM tasks WHERE id=$2)) ORDER BY created_at DESC,id DESC LIMIT $3", user.ID, nullID(cursor), limit+1)
	} else {
		rows, e = a.DB.Query(r.Context(), "SELECT "+taskColumns+" FROM tasks WHERE status IN ('OPEN','IN_PROGRESS','COMPLETED') AND ($1::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM tasks WHERE id=$1)) ORDER BY created_at DESC,id DESC LIMIT $2", nullID(cursor), limit+1)
	}
	if e != nil {
		return e
	}
	defer rows.Close()
	tasks, e := scanTasks(rows)
	if e != nil {
		return e
	}
	var next *string
	if len(tasks) > limit {
		v := tasks[limit-1].ID
		next = &v
		tasks = tasks[:limit]
	}
	items := make([]any, 0, len(tasks))
	for _, task := range tasks {
		if scope == "mine" {
			view, x := a.privateTask(r.Context(), task)
			if x != nil {
				return x
			}
			items = append(items, view)
		} else {
			items = append(items, toPublic(task))
		}
	}
	jsonOut(w, 200, map[string]any{"items": items, "nextCursor": next})
	return nil
}
func nullID(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (a *App) getTask(w http.ResponseWriter, r *http.Request) error {
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	task, e := a.Q.TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	user := current(r)
	if user == nil || user.Role != "ADMIN" && user.ID != task.PublisherID {
		jsonOut(w, 200, toPublic(task))
		return nil
	}
	view, e := a.privateTask(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func (a *App) editTask(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "USER")
	if e != nil {
		return e
	}
	if e = a.taskRate(r, user.ID, "moderation"); e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	var raw map[string]json.RawMessage
	if e = body(r, &raw); e != nil {
		return e
	}
	if len(raw) == 0 {
		return fail(400, "EMPTY_UPDATE")
	}
	validKeys := map[string]bool{"title": true, "summary": true, "description": true, "type": true, "attachmentIds": true}
	for key := range raw {
		if !validKeys[key] {
			return fail(400, "VALIDATION_ERROR")
		}
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if e = lockTask(r.Context(), tx, taskID); e != nil {
		return e
	}
	old, e := db.New(tx).TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	if old.PublisherID != user.ID {
		return fail(403, "FORBIDDEN")
	}
	if old.Status != "PENDING_REVIEW" {
		return fail(409, "TASK_NOT_EDITABLE")
	}
	if !categories[old.Type] && raw["type"] == nil {
		return fail(400, "VALIDATION_ERROR")
	}
	changed := taskInput{Title: old.Title, Summary: old.Summary, Description: old.Description, Type: old.Type}
	for _, entry := range []struct {
		name  string
		value *string
	}{{"title", &changed.Title}, {"summary", &changed.Summary}, {"description", &changed.Description}, {"type", &changed.Type}} {
		if v, ok := raw[entry.name]; ok {
			if string(v) == "null" || json.Unmarshal(v, entry.value) != nil {
				return fail(400, "VALIDATION_ERROR")
			}
			*entry.value = trimmed(*entry.value)
		}
	}
	if e = a.valid(changed); e != nil {
		return e
	}
	if !categories[changed.Type] {
		return fail(400, "VALIDATION_ERROR")
	}
	if bytes, ok := raw["attachmentIds"]; ok {
		var ids []string
		if string(bytes) == "null" || json.Unmarshal(bytes, &ids) != nil {
			return fail(400, "VALIDATION_ERROR")
		}
		if e = validAttachmentIDs(ids); e != nil {
			return e
		}
		if e = a.replaceBodyAttachments(r.Context(), tx, user.ID, taskID, ids); e != nil {
			return e
		}
	}
	_, e = tx.Exec(r.Context(), "UPDATE tasks SET title=$1,summary=$2,description=$3,type=$4,updated_at=now() WHERE id=$5 AND status='PENDING_REVIEW' AND publisher_id=$6", changed.Title, changed.Summary, changed.Description, changed.Type, taskID, user.ID)
	if e != nil {
		return e
	}
	updated, e := db.New(tx).TaskByID(r.Context(), taskID)
	if e != nil {
		return e
	}
	moderationID, e := a.scheduleModeration(r.Context(), tx, updated)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	a.enqueueModeration(r.Context(), moderationID)
	view, e := a.privateTask(r.Context(), updated)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func (a *App) cancelTask(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "USER")
	if e != nil {
		return e
	}
	if e = a.taskRate(r, user.ID, "write"); e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
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
	task, e := db.New(tx).TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	if task.PublisherID != user.ID {
		return fail(403, "FORBIDDEN")
	}
	if task.Status == "CANCELLED" || task.Status == "COMPLETED" {
		return fail(409, "TASK_NOT_CANCELLABLE")
	}
	success, e := a.Tasks.Transition(r.Context(), tx, taskID, string(task.Status), "CANCELLED")
	if e != nil {
		return e
	}
	if !success {
		return fail(409, "TASK_CONFLICT")
	}
	_, e = tx.Exec(r.Context(), "UPDATE task_moderations SET status='SUPERSEDED',lease_token=NULL,completed_at=now() WHERE task_id=$1 AND status IN ('PENDING','PROCESSING')", taskID)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	task.Status = "CANCELLED"
	task.UpdatedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	view, e := a.privateTask(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func (a *App) take(w http.ResponseWriter, r *http.Request) error {
	_, e := needRole(r, "ADMIN")
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
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
	task, e := db.New(tx).TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	success, e := a.Tasks.Transition(r.Context(), tx, taskID, "OPEN", "IN_PROGRESS")
	if e != nil {
		return e
	}
	if !success {
		return fail(409, "TASK_NOT_AVAILABLE")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	task.Status = "IN_PROGRESS"
	task.UpdatedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	view, e := a.privateTask(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func (a *App) completion(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	task, e := a.Q.TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	if user.Role != "ADMIN" && task.PublisherID != user.ID {
		return fail(403, "FORBIDDEN")
	}
	var requested *time.Time
	e = a.DB.QueryRow(r.Context(), "SELECT created_at FROM task_activities WHERE task_id=$1 AND type='TASK_COMPLETION_REQUESTED' LIMIT 1", taskID).Scan(&requested)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	jsonOut(w, 200, map[string]any{"taskId": taskID, "status": task.Status, "requestedAt": requested})
	return nil
}
func (a *App) requestCompletion(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "ADMIN")
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
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
	task, e := db.New(tx).TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	if task.Status != "IN_PROGRESS" {
		return fail(409, "TASK_NOT_IN_PROGRESS")
	}
	var activityID string
	var requested time.Time
	e = tx.QueryRow(r.Context(), "SELECT id,created_at FROM task_activities WHERE task_id=$1 AND type='TASK_COMPLETION_REQUESTED'", taskID).Scan(&activityID, &requested)
	if errors.Is(e, pgx.ErrNoRows) {
		e = tx.QueryRow(r.Context(), "INSERT INTO task_activities(task_id,actor_id,type) VALUES($1,$2,'TASK_COMPLETION_REQUESTED') RETURNING id,created_at", taskID, user.ID).Scan(&activityID, &requested)
		if e != nil {
			return e
		}
		_, e = tx.Exec(r.Context(), "INSERT INTO notifications(recipient_role,recipient_id,type,activity_id) VALUES('USER',$1,'TASK_COMPLETION_REQUESTED',$2)", task.PublisherID, activityID)
		if e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	jsonOut(w, 200, map[string]any{"taskId": taskID, "status": task.Status, "requestedAt": requested})
	return nil
}
func (a *App) confirmCompletion(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "USER")
	if e != nil {
		return e
	}
	if e = a.taskRate(r, user.ID, "write"); e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
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
	task, e := db.New(tx).TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	if task.PublisherID != user.ID {
		return fail(403, "FORBIDDEN")
	}
	if task.Status != "IN_PROGRESS" {
		return fail(409, "TASK_NOT_IN_PROGRESS")
	}
	var count int
	e = tx.QueryRow(r.Context(), "SELECT count(*) FROM task_activities WHERE task_id=$1 AND type='TASK_COMPLETION_REQUESTED'", taskID).Scan(&count)
	if e != nil {
		return e
	}
	if count == 0 {
		return fail(409, "COMPLETION_NOT_REQUESTED")
	}
	success, e := a.Tasks.Transition(r.Context(), tx, taskID, "IN_PROGRESS", "COMPLETED")
	if e != nil {
		return e
	}
	if !success {
		return fail(409, "TASK_CONFLICT")
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO task_activities(task_id,actor_id,type) VALUES($1,$2,'TASK_COMPLETED')", taskID, user.ID)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	task.Status = "COMPLETED"
	task.UpdatedAt = pgtype.Timestamptz{Time: time.Now(), Valid: true}
	view, e := a.privateTask(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func (a *App) adminTask(w http.ResponseWriter, r *http.Request) error {
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	task, e := a.Q.TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	view, e := a.adminTaskRow(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func (a *App) adminTaskRow(ctx context.Context, task db.Task) (map[string]any, error) {
	view, e := a.privateTask(ctx, task)
	if e != nil {
		return nil, e
	}
	publisher, e := a.Q.UserByID(ctx, task.PublisherID)
	if e != nil {
		return nil, e
	}
	var moderation any
	latest, e := a.Q.LatestModeration(ctx, task.ID)
	if e == nil {
		moderation = toModeration(latest)
	} else if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	raw, _ := json.Marshal(view)
	row := map[string]any{}
	_ = json.Unmarshal(raw, &row)
	row["publisher"] = map[string]any{"id": publisher.ID, "email": publisher.Email, "status": publisher.Status}
	row["moderation"] = moderation
	return row, nil
}
func (a *App) adminTasks(w http.ResponseWriter, r *http.Request) error {
	limit, e := queryLimit(r, 20)
	if e != nil {
		return e
	}
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "ALL"
	}
	valid := map[string]bool{"ALL": true, "PENDING_REVIEW": true, "OPEN": true, "IN_PROGRESS": true, "COMPLETED": true, "CANCELLED": true, "HUMAN_REVIEW": true}
	if !valid[view] {
		return fail(400, "VALIDATION_ERROR")
	}
	cursor := r.URL.Query().Get("cursor")
	if cursor != "" && !isID(cursor) {
		return fail(400, "VALIDATION_ERROR")
	}
	query := "SELECT " + taskColumns + " FROM tasks t WHERE ($1::uuid IS NULL OR (t.created_at,t.id)<(SELECT created_at,id FROM tasks WHERE id=$1))"
	args := []any{nullID(cursor)}
	if view == "HUMAN_REVIEW" {
		query += " AND t.status='PENDING_REVIEW' AND EXISTS(SELECT 1 FROM task_moderations m WHERE m.id=(SELECT id FROM task_moderations WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) AND (m.status='ERROR' OR (m.status='COMPLETED' AND m.decision='REVIEW')))"
	} else if view != "ALL" {
		query += " AND t.status=$2"
		args = append(args, view)
	}
	query += " ORDER BY t.created_at DESC,t.id DESC LIMIT $" + strconv.Itoa(len(args)+1)
	args = append(args, limit+1)
	rows, e := a.DB.Query(r.Context(), query, args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	tasks, e := scanTasks(rows)
	if e != nil {
		return e
	}
	var next *string
	if len(tasks) > limit {
		v := tasks[limit-1].ID
		next = &v
		tasks = tasks[:limit]
	}
	items := make([]any, 0, len(tasks))
	for _, t := range tasks {
		row, x := a.adminTaskRow(r.Context(), t)
		if x != nil {
			return x
		}
		items = append(items, row)
	}
	jsonOut(w, 200, map[string]any{"items": items, "nextCursor": next})
	return nil
}
func (a *App) dashboard(w http.ResponseWriter, r *http.Request) error {
	counts := map[string]int64{"open": 0, "inProgress": 0, "humanReview": 0}
	for key, where := range map[string]string{"open": "status='OPEN'", "inProgress": "status='IN_PROGRESS'", "humanReview": "status='PENDING_REVIEW' AND EXISTS(SELECT 1 FROM task_moderations m WHERE m.id=(SELECT id FROM task_moderations WHERE task_id=tasks.id ORDER BY created_at DESC,id DESC LIMIT 1) AND m.status IN ('ERROR','COMPLETED') AND (m.status='ERROR' OR m.decision='REVIEW'))"} {
		var count int64
		if e := a.DB.QueryRow(r.Context(), "SELECT count(*) FROM tasks WHERE "+where).Scan(&count); e != nil {
			return e
		}
		counts[key] = count
	}
	lists := map[string][]publicTask{"openTasks": {}, "inProgressTasks": {}, "reviewTasks": {}}
	for _, list := range []struct{ key, where, order string }{{"openTasks", "status='OPEN'", "created_at ASC,id ASC"}, {"inProgressTasks", "status='IN_PROGRESS'", "updated_at DESC,id DESC"}, {"reviewTasks", "status='PENDING_REVIEW' AND EXISTS(SELECT 1 FROM task_moderations m WHERE m.id=(SELECT id FROM task_moderations WHERE task_id=tasks.id ORDER BY created_at DESC,id DESC LIMIT 1) AND m.status IN ('ERROR','COMPLETED') AND (m.status='ERROR' OR m.decision='REVIEW'))", "created_at ASC,id ASC"}} {
		key := list.key
		rows, e := a.DB.Query(r.Context(), "SELECT "+taskColumns+" FROM tasks WHERE "+list.where+" ORDER BY "+list.order+" LIMIT 5")
		if e != nil {
			return e
		}
		tasks, x := scanTasks(rows)
		rows.Close()
		if x != nil {
			return x
		}
		for _, task := range tasks {
			lists[key] = append(lists[key], toPublic(task))
		}
	}
	jsonOut(w, 200, map[string]any{"counts": counts, "openTasks": lists["openTasks"], "inProgressTasks": lists["inProgressTasks"], "reviewTasks": lists["reviewTasks"]})
	return nil
}
