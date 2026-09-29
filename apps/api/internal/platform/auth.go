package platform

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
	"golang.org/x/crypto/scrypt"
	"taskplatform/api/internal/db"
)

type credentials struct {
	Email    string `json:"email" validate:"required,email,max=254"`
	Password string `json:"password" validate:"min=12,max=128"`
}
type registerInput struct {
	Email    string `json:"email" validate:"required,email,max=254"`
	Password string `json:"password" validate:"min=12,max=128"`
	Code     string `json:"code" validate:"required,len=6,numeric"`
}
type emailInput struct {
	Email string `json:"email" validate:"required,email,max=254"`
}
type codeInput struct {
	Code string `json:"code" validate:"required,len=6,numeric"`
}
type userDTO struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	Status    string `json:"status"`
	CreatedAt string `json:"createdAt"`
}

func toUser(u db.User) userDTO {
	return userDTO{u.ID, u.Email, string(u.Role), string(u.Status), u.CreatedAt.Time.UTC().Format(time.RFC3339Nano)}
}

var passwordRE = regexp.MustCompile(`^scrypt\$32768\$8\$3\$([a-f0-9]{32})\$([a-f0-9]{128})$`)

const dummyPassword = "scrypt$32768$8$3$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, e := rand.Read(salt); e != nil {
		return "", e
	}
	hash, e := scrypt.Key([]byte(password), salt, 32768, 8, 3, 64)
	if e != nil {
		return "", e
	}
	return fmt.Sprintf("scrypt$32768$8$3$%x$%x", salt, hash), nil
}
func verifyPassword(password, encoded string) bool {
	parts := passwordRE.FindStringSubmatch(encoded)
	if len(parts) != 3 {
		return false
	}
	salt, _ := hex.DecodeString(parts[1])
	expected, _ := hex.DecodeString(parts[2])
	key, e := scrypt.Key([]byte(password), salt, 32768, 8, 3, 64)
	return e == nil && subtle.ConstantTimeCompare(key, expected) == 1
}
func (a *App) cookieName() string {
	if a.Config.Environment == "production" {
		return "__Host-task_platform_session"
	}
	return "task_platform_session"
}
func (a *App) cookieToken(r *http.Request) string {
	c, e := r.Cookie(a.cookieName())
	if e != nil {
		return ""
	}
	if len(c.Value) != 64 {
		return ""
	}
	_, e = hex.DecodeString(c.Value)
	if e != nil {
		return ""
	}
	return c.Value
}
func (a *App) sessionKey(token string) string {
	h := sha256.Sum256([]byte(token))
	return a.Config.RedisPrefix + "auth:session:" + hex.EncodeToString(h[:])
}
func (a *App) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := a.cookieToken(r)
		if token == "" {
			next.ServeHTTP(w, r)
			return
		}
		value, e := a.Redis.Get(r.Context(), a.sessionKey(token)).Result()
		if e != nil && !errors.Is(e, redis.Nil) {
			jsonOut(w, 503, map[string]string{"code": "AUTH_UNAVAILABLE", "message": "Authentication is temporarily unavailable", "requestId": requestID(r)})
			return
		}
		if e != nil {
			next.ServeHTTP(w, r)
			return
		}
		var session struct {
			UserID  string `json:"userId"`
			Version int32  `json:"version"`
		}
		if json.Unmarshal([]byte(value), &session) != nil || !isID(session.UserID) {
			next.ServeHTTP(w, r)
			return
		}
		row, e := a.Q.UserByID(r.Context(), session.UserID)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			jsonOut(w, 503, map[string]string{"code": "AUTH_UNAVAILABLE", "message": apiMessages["AUTH_UNAVAILABLE"], "requestId": requestID(r)})
			return
		}
		if row.Status == "DISABLED" {
			_ = a.Redis.Del(r.Context(), a.sessionKey(token)).Err()
			jsonOut(w, 403, map[string]string{"code": "ACCOUNT_DISABLED", "message": apiMessages["ACCOUNT_DISABLED"], "requestId": requestID(r)})
			return
		}
		if e != nil || row.Status != "ACTIVE" || row.SessionVersion != session.Version {
			_ = a.Redis.Del(r.Context(), a.sessionKey(token)).Err()
			next.ServeHTTP(w, r)
			return
		}
		x := &actor{row.ID, row.Email, string(row.Role), string(row.Status), row.SessionVersion}
		if trace, ok := r.Context().Value(traceKey).(*requestTrace); ok {
			trace.userID = row.ID
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), actorKey, x)))
	})
}
func (a *App) createSession(ctx context.Context, w http.ResponseWriter, user db.User, old string) error {
	tokenBytes := make([]byte, 32)
	if _, e := rand.Read(tokenBytes); e != nil {
		return e
	}
	token := hex.EncodeToString(tokenBytes)
	encoded, _ := json.Marshal(map[string]any{"userId": user.ID, "version": user.SessionVersion})
	if e := a.Redis.Set(ctx, a.sessionKey(token), encoded, time.Duration(a.Config.SessionTTL)*time.Second).Err(); e != nil {
		return fail(503, "AUTH_UNAVAILABLE")
	}
	if old != "" {
		_ = a.Redis.Del(ctx, a.sessionKey(old)).Err()
	}
	http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Value: token, Path: "/", HttpOnly: true, Secure: a.Config.Environment == "production", SameSite: http.SameSiteLaxMode, MaxAge: a.Config.SessionTTL})
	return nil
}
func (a *App) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: a.cookieName(), Path: "/", HttpOnly: true, Secure: a.Config.Environment == "production", SameSite: http.SameSiteLaxMode, MaxAge: -1})
}
func normalizeEmail(x string) string { return strings.ToLower(strings.TrimSpace(x)) }
func (a *App) authRate(r *http.Request, email string) error {
	ipHash := sha256.Sum256([]byte(a.clientIP(r)))
	if err := a.rate(r, "auth:rate:ip:"+hex.EncodeToString(ipHash[:]), 30, 15*time.Minute); err != nil {
		return err
	}
	if email != "" {
		emailHash := sha256.Sum256([]byte(email))
		return a.rate(r, "auth:rate:email:"+hex.EncodeToString(emailHash[:]), 10, 15*time.Minute)
	}
	return nil
}
func (a *App) login(w http.ResponseWriter, r *http.Request) error {
	var in credentials
	if e := body(r, &in); e != nil {
		return e
	}
	in.Email = normalizeEmail(in.Email)
	if e := a.valid(in); e != nil {
		return e
	}
	if e := a.authRate(r, in.Email); e != nil {
		return e
	}
	user, e := a.Q.UserByEmail(r.Context(), in.Email)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	hash := dummyPassword
	if e == nil {
		hash = user.PasswordHash
	}
	if !verifyPassword(in.Password, hash) || e != nil {
		return fail(401, "INVALID_CREDENTIALS")
	}
	if user.Status != "ACTIVE" {
		return fail(403, "ACCOUNT_DISABLED")
	}
	if e := a.createSession(r.Context(), w, user, a.cookieToken(r)); e != nil {
		return e
	}
	if trace, ok := r.Context().Value(traceKey).(*requestTrace); ok {
		trace.userID = user.ID
	}
	jsonOut(w, 200, map[string]any{"user": toUser(user)})
	return nil
}
func (a *App) me(w http.ResponseWriter, r *http.Request) error {
	x, e := needUser(r)
	if e != nil {
		return e
	}
	u, e := a.Q.UserByID(r.Context(), x.ID)
	if e != nil {
		return e
	}
	jsonOut(w, 200, map[string]any{"user": toUser(u)})
	return nil
}
func (a *App) logout(w http.ResponseWriter, r *http.Request) error {
	if token := a.cookieToken(r); token != "" {
		if e := a.Redis.Del(r.Context(), a.sessionKey(token)).Err(); e != nil {
			return fail(503, "AUTH_UNAVAILABLE")
		}
	}
	a.clearCookie(w)
	w.WriteHeader(204)
	return nil
}
func (a *App) rate(r *http.Request, key string, limit int, period time.Duration) error {
	redisKey := a.Config.RedisPrefix + key
	pipe := a.Redis.TxPipeline()
	count := pipe.Incr(r.Context(), redisKey)
	pipe.ExpireNX(r.Context(), redisKey, period)
	if _, e := pipe.Exec(r.Context()); e != nil {
		return fail(503, "AUTH_UNAVAILABLE")
	}
	if count.Val() > int64(limit) {
		return fail(429, "RATE_LIMITED")
	}
	return nil
}
func (a *App) register(w http.ResponseWriter, r *http.Request) error {
	var in registerInput
	if e := body(r, &in); e != nil {
		return e
	}
	in.Email = normalizeEmail(in.Email)
	if e := a.valid(in); e != nil {
		return e
	}
	if e := a.authRate(r, in.Email); e != nil {
		return e
	}
	hash, e := hashPassword(in.Password)
	if e != nil {
		return e
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if e = a.consumeCode(r.Context(), tx, in.Email, "REGISTER", in.Code); e != nil {
		return e
	}
	user, e := db.New(tx).CreateUser(r.Context(), db.CreateUserParams{Email: in.Email, PasswordHash: hash, Role: "USER", EmailVerifiedAt: pgtype.Timestamptz{Time: time.Now(), Valid: true}})
	if e != nil {
		var pg *pgconn.PgError
		if errors.As(e, &pg) && pg.Code == "23505" {
			return fail(409, "EMAIL_IN_USE")
		}
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	if trace, ok := r.Context().Value(traceKey).(*requestTrace); ok {
		trace.userID = user.ID
	}
	jsonOut(w, 201, map[string]any{"user": toUser(user)})
	return nil
}
func (a *App) resetPassword(w http.ResponseWriter, r *http.Request) error {
	var in registerInput
	if e := body(r, &in); e != nil {
		return e
	}
	in.Email = normalizeEmail(in.Email)
	if e := a.valid(in); e != nil {
		return e
	}
	if e := a.authRate(r, in.Email); e != nil {
		return e
	}
	hash, e := hashPassword(in.Password)
	if e != nil {
		return e
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if e = a.consumeCode(r.Context(), tx, in.Email, "RESET_PASSWORD", in.Code); e != nil {
		return e
	}
	tag, e := tx.Exec(r.Context(), "UPDATE users SET password_hash=$1,email_verified_at=now(),session_version=session_version+1,updated_at=now() WHERE email=$2 AND status='ACTIVE'", hash, in.Email)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail(400, "INVALID_EMAIL_CODE")
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	a.clearCookie(w)
	w.WriteHeader(204)
	return nil
}
func (a *App) verifyEmail(w http.ResponseWriter, r *http.Request) error {
	x, e := needUser(r)
	if e != nil {
		return e
	}
	var in codeInput
	if e = body(r, &in); e != nil {
		return e
	}
	if e = a.valid(in); e != nil {
		return e
	}
	if e = a.authRate(r, x.Email); e != nil {
		return e
	}
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	if e = a.consumeCode(r.Context(), tx, x.Email, "VERIFY_EMAIL", in.Code); e != nil {
		return e
	}
	_, e = tx.Exec(r.Context(), "UPDATE users SET email_verified_at=now(),updated_at=now() WHERE id=$1 AND status='ACTIVE'", x.ID)
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	w.WriteHeader(204)
	return nil
}
func (a *App) registerCode(w http.ResponseWriter, r *http.Request) error {
	return a.requestCode(w, r, "REGISTER")
}
func (a *App) resetCode(w http.ResponseWriter, r *http.Request) error {
	return a.requestCode(w, r, "RESET_PASSWORD")
}
func (a *App) verifyCodeRequest(w http.ResponseWriter, r *http.Request) error {
	x, e := needUser(r)
	if e != nil {
		return e
	}
	return a.issueCode(w, r, x.Email, "VERIFY_EMAIL")
}
func (a *App) requestCode(w http.ResponseWriter, r *http.Request, purpose string) error {
	var in emailInput
	if e := body(r, &in); e != nil {
		return e
	}
	in.Email = normalizeEmail(in.Email)
	if e := a.valid(in); e != nil {
		return e
	}
	return a.issueCode(w, r, in.Email, purpose)
}
func (a *App) issueCode(w http.ResponseWriter, r *http.Request, email, purpose string) error {
	if !a.Config.EmailEnabled {
		return fail(503, "EMAIL_UNAVAILABLE")
	}
	digest := sha256.Sum256([]byte(email))
	key := hex.EncodeToString(digest[:])
	if e := a.rate(r, "email:rate:email:"+key, 5, time.Hour); e != nil {
		return remapUnavailable(e, "EMAIL_UNAVAILABLE")
	}
	ipDigest := sha256.Sum256([]byte(a.clientIP(r)))
	if e := a.rate(r, "email:rate:ip:"+hex.EncodeToString(ipDigest[:]), 30, time.Hour); e != nil {
		return remapUnavailable(e, "EMAIL_UNAVAILABLE")
	}
	cooldown, e := a.Redis.SetNX(r.Context(), a.Config.RedisPrefix+"email:cooldown:"+key, "1", time.Minute).Result()
	if e != nil {
		return fail(503, "EMAIL_UNAVAILABLE")
	}
	if !cooldown {
		return fail(429, "RATE_LIMITED")
	}
	codeNumber, e := rand.Int(rand.Reader, big.NewInt(1000000))
	if e != nil {
		return e
	}
	code := fmt.Sprintf("%06d", codeNumber.Int64())
	codeID := id()
	tx, e := a.DB.Begin(r.Context())
	if e != nil {
		return e
	}
	defer tx.Rollback(r.Context())
	_, e = tx.Exec(r.Context(), "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes') ON CONFLICT(email,purpose) DO UPDATE SET id=EXCLUDED.id,code_hash=EXCLUDED.code_hash,attempts=0,created_at=now(),expires_at=EXCLUDED.expires_at,consumed_at=NULL", codeID, email, purpose, a.codeHash(codeID, code))
	if e != nil {
		return e
	}
	if e = tx.Commit(r.Context()); e != nil {
		return e
	}
	payload, e := a.encryptMailCode(codeID, code)
	if e != nil {
		return fail(503, "EMAIL_UNAVAILABLE")
	}
	task := asynq.NewTask("email:code", []byte(fmt.Sprintf("%s:%s", codeID, payload)))
	if _, e = a.Queue.EnqueueContext(r.Context(), task, asynq.TaskID(codeID), asynq.MaxRetry(2)); e != nil {
		_, _ = a.DB.Exec(r.Context(), "UPDATE email_codes SET consumed_at=now() WHERE id=$1", codeID)
		return fail(503, "EMAIL_UNAVAILABLE")
	}
	jsonOut(w, 202, map[string]string{"message": "If eligible, a verification code will be sent."})
	return nil
}
func (a *App) mailKey(context string) []byte {
	master, _ := base64.StdEncoding.DecodeString(a.Config.MailKey)
	key := hmac.New(sha256.New, master)
	key.Write([]byte(context))
	return key.Sum(nil)
}
func (a *App) codeHash(recordID, code string) string {
	h := hmac.New(sha256.New, a.mailKey("email-code-hmac"))
	h.Write([]byte(recordID + ":" + code))
	return hex.EncodeToString(h.Sum(nil))
}
func (a *App) encryptMailCode(recordID, code string) (string, error) {
	block, e := aes.NewCipher(a.mailKey("email-code-encryption"))
	if e != nil {
		return "", e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, e = rand.Read(nonce); e != nil {
		return "", e
	}
	sealed := gcm.Seal(nil, nonce, []byte(code), []byte(recordID))
	return base64.StdEncoding.EncodeToString(append(nonce, sealed...)), nil
}
func (a *App) decryptMailCode(recordID, payload string) (string, error) {
	data, e := base64.StdEncoding.DecodeString(payload)
	if e != nil {
		return "", e
	}
	block, e := aes.NewCipher(a.mailKey("email-code-encryption"))
	if e != nil {
		return "", e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	if len(data) < gcm.NonceSize()+gcm.Overhead() {
		return "", errors.New("invalid email payload")
	}
	raw, e := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], []byte(recordID))
	return string(raw), e
}
func (a *App) consumeCode(ctx context.Context, tx pgx.Tx, email, purpose, code string) error {
	record, e := db.New(tx).EmailCode(ctx, db.EmailCodeParams{Email: email, Purpose: db.EmailCodePurpose(purpose)})
	if e != nil {
		return fail(400, "INVALID_EMAIL_CODE")
	}
	if record.ConsumedAt.Valid || record.ExpiresAt.Time.Before(time.Now()) || record.Attempts >= 5 {
		return fail(400, "INVALID_EMAIL_CODE")
	}
	expected, _ := hex.DecodeString(record.CodeHash)
	actual, _ := hex.DecodeString(a.codeHash(record.ID, code))
	if subtle.ConstantTimeCompare(expected, actual) != 1 {
		_, _ = tx.Exec(ctx, "UPDATE email_codes SET attempts=LEAST(attempts+1,5) WHERE id=$1", record.ID)
		_ = tx.Commit(ctx)
		return fail(400, "INVALID_EMAIL_CODE")
	}
	_, e = tx.Exec(ctx, "UPDATE email_codes SET consumed_at=now() WHERE id=$1", record.ID)
	return e
}
func (a *App) seedAdmin(ctx context.Context, email, password string) error {
	email = normalizeEmail(email)
	in := credentials{Email: email, Password: password}
	if a.valid(in) != nil {
		return errors.New("invalid ADMIN_EMAIL or ADMIN_PASSWORD")
	}
	existing, e := a.Q.Admin(ctx)
	if e == nil {
		if existing.Email != email {
			return errors.New("another ADMIN exists")
		}
		return nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	hash, e := hashPassword(password)
	if e != nil {
		return e
	}
	_, e = a.Q.CreateUser(ctx, db.CreateUserParams{Email: email, PasswordHash: hash, Role: "ADMIN"})
	return e
}
