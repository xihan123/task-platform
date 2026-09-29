package platform

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"taskplatform/api/internal/db"
)

type App struct {
	Config   Config
	DB       *pgxpool.Pool
	Q        *db.Queries
	Redis    *redis.Client
	Queue    *asynq.Client
	Validate *validator.Validate
	Hub      *hub
	Tasks    TaskService
}
type apiError struct {
	Status  int
	Code    string
	Message string
}

func (e apiError) Error() string { return e.Code }

var apiMessages = map[string]string{
	"VALIDATION_ERROR": "请求参数无效", "UNAUTHENTICATED": "请先登录", "FORBIDDEN": "无权执行此操作",
	"ACCOUNT_DISABLED": "账号已停用", "INVALID_CREDENTIALS": "邮箱或密码错误", "INVALID_EMAIL_CODE": "验证码无效或已过期",
	"EMAIL_IN_USE": "邮箱已注册", "EMAIL_UNAVAILABLE": "邮件服务暂时不可用", "RATE_LIMITED": "操作过于频繁，请稍后重试",
	"AUTH_UNAVAILABLE": "登录服务暂时不可用", "TASKS_UNAVAILABLE": "任务操作暂时不可用",
	"CHAT_UNAVAILABLE": "讨论暂时不可用", "ATTACHMENT_UNAVAILABLE": "附件服务暂时不可用",
	"TASK_NOT_FOUND": "任务不存在", "TASK_NOT_AVAILABLE": "任务当前不可接取", "TASK_NOT_EDITABLE": "任务当前不可编辑",
	"TASK_NOT_CANCELLABLE": "任务当前不可取消", "TASK_CONFLICT": "任务已更新，请刷新后重试", "TASK_NOT_IN_PROGRESS": "任务未在进行中",
	"COMPLETION_NOT_REQUESTED": "管理员尚未请求完成", "CHAT_READ_ONLY": "任务结束后无法发送消息",
	"CHAT_REPLY_LIMIT": "请等待管理员回复，最多连续发送 3 条消息", "CONVERSATION_FORBIDDEN": "只有发布者和管理员可以进入讨论",
	"ATTACHMENT_NOT_FOUND": "附件不存在", "ATTACHMENT_EXPIRED": "附件已过期删除", "ATTACHMENT_TOO_LARGE": "文件超过当前上限",
	"AI_CONFIG_INVALID": "AI 资源配置无效", "MODERATION_CONFLICT": "审核状态已变化，请刷新后重试",
}

func fail(status int, code string) error {
	message := apiMessages[code]
	if message == "" {
		message = "请求失败"
	}
	return apiError{status, code, message}
}
func remapUnavailable(err error, code string) error {
	var api apiError
	if errors.As(err, &api) && api.Status == 503 {
		return fail(503, code)
	}
	return err
}
func id() string         { return uuid.NewString() }
func isID(s string) bool { x, e := uuid.Parse(s); return e == nil && x.Version() == 4 }
func jsonOut(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func body(r *http.Request, dst any) error {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, 1<<20))
	if err != nil {
		return fail(400, "VALIDATION_ERROR")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return fail(400, "VALIDATION_ERROR")
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return fail(400, "VALIDATION_ERROR")
		}
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return fail(400, "VALIDATION_ERROR")
	}
	if err := dec.Decode(new(any)); !errors.Is(err, io.EOF) {
		return fail(400, "VALIDATION_ERROR")
	}
	return nil
}
func (a *App) valid(v any) error {
	if a.Validate.Struct(v) != nil {
		return fail(400, "VALIDATION_ERROR")
	}
	return nil
}

type handler func(http.ResponseWriter, *http.Request) error

func wrap(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			var e apiError
			if !errors.As(err, &e) {
				var pg *pgconn.PgError
				if errors.As(err, &pg) {
					slog.Error("request failed", "requestId", requestID(r), "action", r.Method, "status", 500, "databaseCode", pg.Code, "constraint", pg.ConstraintName)
				} else {
					slog.Error("request failed", "requestId", requestID(r), "action", r.Method, "status", 500)
				}
				e = apiError{500, "INTERNAL_ERROR", "Internal server error"}
			}
			jsonOut(w, e.Status, map[string]string{"code": e.Code, "message": e.Message, "requestId": requestID(r)})
		}
	}
}

