package platform

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"taskplatform/api/internal/db"
)

const promptVersion = "1.2.0"

//go:embed moderation/prompts/task-moderation.system.md moderation/prompts/task-moderation.user.md
var promptFS embed.FS

type moderationResult struct {
	Decision      string   `json:"decision"`
	RiskLevel     string   `json:"riskLevel"`
	Categories    []string `json:"categories"`
	Reason        string   `json:"reason"`
	Confidence    float64  `json:"confidence"`
	CategoryMatch bool     `json:"categoryMatch"`
	SuggestedType *string  `json:"suggestedType"`
}

func toModeration(record db.TaskModeration) map[string]any {
	var completed *string
	if record.CompletedAt.Valid {
		s := stamp(record.CompletedAt)
		completed = &s
	}
	return map[string]any{"id": record.ID, "taskId": record.TaskID, "status": record.Status, "source": record.Source, "reviewerId": record.ReviewerID, "promptVersion": record.PromptVersion, "decision": record.Decision, "riskLevel": record.RiskLevel, "categories": record.Categories, "reason": record.Reason, "confidence": record.Confidence, "categoryMatch": record.CategoryMatch, "suggestedType": record.SuggestedType, "errorCode": record.ErrorCode, "attempts": len(record.AttemptedResources), "createdAt": stamp(record.CreatedAt), "completedAt": completed}
}
func (a *App) scheduleModeration(ctx context.Context, tx pgx.Tx, task db.Task) (string, error) {
	_, e := tx.Exec(ctx, "UPDATE task_moderations SET status='SUPERSEDED',lease_token=NULL,completed_at=now() WHERE task_id=$1 AND status IN ('PENDING','PROCESSING')", task.ID)
	if e != nil {
		return "", e
	}
	var moderationID string
	e = tx.QueryRow(ctx, "INSERT INTO task_moderations(task_id,input_hash,prompt_version,created_at) VALUES($1,$2,$3,GREATEST(now(),COALESCE((SELECT max(created_at)+interval '1 millisecond' FROM task_moderations WHERE task_id=$1),now()))) RETURNING id", task.ID, taskHash(task), promptVersion).Scan(&moderationID)
	return moderationID, e
}
func (a *App) enqueueModeration(ctx context.Context, moderationID string) {
	if !a.Config.ModerationEnabled || a.Queue == nil {
		return
	}
	job := asynq.NewTask("task:moderation", []byte(moderationID))
	if _, e := a.Queue.EnqueueContext(ctx, job, asynq.TaskID(moderationID), asynq.MaxRetry(0)); e != nil {
		slog.Warn("moderation dispatch pending", "moderationId", moderationID)
	}
}
func (a *App) moderations(w http.ResponseWriter, r *http.Request) error {
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	_, e = a.Q.TaskByID(r.Context(), taskID)
	if errors.Is(e, pgx.ErrNoRows) {
		return fail(404, "TASK_NOT_FOUND")
	}
	if e != nil {
		return e
	}
	records, e := a.Q.ModerationHistory(r.Context(), taskID)
	if e != nil {
		return e
	}
	items := make([]any, 0, len(records))
	for _, record := range records {
		items = append(items, toModeration(record))
	}
	jsonOut(w, 200, items)
	return nil
}
func (a *App) manualReview(w http.ResponseWriter, r *http.Request) error {
	user, e := needRole(r, "ADMIN")
	if e != nil {
		return e
	}
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	var input struct {
		ModerationID string  `json:"moderationId" validate:"uuid4"`
		Decision     string  `json:"decision" validate:"oneof=PASS REJECT"`
		Reason       *string `json:"reason"`
		Type         *string `json:"type"`
	}
	if e = body(r, &input); e != nil {
		return e
	}
	if e = a.valid(input); e != nil {
		return e
	}
	if input.Reason != nil {
		reason := trimmed(*input.Reason)
		input.Reason = &reason
	}
	if input.Decision == "PASS" && (input.Reason == nil || *input.Reason == "") {
		return fail(400, "VALIDATION_ERROR")
	}
	if input.Reason != nil && len(*input.Reason) > 2000 {
		return fail(400, "VALIDATION_ERROR")
	}
	if input.Type != nil && !isConcrete(*input.Type) {
		return fail(400, "VALIDATION_ERROR")
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
	if task.Status != "PENDING_REVIEW" {
		return fail(409, "MODERATION_CONFLICT")
	}
	latest, e := db.New(tx).LatestModeration(r.Context(), taskID)
	if e != nil || latest.ID != input.ModerationID || latest.Source != "AI" || latest.InputHash != taskHash(task) || !(latest.Status == "ERROR" || latest.Status == "COMPLETED" && latest.Decision != nil && *latest.Decision == "REVIEW") {
		return fail(409, "MODERATION_CONFLICT")
	}
	selected := task.Type
	if input.Type != nil {
		selected = *input.Type
	}
	if input.Decision == "PASS" && ((latest.CategoryMatch != nil && !*latest.CategoryMatch) || !isConcrete(task.Type)) && input.Type == nil {
		return fail(400, "VALIDATION_ERROR")
	}
	if input.Decision == "PASS" && !isConcrete(selected) {
		return fail(400, "VALIDATION_ERROR")
	}
	var moderationID string
	e = tx.QueryRow(r.Context(), "INSERT INTO task_moderations(task_id,input_hash,prompt_version,status,source,reviewer_id,decision,reason,completed_at,created_at) VALUES($1,$2,'manual-v1','COMPLETED','MANUAL',$3,$4,$5,now(),GREATEST(now(),$6::timestamptz+interval '1 millisecond')) RETURNING id", taskID, taskHash(task), user.ID, input.Decision, input.Reason, latest.CreatedAt.Time).Scan(&moderationID)
	if e != nil {
		return e
	}
	if input.Decision == "PASS" {
		success, x := a.Tasks.Transition(r.Context(), tx, taskID, "PENDING_REVIEW", "OPEN")
		if x != nil {
			return x
		}
		if !success {
			return fail(409, "MODERATION_CONFLICT")
		}
		_, e = tx.Exec(r.Context(), "UPDATE tasks SET type=$1,updated_at=now() WHERE id=$2", selected, taskID)
		if e != nil {
			return e
		}
	} else {
		_, e = tx.Exec(r.Context(), "INSERT INTO notifications(recipient_role,recipient_id,type,moderation_id) VALUES('USER',$1,'TASK_REVISION_REQUESTED',$2)", task.PublisherID, moderationID)
		if e != nil {
			return e
		}
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	task.Status = db.TaskStatus(map[bool]string{true: "OPEN", false: "PENDING_REVIEW"}[input.Decision == "PASS"])
	task.Type = selected
	view, e := a.privateTask(r.Context(), task)
	if e != nil {
		return e
	}
	jsonOut(w, 200, view)
	return nil
}
func isConcrete(category string) bool { return categories[category] && category != "other" }
func (a *App) retryModeration(w http.ResponseWriter, r *http.Request) error {
	taskID, e := paramID(r)
	if e != nil {
		return e
	}
	moderationID := chi.URLParam(r, "moderationId")
	if !isID(moderationID) {
		return fail(400, "VALIDATION_ERROR")
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
	if task.Status != "PENDING_REVIEW" {
		return fail(409, "MODERATION_CONFLICT")
	}
	latest, e := db.New(tx).LatestModeration(r.Context(), taskID)
	if e != nil || latest.ID != moderationID || latest.Status != "ERROR" || latest.Source != "AI" || latest.InputHash != taskHash(task) {
		return fail(409, "MODERATION_CONFLICT")
	}
	for _, resourceID := range latest.AttemptedResources {
		_ = a.Redis.Del(r.Context(), a.Config.RedisPrefix+"ai:cooldown:"+resourceID).Err()
	}
	nextID, e := a.scheduleModeration(r.Context(), tx, task)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	a.enqueueModeration(r.Context(), nextID)
	w.WriteHeader(204)
	return nil
}
func (a *App) recoverModeration(ctx context.Context) {
	if !a.Config.ModerationEnabled {
		return
	}
	rows, e := a.DB.Query(ctx, "SELECT id FROM task_moderations WHERE status='PENDING' OR (status='PROCESSING' AND started_at<now()-$1*interval '1 millisecond') ORDER BY created_at LIMIT 100", int(a.Config.AITimeout)*3+60000)
	if e != nil {
		return
	}
	ids := []string{}
	for rows.Next() {
		var value string
		if rows.Scan(&value) == nil {
			ids = append(ids, value)
		}
	}
	rows.Close()
	for _, value := range ids {
		a.enqueueModeration(ctx, value)
	}
}

type aiFailure struct {
	code      string
	retryable bool
}

func (f aiFailure) Error() string { return f.code }
func invalidAI() error            { return aiFailure{"INVALID_RESPONSE", true} }
func validateAI(raw []byte, selected string) (moderationResult, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 7 {
		return moderationResult{}, invalidAI()
	}
	expected := []string{"decision", "riskLevel", "categories", "reason", "confidence", "categoryMatch", "suggestedType"}
	for _, key := range expected {
		if _, ok := fields[key]; !ok {
			return moderationResult{}, invalidAI()
		}
	}
	var result moderationResult
	if json.Unmarshal(raw, &result) != nil || !slices.Contains([]string{"PASS", "REVIEW", "REJECT"}, result.Decision) || !slices.Contains([]string{"LOW", "MEDIUM", "HIGH"}, result.RiskLevel) || len(result.Categories) > 20 || result.Categories == nil || trimmed(result.Reason) == "" || len(result.Reason) > 2000 || result.Confidence < 0 || result.Confidence > 1 {
		return result, invalidAI()
	}
	for _, category := range result.Categories {
		if trimmed(category) == "" || len(category) > 80 {
			return result, invalidAI()
		}
	}
	if result.SuggestedType != nil && !isConcrete(*result.SuggestedType) {
		return result, invalidAI()
	}
	if result.CategoryMatch && (!isConcrete(selected) || result.SuggestedType != nil) {
		return result, invalidAI()
	}
	if !result.CategoryMatch && (result.Decision == "PASS" || result.SuggestedType != nil && *result.SuggestedType == selected) {
		return result, invalidAI()
	}
	// Decode into pointers too, so JSON null cannot silently become a valid zero value.
	for _, name := range []string{"decision", "riskLevel", "reason", "confidence", "categoryMatch"} {
		if string(fields[name]) == "null" {
			return result, invalidAI()
		}
	}
	return result, nil
}
func (a *App) aiReview(ctx context.Context, task db.Task, resource aiResource) (moderationResult, error) {
	system, _ := promptFS.ReadFile("moderation/prompts/task-moderation.system.md")
	userPrompt, _ := promptFS.ReadFile("moderation/prompts/task-moderation.user.md")
	categoryJSON, _ := categoryFS.ReadFile("task_categories.json")
	if !strings.HasPrefix(string(system), "Prompt-Version: "+promptVersion) || !strings.HasPrefix(string(userPrompt), "Prompt-Version: "+promptVersion) {
		return moderationResult{}, aiFailure{"CONFIG_ERROR", false}
	}
	taskJSON, _ := json.Marshal(struct {
		Title       string `json:"title"`
		Summary     string `json:"summary"`
		Description string `json:"description"`
		Type        string `json:"type"`
	}{task.Title, task.Summary, task.Description, task.Type})
	secret, e := a.decryptAI(resource.EncryptedKey)
	if e != nil {
		return moderationResult{}, aiFailure{"CONFIG_ERROR", false}
	}
	messages := []map[string]string{{"role": "system", "content": strings.ReplaceAll(string(system), "{{CATEGORY_CATALOG_JSON}}", string(categoryJSON))}, {"role": "user", "content": strings.ReplaceAll(string(userPrompt), "{{TASK_JSON}}", string(taskJSON))}}
	requestJSON, _ := json.Marshal(map[string]any{"model": resource.Model, "messages": messages, "response_format": map[string]string{"type": "json_object"}, "stream": true})
	base, e := url.Parse(resource.BaseURL)
	if e != nil {
		return moderationResult{}, aiFailure{"CONFIG_ERROR", false}
	}
	endpoint, e := base.Parse("chat/completions")
	if e != nil {
		return moderationResult{}, aiFailure{"CONFIG_ERROR", false}
	}
	timeoutCtx, cancel := context.WithTimeout(ctx, time.Duration(a.Config.AITimeout)*time.Millisecond)
	defer cancel()
	request, e := http.NewRequestWithContext(timeoutCtx, "POST", endpoint.String(), strings.NewReader(string(requestJSON)))
	if e != nil {
		return moderationResult{}, aiFailure{"CONFIG_ERROR", false}
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+secret)
	client := &http.Client{Timeout: time.Duration(a.Config.AITimeout) * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, e := client.Do(request)
	if e != nil {
		if timeoutCtx.Err() != nil {
			return moderationResult{}, aiFailure{"TIMEOUT", true}
		}
		return moderationResult{}, aiFailure{"CONNECTION_ERROR", true}
	}
	defer response.Body.Close()
	if response.StatusCode == 429 {
		return moderationResult{}, aiFailure{"RATE_LIMITED", true}
	}
	if response.StatusCode == 408 || response.StatusCode == 499 {
		return moderationResult{}, aiFailure{"TIMEOUT", true}
	}
	if response.StatusCode >= 500 {
		return moderationResult{}, aiFailure{"SERVER_ERROR", true}
	}
	if response.StatusCode >= 300 {
		return moderationResult{}, aiFailure{"PROVIDER_REJECTED", false}
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 262145))
	if e != nil || len(raw) > 262144 {
		return moderationResult{}, invalidAI()
	}
	var content []byte
	if strings.Contains(response.Header.Get("Content-Type"), "text/event-stream") || strings.HasPrefix(string(raw), "data:") {
		var b strings.Builder
		done := false
		finished := false
		for _, block := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n\n") {
			lines := []string{}
			for _, line := range strings.Split(block, "\n") {
				if strings.HasPrefix(line, "data:") {
					lines = append(lines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
				}
			}
			if len(lines) == 0 {
				continue
			}
			data := strings.Join(lines, "\n")
			if data == "[DONE]" {
				done = true
				break
			}
			var envelope struct {
				Choices []struct {
					Delta struct {
						Content *string `json:"content"`
						Refusal any     `json:"refusal"`
					} `json:"delta"`
					Finish *string `json:"finish_reason"`
				} `json:"choices"`
			}
			if json.Unmarshal([]byte(data), &envelope) != nil || len(envelope.Choices) == 0 {
				return moderationResult{}, invalidAI()
			}
			choice := envelope.Choices[0]
			if choice.Delta.Refusal != nil {
				return moderationResult{}, invalidAI()
			}
			if choice.Delta.Content != nil {
				b.WriteString(*choice.Delta.Content)
			}
			if choice.Finish != nil {
				if *choice.Finish != "stop" {
					return moderationResult{}, invalidAI()
				}
				finished = true
			}
		}
		if !done || !finished || b.Len() == 0 {
			return moderationResult{}, invalidAI()
		}
		content = []byte(b.String())
	} else {
		var envelope struct {
			Choices []struct {
				Message struct {
					Content *string `json:"content"`
					Refusal any     `json:"refusal"`
				} `json:"message"`
				Finish string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal(raw, &envelope) != nil || len(envelope.Choices) == 0 || envelope.Choices[0].Message.Content == nil || envelope.Choices[0].Message.Refusal != nil || envelope.Choices[0].Finish == "length" {
			return moderationResult{}, invalidAI()
		}
		content = []byte(*envelope.Choices[0].Message.Content)
	}
	result, e := validateAI(content, task.Type)
	if e != nil {
		return result, e
	}
	if strings.Contains(result.Reason, secret) {
		return result, invalidAI()
	}
	for _, category := range result.Categories {
		if strings.Contains(category, secret) {
			return result, invalidAI()
		}
	}
	return result, nil
}
func (a *App) processModeration(ctx context.Context, moderationID string) error {
	if !isID(moderationID) {
		return nil
	}
	lease := id()
	tag, e := a.DB.Exec(ctx, "UPDATE task_moderations SET status='PROCESSING',started_at=now(),lease_token=$1 WHERE id=$2 AND (status='PENDING' OR (status='PROCESSING' AND started_at<now()-$3*interval '1 millisecond'))", lease, moderationID, int(a.Config.AITimeout)*3+60000)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	record, e := a.Q.ModerationByID(ctx, moderationID)
	if e != nil {
		return e
	}
	task, e := a.Q.TaskByID(ctx, record.TaskID)
	if e != nil {
		return e
	}
	if task.Status != "PENDING_REVIEW" || record.InputHash != taskHash(task) {
		return a.completeModeration(ctx, record, lease, nil, "SUPERSEDED")
	}
	if record.PromptVersion != promptVersion {
		return a.completeModeration(ctx, record, lease, nil, "CONFIG_ERROR")
	}
	resources, e := a.resources(ctx)
	if e != nil {
		return a.completeModeration(ctx, record, lease, nil, "ROUTER_UNAVAILABLE")
	}
	var result *moderationResult
	lastError := "NO_AVAILABLE_RESOURCES"
	attempted := append([]string{}, record.AttemptedResources...)
	if len(resources) > 0 {
		start, e := a.Redis.Incr(ctx, a.Config.RedisPrefix+"ai:round-robin").Result()
		if e != nil {
			return a.completeModeration(ctx, record, lease, nil, "ROUTER_UNAVAILABLE")
		}
		for offset := 0; offset < len(resources) && len(attempted) < 3; offset++ {
			resource := resources[(int(start-1)+offset)%len(resources)]
			resourceID := resource.EndpointID + "." + resource.ModelID + "." + resource.KeyID
			if slices.Contains(attempted, resourceID) {
				continue
			}
			cooldown, e := a.Redis.Exists(ctx, a.Config.RedisPrefix+"ai:cooldown:"+resourceID).Result()
			if e != nil {
				return a.completeModeration(ctx, record, lease, nil, "ROUTER_UNAVAILABLE")
			}
			if cooldown > 0 {
				continue
			}
			tag, e := a.DB.Exec(ctx, "UPDATE task_moderations SET attempted_resources=array_append(attempted_resources,$1) WHERE id=$2 AND lease_token=$3 AND status='PROCESSING' AND cardinality(attempted_resources)<3 AND NOT ($1=ANY(attempted_resources))", resourceID, moderationID, lease)
			if e != nil {
				return e
			}
			if tag.RowsAffected() == 0 {
				return nil
			}
			attempted = append(attempted, resourceID)
			started := time.Now()
			answer, x := a.aiReview(ctx, task, resource)
			if x == nil {
				result = &answer
				slog.Info("ai review", "requestId", moderationID, "userId", task.PublisherID, "taskId", task.ID, "action", "task.moderation", "endpointId", resource.EndpointID, "modelId", resource.ModelID, "keyId", resource.KeyID, "attempt", len(attempted), "latency", time.Since(started).Milliseconds(), "status", answer.Decision)
				break
			}
			var f aiFailure
			if errors.As(x, &f) {
				lastError = f.code
			} else {
				lastError = "INVALID_RESPONSE"
			}
			slog.Warn("ai review", "requestId", moderationID, "userId", task.PublisherID, "taskId", task.ID, "action", "task.moderation", "endpointId", resource.EndpointID, "modelId", resource.ModelID, "keyId", resource.KeyID, "attempt", len(attempted), "latency", time.Since(started).Milliseconds(), "status", lastError)
			if a.Redis.Set(ctx, a.Config.RedisPrefix+"ai:cooldown:"+resourceID, "1", time.Duration(a.Config.AICooldown)*time.Second).Err() != nil {
				lastError = "ROUTER_UNAVAILABLE"
				break
			}
			if !f.retryable {
				break
			}
		}
	}
	return a.completeModeration(ctx, record, lease, result, lastError)
}
func (a *App) completeModeration(ctx context.Context, record db.TaskModeration, lease string, result *moderationResult, code string) error {
	tx, e := a.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = lockTask(ctx, tx, record.TaskID); e != nil {
		return e
	}
	task, e := db.New(tx).TaskByID(ctx, record.TaskID)
	if e != nil {
		return e
	}
	var storedHash, status string
	var actualLease *string
	e = tx.QueryRow(ctx, "SELECT input_hash,lease_token,status::text FROM task_moderations WHERE id=$1", record.ID).Scan(&storedHash, &actualLease, &status)
	if e != nil {
		return e
	}
	if status != "PROCESSING" || actualLease == nil || *actualLease != lease {
		return nil
	}
	if task.Status != "PENDING_REVIEW" || storedHash != taskHash(task) {
		code = "SUPERSEDED"
		result = nil
	}
	if code == "SUPERSEDED" {
		_, e = tx.Exec(ctx, "UPDATE task_moderations SET status='SUPERSEDED',lease_token=NULL,completed_at=now() WHERE id=$1 AND lease_token=$2", record.ID, lease)
		if e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if result == nil {
		_, e = tx.Exec(ctx, "UPDATE task_moderations SET status='ERROR',error_code=$1,lease_token=NULL,completed_at=now() WHERE id=$2 AND lease_token=$3", code, record.ID, lease)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "INSERT INTO notifications(type,moderation_id) VALUES('TASK_MODERATION_ERROR',$1) ON CONFLICT(moderation_id) DO NOTHING", record.ID)
		if e != nil {
			return e
		}
	} else {
		_, e = tx.Exec(ctx, "UPDATE task_moderations SET status='COMPLETED',decision=$1,risk_level=$2,categories=$3,reason=$4,confidence=$5,category_match=$6,suggested_type=$7,lease_token=NULL,completed_at=now() WHERE id=$8 AND lease_token=$9", result.Decision, result.RiskLevel, result.Categories, result.Reason, result.Confidence, result.CategoryMatch, result.SuggestedType, record.ID, lease)
		if e != nil {
			return e
		}
		if result.Decision == "REVIEW" {
			_, e = tx.Exec(ctx, "INSERT INTO notifications(type,moderation_id) VALUES('TASK_MODERATION_REVIEW',$1) ON CONFLICT(moderation_id) DO NOTHING", record.ID)
			if e != nil {
				return e
			}
		}
		if result.Decision == "REJECT" {
			_, e = tx.Exec(ctx, "INSERT INTO notifications(type,moderation_id,recipient_role,recipient_id) VALUES('TASK_REVISION_REQUESTED',$1,'USER',$2) ON CONFLICT(moderation_id) DO NOTHING", record.ID, task.PublisherID)
			if e != nil {
				return e
			}
		}
		if result.Decision == "PASS" && result.CategoryMatch && isConcrete(task.Type) {
			ok, x := a.Tasks.Transition(ctx, tx, task.ID, "PENDING_REVIEW", "OPEN")
			if x != nil {
				return x
			}
			if !ok {
				return fail(409, "MODERATION_CONFLICT")
			}
		}
	}
	return tx.Commit(ctx)
}
