package platform

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5"
	mail "github.com/wneessen/go-mail"
)

func (a *App) sendMail(to, subject, message, recordID string) error {
	if !a.Config.EmailEnabled {
		return fail(503, "EMAIL_UNAVAILABLE")
	}
	options := []mail.Option{mail.WithPort(a.Config.SMTPPort), mail.WithTimeout(10 * time.Second)}
	if a.Config.SMTPSecure {
		options = append(options, mail.WithSSL())
	} else if a.Config.SMTPRequireTLS {
		options = append(options, mail.WithTLSPolicy(mail.TLSMandatory))
	} else {
		options = append(options, mail.WithTLSPolicy(mail.NoTLS))
	}
	if a.Config.SMTPUser != "" {
		options = append(options, mail.WithSMTPAuth(mail.SMTPAuthAutoDiscover), mail.WithUsername(a.Config.SMTPUser), mail.WithPassword(a.Config.SMTPPassword))
	}
	client, e := mail.NewClient(a.Config.SMTPHost, options...)
	if e != nil {
		return errors.New("SMTP configuration unavailable")
	}
	msg := mail.NewMsg()
	if e = msg.From(a.Config.MailFrom); e != nil {
		return errors.New("SMTP sender invalid")
	}
	if e = msg.AddTo(to); e != nil {
		return errors.New("SMTP recipient invalid")
	}
	msg.Subject(subject)
	msg.SetBodyString(mail.TypeTextPlain, message)
	host, _ := url.Parse(a.Config.AppURL)
	msg.SetMessageIDWithValue(recordID + "@" + host.Hostname())
	if e = client.DialAndSend(msg); e != nil {
		slog.Warn("SMTP send failed", "requestId", recordID, "status", "FAILED")
		return errors.New("SMTP delivery unavailable")
	}
	return nil
}
func (a *App) deliverCode(ctx context.Context, payload []byte) error {
	parts := strings.SplitN(string(payload), ":", 2)
	if len(parts) != 2 || !isID(parts[0]) {
		return nil
	}
	record, e := a.Q.EmailCodeByID(ctx, parts[0])
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	if record.ConsumedAt.Valid || record.Attempts >= 5 || !record.ExpiresAt.Time.After(time.Now()) {
		return nil
	}
	user, e := a.Q.UserByEmail(ctx, record.Email)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return e
	}
	if record.Purpose == "REGISTER" && e == nil {
		return nil
	}
	if record.Purpose != "REGISTER" && (e != nil || user.Status != "ACTIVE") {
		return nil
	}
	if record.Purpose == "VERIFY_EMAIL" && user.EmailVerifiedAt.Valid {
		return nil
	}
	code, e := a.decryptMailCode(record.ID, parts[1])
	if e != nil {
		return errors.New("encrypted code invalid")
	}
	expected, _ := hex.DecodeString(record.CodeHash)
	actual, _ := hex.DecodeString(a.codeHash(record.ID, code))
	if len(code) != 6 || subtle.ConstantTimeCompare(expected, actual) != 1 {
		return errors.New("email code integrity failed")
	}
	purpose := map[string]string{"REGISTER": "注册", "RESET_PASSWORD": "重置密码", "VERIFY_EMAIL": "验证邮箱"}[string(record.Purpose)]
	return a.sendMail(record.Email, "任务协作平台"+purpose+"验证码", fmt.Sprintf("您的%s验证码为：%s\n验证码自申请起 10 分钟内有效。请勿向他人透露。若非本人操作，请忽略此邮件。", purpose, code), record.ID)
}
func (a *App) enqueueNotification(ctx context.Context, notificationID string) {
	if !a.Config.EmailEnabled || a.Queue == nil {
		return
	}
	task := asynq.NewTask("email:notification", []byte(notificationID))
	if _, e := a.Queue.EnqueueContext(ctx, task, asynq.TaskID(notificationID), asynq.MaxRetry(0)); e != nil {
		slog.Warn("notification dispatch pending", "requestId", notificationID)
	}
}
func (a *App) deliverNotification(ctx context.Context, notificationID string) error {
	if !isID(notificationID) {
		return nil
	}
	lease := id()
	var attempts int
	e := a.DB.QueryRow(ctx, "UPDATE notifications SET email_status='PROCESSING',email_attempts=email_attempts+1,email_lease_token=$1,email_lease_until=now()+interval '2 minutes' WHERE id=$2 AND type='TASK_MESSAGE' AND email_attempts<3 AND ((email_status='PENDING' AND email_next_attempt_at<=now()) OR (email_status='PROCESSING' AND email_lease_until<=now())) RETURNING email_attempts", lease, notificationID).Scan(&attempts)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	var recipientID, email, role, taskID, senderID, publisherID string
	var active, verified, subscribed bool
	e = a.DB.QueryRow(ctx, "SELECT u.id,u.email,u.role::text,u.status='ACTIVE',u.email_verified_at IS NOT NULL,u.message_email_enabled,c.task_id,m.sender_id,t.publisher_id FROM notifications n JOIN messages m ON n.message_id=m.id JOIN conversations c ON c.id=m.conversation_id JOIN tasks t ON t.id=c.task_id JOIN users u ON (n.recipient_id=u.id OR (n.recipient_role='ADMIN' AND u.role='ADMIN')) WHERE n.id=$1 AND n.email_lease_token=$2", notificationID, lease).Scan(&recipientID, &email, &role, &active, &verified, &subscribed, &taskID, &senderID, &publisherID)
	status := "SKIPPED"
	if e == nil && active && verified && subscribed && senderID != recipientID && (role == "ADMIN" || recipientID == publisherID) && !a.online(ctx, recipientID) {
		path := "/tasks/detail?id=" + url.QueryEscape(taskID) + "#discussion"
		if role == "ADMIN" {
			path = "/admin/tasks/detail?id=" + url.QueryEscape(taskID)
		}
		settings := "/settings"
		if role == "ADMIN" {
			settings = "/admin/settings"
		}
		message := "您有一条新的任务聊天消息。\n登录查看：" + a.Config.AppURL + path + "\n\n管理邮件订阅：" + a.Config.AppURL + settings
		if err := a.sendMail(email, "任务协作平台：您有一条新消息", message, notificationID); err == nil {
			status = "SENT"
		} else if attempts >= 3 {
			status = "FAILED"
		} else {
			status = "PENDING"
		}
	} else if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		status = "PENDING"
	}
	next := any(nil)
	if status == "PENDING" {
		next = time.Now().Add(time.Duration(5*1<<uint(attempts-1)) * time.Second)
	}
	var sentAt any
	if status == "SENT" {
		sentAt = time.Now()
	}
	_, e = a.DB.Exec(ctx, "UPDATE notifications SET email_status=$1,email_next_attempt_at=$2,email_lease_token=NULL,email_lease_until=NULL,email_sent_at=COALESCE($5::timestamptz,email_sent_at) WHERE id=$3 AND email_lease_token=$4", status, next, notificationID, lease, sentAt)
	if e != nil {
		return e
	}
	slog.Info("email deliver", "requestId", notificationID, "userId", recipientID, "taskId", taskID, "status", status)
	return nil
}
func (a *App) recoverEmail(ctx context.Context) {
	if !a.Config.EmailEnabled {
		return
	}
	_, _ = a.DB.Exec(ctx, "UPDATE notifications SET email_status='FAILED',email_lease_token=NULL,email_lease_until=NULL WHERE email_status='PROCESSING' AND email_attempts>=3 AND email_lease_until<=now()")
	rows, e := a.DB.Query(ctx, "SELECT id FROM notifications WHERE (email_status='PENDING' AND email_next_attempt_at<=now()) OR (email_status='PROCESSING' AND email_lease_until<=now()) ORDER BY created_at LIMIT 100")
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
		a.enqueueNotification(ctx, value)
	}
}
func (a *App) asynqHandler(ctx context.Context, task *asynq.Task) error {
	switch task.Type() {
	case "task:moderation":
		if err := a.processModeration(ctx, string(task.Payload())); err != nil {
			slog.Warn("moderation recovery pending", "status", "PENDING")
		}
		return nil
	case "email:code":
		return a.deliverCode(ctx, task.Payload())
	case "email:notification":
		if err := a.deliverNotification(ctx, string(task.Payload())); err != nil {
			slog.Warn("email recovery pending", "status", "PENDING")
		}
		return nil
	default:
		return nil
	}
}
