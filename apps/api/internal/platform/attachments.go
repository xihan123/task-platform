package platform

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"taskplatform/api/internal/db"
)

type attachmentDTO struct {
	ID        string `json:"id"`
	FileName  string `json:"fileName"`
	Size      int64  `json:"size"`
	CreatedAt string `json:"createdAt"`
	ExpiresAt string `json:"expiresAt"`
	Deleted   bool   `json:"deleted"`
}

func toAttachment(file db.Attachment) attachmentDTO {
	return attachmentDTO{file.ID, file.FileName, file.Size, stamp(file.CreatedAt), stamp(file.ExpiresAt), file.DeletedAt.Valid || !file.ExpiresAt.Time.After(time.Now())}
}
func validAttachmentIDs(ids []string) error {
	if len(ids) > 10 {
		return fail(400, "VALIDATION_ERROR")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !isID(id) || seen[id] {
			return fail(400, "VALIDATION_ERROR")
		}
		seen[id] = true
	}
	return nil
}
func (a *App) attachmentPath(id string) string { return filepath.Join(a.Config.AttachmentDir, id) }
func (a *App) attachmentPolicy(w http.ResponseWriter, r *http.Request) error {
	row, e := a.Q.AttachmentPolicy(r.Context())
	if e != nil {
		return e
	}
	jsonOut(w, 200, map[string]int32{"retentionDays": row.RetentionDays, "maxSizeMb": row.MaxSizeMb})
	return nil
}
func (a *App) configureAttachmentPolicy(w http.ResponseWriter, r *http.Request) error {
	var in struct {
		RetentionDays int32 `json:"retentionDays" validate:"min=1,max=36500"`
		MaxSizeMb     int32 `json:"maxSizeMb" validate:"min=1"`
	}
	if e := body(r, &in); e != nil {
		return e
	}
	if e := a.valid(in); e != nil {
		return e
	}
	_, e := a.DB.Exec(r.Context(), "UPDATE attachment_policy SET retention_days=$1,max_size_mb=$2 WHERE id=1", in.RetentionDays, in.MaxSizeMb)
	if e != nil {
		return e
	}
	jsonOut(w, 200, map[string]int32{"retentionDays": in.RetentionDays, "maxSizeMb": in.MaxSizeMb})
	return nil
}
func (a *App) upload(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	if e = a.rate(r, "attachment:rate:"+user.ID, 60, time.Minute); e != nil {
		return remapUnavailable(e, "ATTACHMENT_UNAVAILABLE")
	}
	policy, e := a.Q.AttachmentPolicy(r.Context())
	if e != nil {
		return e
	}
	fileID := id()
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", "attachments:"+user.ID); e != nil {
		return e
	}
	var draftCount int
	e = tx.QueryRow(r.Context(), "SELECT count(*) FROM attachments WHERE uploader_id=$1 AND task_id IS NULL AND deleted_at IS NULL AND expires_at>now() AND created_at>now()-interval '1 day'", user.ID).Scan(&draftCount)
	if e != nil {
		return e
	}
	if draftCount >= 10 {
		return fail(409, "ATTACHMENT_DRAFT_LIMIT")
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO attachments(id,uploader_id,file_name,ready,size,expires_at) VALUES($1,$2,'',false,0,now()+interval '1 day')", fileID, user.ID)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	completed := false
	defer func() {
		if completed {
			return
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = a.DB.Exec(cleanup, "UPDATE attachments SET expires_at=to_timestamp(0) WHERE id=$1", fileID)
		_ = a.purgeAttachment(cleanup, fileID)
	}()
	maxBytes := int64(policy.MaxSizeMb) * 1024 * 1024
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes+(1<<20))
	multipart, e := r.MultipartReader()
	if e != nil {
		return fail(400, "VALIDATION_ERROR")
	}
	part, e := multipart.NextPart()
	if e != nil {
		return fail(400, "VALIDATION_ERROR")
	}
	if part.FormName() != "file" || part.FileName() == "" {
		return fail(400, "VALIDATION_ERROR")
	}
	fileName := strings.TrimSpace(filepath.Base(strings.ReplaceAll(part.FileName(), "\\", "/")))
	fileName = strings.Map(func(ch rune) rune {
		if ch < 32 || ch == 127 {
			return -1
		}
		return ch
	}, fileName)
	if fileName == "" {
		fileName = "attachment"
	}
	if len([]rune(fileName)) > 255 {
		fileName = string([]rune(fileName)[:255])
	}
	path := a.attachmentPath(fileID)
	file, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return fail(503, "ATTACHMENT_UNAVAILABLE")
	}
	size, e := io.Copy(file, io.LimitReader(part, maxBytes+1))
	closeErr := file.Close()
	if e != nil || closeErr != nil {
		return fail(503, "ATTACHMENT_UNAVAILABLE")
	}
	if size > maxBytes {
		return fail(413, "ATTACHMENT_TOO_LARGE")
	}
	if extra, e := multipart.NextPart(); e != io.EOF || extra != nil {
		return fail(400, "VALIDATION_ERROR")
	}
	var row db.Attachment
	e = a.DB.QueryRow(r.Context(), "UPDATE attachments SET file_name=$1,ready=true,size=$2,created_at=now(),expires_at=now()+$3*interval '1 day' WHERE id=$4 RETURNING id,uploader_id,task_id,message_id,file_name,ready,size,created_at,expires_at,deleted_at", fileName, size, policy.RetentionDays, fileID).Scan(&row.ID, &row.UploaderID, &row.TaskID, &row.MessageID, &row.FileName, &row.Ready, &row.Size, &row.CreatedAt, &row.ExpiresAt, &row.DeletedAt)
	if e != nil {
		return e
	}
	completed = true
	jsonOut(w, 201, toAttachment(row))
	return nil
}
func (a *App) bindAttachments(ctx context.Context, tx pgx.Tx, userID, taskID, messageID string, ids []string) error {
	if e := validAttachmentIDs(ids); e != nil {
		return e
	}
	ordered := append([]string(nil), ids...)
	sort.Strings(ordered)
	for _, attachmentID := range ordered {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", "attachment:"+attachmentID); e != nil {
			return e
		}
		row, e := db.New(tx).AttachmentByID(ctx, attachmentID)
		if errors.Is(e, pgx.ErrNoRows) {
			return fail(409, "ATTACHMENT_INVALID")
		}
		if e != nil {
			return e
		}
		if messageID == "" && row.TaskID != nil && *row.TaskID == taskID && row.MessageID == nil {
			continue
		}
		if row.UploaderID != userID || row.TaskID != nil || !row.Ready || row.DeletedAt.Valid || !row.ExpiresAt.Time.After(time.Now()) || time.Since(row.CreatedAt.Time) > 24*time.Hour {
			return fail(409, "ATTACHMENT_INVALID")
		}
		var message any
		if messageID != "" {
			message = messageID
		}
		_, e = tx.Exec(ctx, "UPDATE attachments SET task_id=$1,message_id=$2 WHERE id=$3", taskID, message, attachmentID)
		if e != nil {
			return e
		}
	}
	return nil
}
func (a *App) replaceBodyAttachments(ctx context.Context, tx pgx.Tx, userID, taskID string, ids []string) error {
	if e := a.bindAttachments(ctx, tx, userID, taskID, "", ids); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, "UPDATE attachments SET task_id=NULL,expires_at=to_timestamp(0) WHERE task_id=$1 AND message_id IS NULL AND NOT(id=ANY($2::uuid[]))", taskID, ids)
	return e
}
func (a *App) deleteAttachment(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	attachmentID, e := paramID(r)
	if e != nil {
		return e
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if _, e = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", "attachment:"+attachmentID); e != nil {
		return e
	}
	row, e := db.New(tx).AttachmentByID(r.Context(), attachmentID)
	if e != nil || row.UploaderID != user.ID || row.TaskID != nil {
		return fail(403, "ATTACHMENT_FORBIDDEN")
	}
	_, e = tx.Exec(r.Context(), "UPDATE attachments SET expires_at=to_timestamp(0) WHERE id=$1", attachmentID)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	_ = a.purgeAttachment(r.Context(), attachmentID)
	w.WriteHeader(204)
	return nil
}
func (a *App) download(w http.ResponseWriter, r *http.Request) error {
	user, e := needUser(r)
	if e != nil {
		return e
	}
	attachmentID, e := paramID(r)
	if e != nil {
		return e
	}
	row, e := a.Q.AttachmentByID(r.Context(), attachmentID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "ATTACHMENT_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	if row.TaskID != nil {
		task, x := a.Q.TaskByID(r.Context(), *row.TaskID)
		if x != nil {
			return fail(404, "ATTACHMENT_NOT_FOUND")
		}
		if user.Role != "ADMIN" && task.PublisherID != user.ID {
			return fail(404, "ATTACHMENT_NOT_FOUND")
		}
	} else if row.UploaderID != user.ID {
		return fail(404, "ATTACHMENT_NOT_FOUND")
	}
	if !row.Ready || row.DeletedAt.Valid || !row.ExpiresAt.Time.After(time.Now()) || (row.TaskID == nil && time.Since(row.CreatedAt.Time) > 24*time.Hour) {
		return fail(410, "ATTACHMENT_EXPIRED")
	}
	file, e := os.Open(a.attachmentPath(attachmentID))
	if e != nil {
		return fail(410, "ATTACHMENT_EXPIRED")
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(row.Size, 10))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", "attachment; filename=\"attachment\"; filename*=UTF-8''"+url.PathEscape(row.FileName))
	_, _ = io.Copy(w, file)
	return nil
}
func (a *App) purgeAttachment(ctx context.Context, attachmentID string) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))", "attachment:"+attachmentID); e != nil {
		return e
	}
	row, e := db.New(tx).AttachmentByID(ctx, attachmentID)
	if e != nil {
		return e
	}
	if row.DeletedAt.Valid {
		return nil
	}
	if row.ExpiresAt.Time.After(time.Now()) && ((row.TaskID != nil) || (row.Ready && time.Since(row.CreatedAt.Time) < 24*time.Hour) || (!row.Ready && time.Since(row.CreatedAt.Time) < time.Hour)) {
		return nil
	}
	if e = os.Remove(a.attachmentPath(attachmentID)); e != nil && !os.IsNotExist(e) {
		return e
	}
	_, e = tx.Exec(ctx, "UPDATE attachments SET deleted_at=now() WHERE id=$1", attachmentID)
	if e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (a *App) cleanAttachments(ctx context.Context) error {
	rows, e := a.DB.Query(ctx, "SELECT id FROM attachments WHERE deleted_at IS NULL AND (expires_at<=now() OR (task_id IS NULL AND created_at<=now()-interval '1 day') OR (NOT ready AND created_at<=now()-interval '1 hour')) ORDER BY id LIMIT 100")
	if e != nil {
		return e
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if err := a.purgeAttachment(ctx, id); err != nil {
			slog.Warn("attachment cleanup pending", "attachmentId", id, "status", "RETRY_PENDING")
		}
	}
	files, err := os.ReadDir(a.Config.AttachmentDir)
	if err != nil {
		return err
	}
	for _, file := range files {
		if !isID(file.Name()) || file.IsDir() {
			continue
		}
		info, err := file.Info()
		if err != nil || time.Since(info.ModTime()) < 24*time.Hour {
			continue
		}
		var exists bool
		if err = a.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM attachments WHERE id=$1)", file.Name()).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			_ = os.Remove(a.attachmentPath(file.Name()))
		}
	}
	return nil
}