type ctxKey int

const (
	actorKey ctxKey = iota
	requestKey
	traceKey
)

type requestTrace struct{ userID, taskID string }
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	return w.ResponseWriter.Write(data)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func requestID(r *http.Request) string { v, _ := r.Context().Value(requestKey).(string); return v }

type actor struct {
	ID, Email, Role, Status string
	SessionVersion          int32
}

func current(r *http.Request) *actor { v, _ := r.Context().Value(actorKey).(*actor); return v }
func needUser(r *http.Request) (*actor, error) {
	x := current(r)
	if x == nil {
		return nil, fail(401, "UNAUTHENTICATED")
	}
	if x.Status != "ACTIVE" {
		return nil, fail(403, "ACCOUNT_DISABLED")
	}
	return x, nil
}
func needRole(r *http.Request, role string) (*actor, error) {
	x, e := needUser(r)
	if e != nil {
		return nil, e
	}
	if x.Role != role {
		return nil, fail(403, "FORBIDDEN")
	}
	return x, nil
}
func (a *App) router() http.Handler {
	r := chi.NewRouter()
	r.Use(a.requestContext, a.cors, a.csrf, a.authenticate)
	r.Get("/api/health/live", func(w http.ResponseWriter, r *http.Request) {
		jsonOut(w, 200, map[string]any{"status": "ok", "service": "api"})
	})
	r.Get("/api/health", a.readiness)
	r.Route("/api", func(r chi.Router) {
		r.Post("/auth/register", wrap(a.register))
		r.Post("/auth/register-code", wrap(a.registerCode))
		r.Post("/auth/password-reset-code", wrap(a.resetCode))
		r.Post("/auth/reset-password", wrap(a.resetPassword))
		r.Post("/auth/email-verification-code", wrap(a.verifyCodeRequest))
		r.Post("/auth/verify-email", wrap(a.verifyEmail))
		r.Post("/auth/login", wrap(a.login))
		r.Get("/auth/me", wrap(a.me))
		r.Post("/auth/logout", wrap(a.logout))
		r.Get("/tasks", wrap(a.listTasks))
		r.Get("/tasks/public-stats", wrap(a.publicStats))
		r.Post("/tasks", wrap(a.createTask))
		r.Get("/tasks/{id}", wrap(a.getTask))
		r.Patch("/tasks/{id}", wrap(a.editTask))
		r.Post("/tasks/{id}/cancel", wrap(a.cancelTask))
		r.Get("/tasks/{id}/completion", wrap(a.completion))
		r.Post("/tasks/{id}/confirm-completion", wrap(a.confirmCompletion))
		r.Get("/tasks/{id}/messages", wrap(a.listMessages))
		r.Post("/tasks/{id}/messages", wrap(a.sendMessage))
		r.Get("/tasks/{id}/events", wrap(a.events))
		r.Get("/conversations", wrap(a.conversations))
		r.Get("/notifications", wrap(a.notifications))
		r.Get("/notifications/preferences", wrap(a.preferences))
		r.Patch("/notifications/preferences", wrap(a.updatePreferences))
		r.Post("/notifications/presence", wrap(a.presence))
		r.Delete("/notifications/presence", wrap(a.leavePresence))
		r.Get("/attachments/policy", wrap(a.attachmentPolicy))
		r.Post("/attachments", wrap(a.upload))
		r.Delete("/attachments/{id}", wrap(a.deleteAttachment))
		r.Get("/attachments/{id}/download", wrap(a.download))
		r.Route("/admin", func(r chi.Router) {
			r.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if _, e := needRole(r, "ADMIN"); e != nil {
						var api apiError
						_ = errors.As(e, &api)
						jsonOut(w, api.Status, map[string]string{"code": api.Code, "message": api.Message, "requestId": requestID(r)})
						return
					}
					next.ServeHTTP(w, r)
				})
			})
			r.Get("/dashboard", wrap(a.dashboard))
			r.Get("/tasks", wrap(a.adminTasks))
			r.Get("/tasks/{id}", wrap(a.adminTask))
			r.Post("/tasks/{id}/take", wrap(a.take))
			r.Post("/tasks/{id}/complete-request", wrap(a.requestCompletion))
			r.Post("/tasks/{id}/review", wrap(a.manualReview))
			r.Post("/tasks/{id}/moderations/{moderationId}/retry", wrap(a.retryModeration))
			r.Get("/tasks/{id}/moderations", wrap(a.moderations))
			r.Get("/users", wrap(a.users))
			r.Patch("/users/{id}/status", wrap(a.userStatus))
			r.Get("/ai/config", wrap(a.aiConfig))
			r.Get("/ai/resources", wrap(a.aiResources))
			r.Post("/ai/resources", wrap(a.configureAI))
			r.Post("/ai/endpoints/{id}/models", wrap(a.addAIModel))
			r.Post("/ai/endpoints/{id}/keys", wrap(a.addAIKey))
			r.Patch("/ai/endpoints/{id}", wrap(a.toggleAIEndpoint))
			r.Patch("/ai/models/{id}", wrap(a.toggleAIModel))
			r.Patch("/ai/keys/{id}", wrap(a.toggleAIKey))
			r.Get("/notifications", wrap(a.adminNotifications))
			r.Get("/settings/attachments", wrap(a.attachmentPolicy))
			r.Patch("/settings/attachments", wrap(a.configureAttachmentPolicy))
		})
	})
	r.NotFound(wrap(func(http.ResponseWriter, *http.Request) error { return fail(404, "NOT_FOUND") }))
	return r
}
func (a *App) requestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := id()
		trace := &requestTrace{}
		ctx := context.WithValue(context.WithValue(r.Context(), requestKey, reqID), traceKey, trace)
		w.Header().Set("X-Request-Id", reqID)
		w.Header().Set("Cache-Control", "no-store")
		start := time.Now()
		tracked := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(tracked, r.WithContext(ctx))
		status := tracked.status
		if status == 0 {
			status = 200
		}
		taskID := trace.taskID
		if strings.HasPrefix(r.URL.Path, "/api/tasks/") || strings.HasPrefix(r.URL.Path, "/api/admin/tasks/") {
			taskID = chi.URLParam(r, "id")
		}
		slog.Info("request", "requestId", reqID, "userId", trace.userID, "taskId", taskID, "action", r.Method, "status", status, "latency", time.Since(start).Milliseconds())
	})
}
func (a *App) clientIP(r *http.Request) string {
	if a.Config.TrustProxyHops == 1 {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		last := strings.TrimSpace(parts[len(parts)-1])
		if net.ParseIP(last) != nil {
			return last
		}
	}
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		return r.RemoteAddr
	}
	return host
}
func (a *App) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		for _, allowed := range a.Config.WebOrigins {
			if origin == allowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Vary", "Origin")
				break
			}
		}
		if r.Method == "OPTIONS" {
			w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,POST,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type,X-CSRF-Protection")
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			origin := r.Header.Get("Origin")
			ok := origin == ""
			for _, x := range a.Config.WebOrigins {
				if origin == x {
					ok = true
				}
			}
			if r.Header.Get("X-CSRF-Protection") != "1" || !ok {
				jsonOut(w, 403, map[string]string{"code": "CSRF_REJECTED", "message": "Invalid request origin", "requestId": requestID(r)})
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func (a *App) readiness(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	pg := "up"
	rd := "up"
	if a.DB.Ping(ctx) != nil {
		pg = "down"
	}
	if a.Redis.Ping(ctx).Err() != nil {
		rd = "down"
	}
	status := "ok"
	code := 200
	if pg != "up" || rd != "up" {
		status = "degraded"
		code = 503
	}
	jsonOut(w, code, map[string]any{"status": status, "service": "api", "checks": map[string]string{"postgres": pg, "redis": rd}})
}
func queryLimit(r *http.Request, defaultLimit int) (int, error) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultLimit, nil
	}
	n, e := strconv.Atoi(raw)
	if e != nil || n < 1 || n > 100 {
		return 0, fail(400, "VALIDATION_ERROR")
	}
	return n, nil
}
func paramID(r *http.Request) (string, error) {
	v := chi.URLParam(r, "id")
	if !isID(v) {
		return "", fail(400, "VALIDATION_ERROR")
	}
	return v, nil
}
func trimmed(s string) string { return strings.TrimSpace(s) }
