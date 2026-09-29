package platform

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
	"taskplatform/api/internal/db"
)

func TestPasswordAndModerationValidation(t *testing.T) {
	require.True(t, validAISecret("test-provider-secret"))
	require.False(t, validAISecret("invalid\x00secret"))
	encoded, e := hashPassword("a good long password")
	require.NoError(t, e)
	app := &App{Config: Config{MailKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)), AIKey: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{4}, 32))}}
	payload, e := app.encryptMailCode("7c84128a-7f0d-4af9-8173-826403a32060", "123456")
	require.NoError(t, e)
	require.NotContains(t, payload, "123456")
	code, e := app.decryptMailCode("7c84128a-7f0d-4af9-8173-826403a32060", payload)
	require.NoError(t, e)
	require.Equal(t, "123456", code)
	_, e = app.decryptMailCode("7c84128a-7f0d-4af9-8173-826403a32061", payload)
	require.Error(t, e)
	key, e := app.encryptAI("secret-ai-key")
	require.NoError(t, e)
	require.NotContains(t, key, "secret-ai-key")
	plain, e := app.decryptAI(key)
	require.NoError(t, e)
	require.Equal(t, "secret-ai-key", plain)
	require.True(t, verifyPassword("a good long password", encoded))
	require.False(t, verifyPassword("wrong password", encoded))
	_, e = validateAI([]byte("{"+"\"decision\":\"PASS\",\"riskLevel\":\"LOW\",\"categories\":[],\"reason\":\"ok\",\"confidence\":1.1,\"categoryMatch\":true,\"suggestedType\":null}"), "office_docs")
	require.Error(t, e)
	_, e = validateAI([]byte("{"+"\"decision\":\"PASS\",\"riskLevel\":\"LOW\",\"categories\":[],\"reason\":\"ok\",\"confidence\":0.9,\"categoryMatch\":true,\"suggestedType\":null}"), "office_docs")
	require.NoError(t, e)
}
func TestTrustedProxyClientIP(t *testing.T) {
	request := httptest.NewRequest("POST", "http://example.test/api/auth/login", nil)
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("X-Forwarded-For", "198.51.100.5, 203.0.113.7")
	app := &App{Config: Config{TrustProxyHops: 1}}
	require.Equal(t, "203.0.113.7", app.clientIP(request))
	app.Config.TrustProxyHops = 0
	require.Equal(t, "127.0.0.1", app.clientIP(request))
}
func TestStrictJSONInput(t *testing.T) {
	for _, input := range []string{`{"title":"a","attachmentIds":null}`, `{"title":"a","unexpected":true}`, `null`} {
		request := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(input))
		var target taskInput
		require.Error(t, body(request, &target))
	}
	request := httptest.NewRequest("PATCH", "/api/notifications/preferences", strings.NewReader(`{"messageEmailEnabled":false}`))
	var target struct {
		Enabled *bool `json:"messageEmailEnabled"`
	}
	require.NoError(t, body(request, &target))
	require.NotNil(t, target.Enabled)
	require.False(t, *target.Enabled)
}
func TestCoreLifecycle(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	require.Contains(t, databaseURL, "task_platform_go_test")
	cfg := Config{Environment: "test", Host: "127.0.0.1", Port: 4050, DatabaseURL: databaseURL, RedisURL: os.Getenv("TEST_REDIS_URL"), RedisPrefix: "go-e2e-" + id() + ":", SessionTTL: 3600, AttachmentDir: t.TempDir(), AITimeout: 1000, AICooldown: 60, ModerationEnabled: false}
	require.NotEmpty(t, cfg.RedisURL)
	ctx := context.Background()
	require.NoError(t, db.Migrate(ctx, cfg.DatabaseURL))
	a, e := Open(ctx, cfg)
	require.NoError(t, e)
	defer a.Close()
	defer func() {
		cursor := uint64(0)
		for {
			keys, next, err := a.Redis.Scan(context.Background(), cursor, cfg.RedisPrefix+"*", 100).Result()
			if err != nil {
				return
			}
			if len(keys) > 0 {
				_ = a.Redis.Del(context.Background(), keys...).Err()
			}
			cursor = next
			if cursor == 0 {
				return
			}
		}
	}()
	var currentDB string
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT current_database()").Scan(&currentDB))
	require.Equal(t, "task_platform_go_test", currentDB)
	_, e = a.DB.Exec(ctx, "TRUNCATE attachments,notifications,task_activities,messages,conversations,task_moderations,tasks,email_codes,ai_keys,ai_models,ai_endpoints,users RESTART IDENTITY CASCADE")
	require.NoError(t, e)
	hash, e := hashPassword("integration-password-123")
	require.NoError(t, e)
	admin, e := a.Q.CreateUser(ctx, db.CreateUserParams{Email: "admin@go.test", PasswordHash: hash, Role: "ADMIN", EmailVerifiedAt: pgtype.Timestamptz{Valid: false}})
	require.NoError(t, e)
	publisher, e := a.Q.CreateUser(ctx, db.CreateUserParams{Email: "publisher@go.test", PasswordHash: hash, Role: "USER"})
	require.NoError(t, e)
	_, e = a.Q.CreateUser(ctx, db.CreateUserParams{Email: "other@go.test", PasswordHash: hash, Role: "USER"})
	require.NoError(t, e)
	server := httptest.NewUnstartedServer(a.router())
	server.Start()
	a.Config.WebOrigins = []string{server.URL}
	defer server.Close()
	makeClient := func() *http.Client {
		jar, e := cookiejar.New(nil)
		require.NoError(t, e)
		return &http.Client{Jar: jar}
	}
	adminClient := makeClient()
	publisherClient := makeClient()
	otherClient := makeClient()
	anonymous := makeClient()
	call := func(c *http.Client, method, path string, input any) (int, map[string]any) {
		var payload io.Reader
		if input != nil {
			raw, e := json.Marshal(input)
			require.NoError(t, e)
			payload = bytes.NewReader(raw)
		}
		request, e := http.NewRequest(method, server.URL+path, payload)
		require.NoError(t, e)
		if input != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		if method != "GET" {
			request.Header.Set("X-CSRF-Protection", "1")
			request.Header.Set("Origin", server.URL)
		}
		response, e := c.Do(request)
		require.NoError(t, e)
		defer response.Body.Close()
		var result map[string]any
		if response.StatusCode != 204 {
			require.NoError(t, json.NewDecoder(response.Body).Decode(&result))
		}
		return response.StatusCode, result
	}
	for _, entry := range []struct {
		client *http.Client
		email  string
	}{{adminClient, admin.Email}, {publisherClient, publisher.Email}, {otherClient, "other@go.test"}} {
		status, _ := call(entry.client, "POST", "/api/auth/login", map[string]any{"email": entry.email, "password": "integration-password-123"})
		require.Equal(t, 200, status)
	}
	unguarded, e := http.NewRequest("POST", server.URL+"/api/tasks", strings.NewReader(`{"title":"blocked"}`))
	require.NoError(t, e)
	unguarded.Header.Set("Origin", server.URL)
	csrfResponse, e := publisherClient.Do(unguarded)
	require.NoError(t, e)
	csrfResponse.Body.Close()
	require.Equal(t, 403, csrfResponse.StatusCode)
	status, created := call(publisherClient, "POST", "/api/tasks", map[string]any{"title": "Go migration", "summary": "Summary", "description": "private detail", "type": "office_docs"})
	require.Equal(t, 201, status)
	taskID := created["id"].(string)
	require.Equal(t, "PENDING_REVIEW", created["status"])
	status, public := call(anonymous, "GET", "/api/tasks/"+taskID, nil)
	require.Equal(t, 200, status)
	require.NotContains(t, public, "description")
	status, other := call(otherClient, "GET", "/api/tasks/"+taskID, nil)
	require.Equal(t, 200, status)
	require.NotContains(t, other, "description")
	status, detail := call(adminClient, "GET", "/api/admin/tasks/"+taskID, nil)
	require.Equal(t, 200, status)
	require.Equal(t, "private detail", detail["description"])
	status, _ = call(otherClient, "POST", "/api/admin/tasks/"+taskID+"/take", nil)
	require.Equal(t, 403, status)
	status, _ = call(adminClient, "POST", "/api/admin/tasks/"+taskID+"/take", nil)
	require.Equal(t, 409, status)
	var moderationID string
	require.NoError(t, a.DB.QueryRow(ctx, "UPDATE task_moderations SET status='ERROR',error_code='NO_AVAILABLE_RESOURCES',completed_at=now() WHERE task_id=$1 RETURNING id", taskID).Scan(&moderationID))
	status, reviewed := call(adminClient, "POST", "/api/admin/tasks/"+taskID+"/review", map[string]any{"moderationId": moderationID, "decision": "PASS", "reason": "Reviewed"})
	require.Equal(t, 200, status)
	require.Equal(t, "OPEN", reviewed["status"])
	start := make(chan struct{})
	var group sync.WaitGroup
	results := make(chan int, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			code, _ := call(adminClient, "POST", "/api/admin/tasks/"+taskID+"/take", nil)
			results <- code
		}()
	}
	close(start)
	group.Wait()
	close(results)
	codes := []int{}
	for code := range results {
		codes = append(codes, code)
	}
	require.ElementsMatch(t, []int{200, 409}, codes)
	status, dashboard := call(adminClient, "GET", "/api/admin/dashboard", nil)
	require.Equal(t, 200, status)
	require.Equal(t, float64(1), dashboard["counts"].(map[string]any)["inProgress"])
	serverURL, e := url.Parse(server.URL)
	require.NoError(t, e)
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/tasks/" + taskID + "/events"
	websocketHeaders := func(client *http.Client) http.Header {
		header := http.Header{}
		header.Set("Origin", server.URL)
		for _, cookie := range client.Jar.Cookies(serverURL) {
			header.Add("Cookie", cookie.String())
		}
		return header
	}
	_, deniedResponse, deniedError := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: websocketHeaders(otherClient)})
	require.Error(t, deniedError)
	require.Equal(t, 403, deniedResponse.StatusCode)
	connection, _, e := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: websocketHeaders(publisherClient)})
	require.NoError(t, e)
	defer connection.Close(websocket.StatusNormalClosure, "done")
	status, _ = call(publisherClient, "POST", "/api/tasks/"+taskID+"/messages", map[string]any{"attachmentIds": []string{id()}})
	require.Equal(t, 400, status)
	firstMessageID := id()
	for i := 0; i < 3; i++ {
		input := map[string]any{"content": "Publisher note"}
		if i == 0 {
			input["id"] = firstMessageID
		}
		status, message := call(publisherClient, "POST", "/api/tasks/"+taskID+"/messages", input)
		require.Equal(t, 201, status)
		if i == 0 {
			readCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			_, event, e := connection.Read(readCtx)
			cancel()
			require.NoError(t, e)
			var payload struct {
				Event string `json:"event"`
				Data  struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			require.NoError(t, json.Unmarshal(event, &payload))
			require.Equal(t, "message:new", payload.Event)
			require.Equal(t, message["id"], payload.Data.ID)
		}
	}
	status, duplicate := call(publisherClient, "POST", "/api/tasks/"+taskID+"/messages", map[string]any{"id": firstMessageID, "content": "Publisher note"})
	require.Equal(t, 201, status)
	require.Equal(t, firstMessageID, duplicate["id"])
	status, catchup := call(publisherClient, "GET", "/api/tasks/"+taskID+"/messages?after="+firstMessageID, nil)
	require.Equal(t, 200, status)
	require.Len(t, catchup["items"], 2)
	status, _ = call(publisherClient, "POST", "/api/tasks/"+taskID+"/messages", map[string]any{"content": "Over limit"})
	require.Equal(t, 409, status)
	status, _ = call(adminClient, "POST", "/api/tasks/"+taskID+"/messages", map[string]any{"content": "Admin reply"})
	require.Equal(t, 201, status)
	status, _ = call(publisherClient, "POST", "/api/tasks/"+taskID+"/messages", map[string]any{"content": "After reply"})
	require.Equal(t, 201, status)
	var messages, activities, notifications int
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT count(*) FROM messages").Scan(&messages))
	require.Equal(t, 5, messages)
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT count(*) FROM task_activities WHERE type='MESSAGE_SENT'").Scan(&activities))
	require.Equal(t, 5, activities)
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT count(*) FROM notifications WHERE type='TASK_MESSAGE'").Scan(&notifications))
	require.Equal(t, 5, notifications)
	status, _ = call(publisherClient, "POST", "/api/tasks/"+taskID+"/confirm-completion", nil)
	require.Equal(t, 409, status)
	status, requested := call(adminClient, "POST", "/api/admin/tasks/"+taskID+"/complete-request", nil)
	require.Equal(t, 200, status)
	require.Equal(t, "IN_PROGRESS", requested["status"])
	status, completed := call(publisherClient, "POST", "/api/tasks/"+taskID+"/confirm-completion", nil)
	require.Equal(t, 200, status)
	require.Equal(t, "COMPLETED", completed["status"])
	status, _ = call(publisherClient, "POST", "/api/tasks/"+taskID+"/messages", map[string]any{"content": "after completed"})
	require.Equal(t, 409, status)
	require.NotEmpty(t, strings.TrimSpace(taskID))

	// The router fails over from a transient provider error, then records each terminal decision.
	a.Config.AIKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/bad/") {
			w.WriteHeader(503)
			return
		}
		var request struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Messages) < 2 {
			w.WriteHeader(400)
			return
		}
		text := request.Messages[1].Content
		if strings.Contains(text, "ai-error") {
			w.WriteHeader(503)
			return
		}
		decision := "PASS"
		if strings.Contains(text, "ai-review") {
			decision = "REVIEW"
		}
		if strings.Contains(text, "ai-reject") {
			decision = "REJECT"
		}
		result, _ := json.Marshal(map[string]any{"decision": decision, "riskLevel": "LOW", "categories": []string{}, "reason": "checked", "confidence": 0.95, "categoryMatch": true, "suggestedType": nil})
		if decision == "PASS" {
			w.Header().Set("Content-Type", "text/event-stream")
			chunk, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": string(result)}, "finish_reason": "stop"}}})
			_, _ = fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", chunk)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(result)}, "finish_reason": "stop"}}})
	}))
	defer provider.Close()
	secret, e := a.encryptAI("mock-api-key-123")
	require.NoError(t, e)
	for n, path := range []string{"bad", "good"} {
		endpointID := fmt.Sprintf("00000000-0000-4000-8000-%012d", n+1)
		modelID := fmt.Sprintf("00000000-0000-4000-8001-%012d", n+1)
		keyID := fmt.Sprintf("00000000-0000-4000-8002-%012d", n+1)
		_, e = a.DB.Exec(ctx, "INSERT INTO ai_endpoints(id,base_url) VALUES($1,$2)", endpointID, provider.URL+"/"+path+"/")
		require.NoError(t, e)
		_, e = a.DB.Exec(ctx, "INSERT INTO ai_models(id,endpoint_id,name) VALUES($1,$2,'mock')", modelID, endpointID)
		require.NoError(t, e)
		_, e = a.DB.Exec(ctx, "INSERT INTO ai_keys(id,endpoint_id,encrypted_key,fingerprint,last4) VALUES($1,$2,$3,$4,'-123')", keyID, endpointID, secret, strings.Repeat(fmt.Sprintf("%d", n+1), 64))
		require.NoError(t, e)
	}
	var failedTaskID, failedModerationID string
	for _, entry := range []struct{ title, status, moderation string }{{"ai-pass", "OPEN", "COMPLETED"}, {"ai-review", "PENDING_REVIEW", "COMPLETED"}, {"ai-reject", "PENDING_REVIEW", "COMPLETED"}, {"ai-error", "PENDING_REVIEW", "ERROR"}} {
		_, _ = a.Redis.Del(ctx, a.Config.RedisPrefix+"ai:cooldown:00000000-0000-4000-8000-000000000001.00000000-0000-4000-8001-000000000001.00000000-0000-4000-8002-000000000001").Result()
		_, _ = a.Redis.Del(ctx, a.Config.RedisPrefix+"ai:cooldown:00000000-0000-4000-8000-000000000002.00000000-0000-4000-8001-000000000002.00000000-0000-4000-8002-000000000002").Result()
		_, e = a.Redis.Set(ctx, a.Config.RedisPrefix+"ai:round-robin", 0, 0).Result()
		require.NoError(t, e)
		status, created = call(publisherClient, "POST", "/api/tasks", map[string]any{"title": entry.title, "summary": "Summary", "description": "Description", "type": "office_docs"})
		require.Equal(t, 201, status)
		var moderationID string
		require.NoError(t, a.DB.QueryRow(ctx, "SELECT id FROM task_moderations WHERE task_id=$1", created["id"]).Scan(&moderationID))
		require.NoError(t, a.processModeration(ctx, moderationID))
		record, e := a.Q.ModerationByID(ctx, moderationID)
		require.NoError(t, e)
		require.Equal(t, entry.moderation, string(record.Status))
		require.Len(t, record.AttemptedResources, 2)
		task, e := a.Q.TaskByID(ctx, created["id"].(string))
		require.NoError(t, e)
		require.Equal(t, entry.status, string(task.Status))
		if entry.title == "ai-error" {
			failedTaskID = task.ID
			failedModerationID = moderationID
		}
	}
	status, _ = call(adminClient, "POST", "/api/admin/tasks/"+failedTaskID+"/moderations/"+failedModerationID+"/retry", nil)
	require.Equal(t, 204, status)
	retried, e := a.Q.LatestModeration(ctx, failedTaskID)
	require.NoError(t, e)
	require.Equal(t, "PENDING", string(retried.Status))
	require.NotEqual(t, failedModerationID, retried.ID)
	cooldownCount, e := a.Redis.Exists(ctx, a.Config.RedisPrefix+"ai:cooldown:00000000-0000-4000-8000-000000000001.00000000-0000-4000-8001-000000000001.00000000-0000-4000-8002-000000000001").Result()
	require.NoError(t, e)
	require.Zero(t, cooldownCount)
	status, configured := call(adminClient, "POST", "/api/admin/ai/resources", map[string]any{"baseUrl": provider.URL + "/third/", "model": "another-model", "apiKey": "test-provider-secret"})
	require.Equal(t, 201, status)
	require.Equal(t, "••••cret", configured["maskedKey"])
	serialized, _ := json.Marshal(configured)
	require.NotContains(t, string(serialized), "test-provider-secret")
	var encrypted string
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT encrypted_key FROM ai_keys WHERE id=$1", configured["keyId"]).Scan(&encrypted))
	require.NotContains(t, encrypted, "test-provider-secret")
	viaCLI, e := a.saveAIResource(ctx, aiConfigInput{BaseURL: provider.URL + "/third/", Model: "another-model", APIKey: "test-provider-secret"})
	require.NoError(t, e)
	require.Equal(t, configured["endpointId"], viaCLI.EndpointID)
	require.Equal(t, configured["modelId"], viaCLI.ModelID)
	require.Equal(t, configured["keyId"], viaCLI.KeyID)
	require.Equal(t, "••••cret", viaCLI.MaskedKey)
	// Attachment bytes remain private, and expiry denies downloads before cleanup.
	var uploadBody bytes.Buffer
	form := multipart.NewWriter(&uploadBody)
	part, e := form.CreateFormFile("file", "proof.txt")
	require.NoError(t, e)
	_, e = part.Write([]byte("private evidence"))
	require.NoError(t, e)
	require.NoError(t, form.Close())
	uploadRequest, e := http.NewRequest("POST", server.URL+"/api/attachments", &uploadBody)
	require.NoError(t, e)
	uploadRequest.Header.Set("Content-Type", form.FormDataContentType())
	uploadRequest.Header.Set("X-CSRF-Protection", "1")
	uploadRequest.Header.Set("Origin", server.URL)
	uploadResponse, e := publisherClient.Do(uploadRequest)
	require.NoError(t, e)
	defer uploadResponse.Body.Close()
	require.Equal(t, 201, uploadResponse.StatusCode)
	var uploaded map[string]any
	require.NoError(t, json.NewDecoder(uploadResponse.Body).Decode(&uploaded))
	attachmentID := uploaded["id"].(string)
	status, attachedTask := call(publisherClient, "POST", "/api/tasks", map[string]any{"title": "with attachment", "summary": "Summary", "description": "Private", "type": "office_docs", "attachmentIds": []string{attachmentID}})
	require.Equal(t, 201, status)
	require.Len(t, attachedTask["attachments"], 1)
	status, _ = call(otherClient, "GET", "/api/attachments/"+attachmentID+"/download", nil)
	require.Equal(t, 404, status)
	fileResponse, e := publisherClient.Get(server.URL + "/api/attachments/" + attachmentID + "/download")
	require.NoError(t, e)
	data, e := io.ReadAll(fileResponse.Body)
	fileResponse.Body.Close()
	require.NoError(t, e)
	require.Equal(t, 200, fileResponse.StatusCode)
	require.Equal(t, "private evidence", string(data))
	_, e = a.DB.Exec(ctx, "UPDATE attachments SET expires_at=now()-interval '1 second' WHERE id=$1", attachmentID)
	require.NoError(t, e)
	status, _ = call(publisherClient, "GET", "/api/attachments/"+attachmentID+"/download", nil)
	require.Equal(t, 410, status)
	require.NoError(t, a.cleanAttachments(ctx))
	var deleted bool
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT deleted_at IS NOT NULL FROM attachments WHERE id=$1", attachmentID).Scan(&deleted))
	require.True(t, deleted)
	// A late result from an edited task must not reopen the superseded content.
	status, staleTask := call(publisherClient, "POST", "/api/tasks", map[string]any{"title": "stale moderation", "summary": "Summary", "description": "Before edit", "type": "office_docs"})
	require.Equal(t, 201, status)
	staleTaskID := staleTask["id"].(string)
	staleModeration, e := a.Q.LatestModeration(ctx, staleTaskID)
	require.NoError(t, e)
	lease := id()
	_, e = a.DB.Exec(ctx, "UPDATE task_moderations SET status='PROCESSING',lease_token=$1,started_at=now() WHERE id=$2", lease, staleModeration.ID)
	require.NoError(t, e)
	status, _ = call(publisherClient, "PATCH", "/api/tasks/"+staleTaskID, map[string]any{"description": "After edit"})
	require.Equal(t, 200, status)
	oldReview, e := a.Q.ModerationByID(ctx, staleModeration.ID)
	require.NoError(t, e)
	require.Equal(t, "SUPERSEDED", string(oldReview.Status))
	pass := &moderationResult{Decision: "PASS", RiskLevel: "LOW", Categories: []string{}, Reason: "checked", Confidence: 0.99, CategoryMatch: true}
	require.NoError(t, a.completeModeration(ctx, oldReview, lease, pass, ""))
	staleTaskRow, e := a.Q.TaskByID(ctx, staleTaskID)
	require.NoError(t, e)
	require.Equal(t, "PENDING_REVIEW", string(staleTaskRow.Status))
	currentReview, e := a.Q.LatestModeration(ctx, staleTaskID)
	require.NoError(t, e)
	require.Equal(t, "PENDING", string(currentReview.Status))
	// Repeated SMTP failures leave the committed message and in-app notification intact.
	a.Config.EmailEnabled = true
	a.Config.SMTPHost = "127.0.0.1"
	a.Config.SMTPPort = 1
	a.Config.MailFrom = "sender@example.test"
	a.Config.AppURL = "http://localhost:3000"
	_, e = a.DB.Exec(ctx, "UPDATE users SET email_verified_at=now(),message_email_enabled=true WHERE id=$1", publisher.ID)
	require.NoError(t, e)
	var mailNotificationID string
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT id FROM notifications WHERE recipient_role='USER' AND type='TASK_MESSAGE' LIMIT 1").Scan(&mailNotificationID))
	_, e = a.DB.Exec(ctx, "UPDATE notifications SET email_status='PENDING',email_next_attempt_at=now() WHERE id=$1", mailNotificationID)
	require.NoError(t, e)
	for attempt := 1; attempt <= 3; attempt++ {
		require.NoError(t, a.deliverNotification(ctx, mailNotificationID))
		var state string
		var count int
		require.NoError(t, a.DB.QueryRow(ctx, "SELECT email_status::text,email_attempts FROM notifications WHERE id=$1", mailNotificationID).Scan(&state, &count))
		require.Equal(t, attempt, count)
		if attempt < 3 {
			require.Equal(t, "PENDING", state)
			_, e = a.DB.Exec(ctx, "UPDATE notifications SET email_next_attempt_at=now() WHERE id=$1", mailNotificationID)
			require.NoError(t, e)
		} else {
			require.Equal(t, "FAILED", state)
		}
	}
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT count(*) FROM messages").Scan(&messages))
	require.Equal(t, 5, messages)
	// Verification codes are consumed atomically and failed attempts persist.
	// Dependency outages degrade readiness and fail moderation closed; durable work is recovered on the next scan.
	healthyRedis := a.Redis
	a.Redis = redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 100 * time.Millisecond, ReadTimeout: 100 * time.Millisecond, WriteTimeout: 100 * time.Millisecond, MaxRetries: -1})
	readiness := httptest.NewRecorder()
	a.readiness(readiness, httptest.NewRequest("GET", "/api/health", nil))
	require.Equal(t, 503, readiness.Code)
	var health map[string]any
	require.NoError(t, json.Unmarshal(readiness.Body.Bytes(), &health))
	require.Equal(t, "down", health["checks"].(map[string]any)["redis"])
	failedByRedis, e := a.Q.LatestModeration(ctx, attachedTask["id"].(string))
	require.NoError(t, e)
	require.Equal(t, "PENDING", string(failedByRedis.Status))
	require.NoError(t, a.processModeration(ctx, failedByRedis.ID))
	failedByRedis, e = a.Q.ModerationByID(ctx, failedByRedis.ID)
	require.NoError(t, e)
	require.Equal(t, "ERROR", string(failedByRedis.Status))
	stillPending, e := a.Q.TaskByID(ctx, attachedTask["id"].(string))
	require.NoError(t, e)
	require.Equal(t, "PENDING_REVIEW", string(stillPending.Status))
	require.NoError(t, a.Redis.Close())
	a.Redis = healthyRedis
	_, e = a.DB.Exec(ctx, "UPDATE notifications SET email_status='PENDING',email_attempts=0,email_next_attempt_at=now() WHERE id=$1", mailNotificationID)
	require.NoError(t, e)
	a.Config.ModerationEnabled = true
	goodQueue := a.Queue
	badQueue := asynq.NewClient(asynq.RedisClientOpt{Addr: "127.0.0.1:1", DialTimeout: 100 * time.Millisecond, ReadTimeout: 100 * time.Millisecond, WriteTimeout: 100 * time.Millisecond})
	a.Queue = badQueue
	a.recoverModeration(ctx)
	a.recoverEmail(ctx)
	left, e := a.Q.LatestModeration(ctx, staleTaskID)
	require.NoError(t, e)
	require.Equal(t, "PENDING", string(left.Status))
	var emailPending string
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT email_status::text FROM notifications WHERE id=$1", mailNotificationID).Scan(&emailPending))
	require.Equal(t, "PENDING", emailPending)
	require.NoError(t, badQueue.Close())
	a.Queue = goodQueue
	a.recoverModeration(ctx)
	a.recoverEmail(ctx)
	connectionOptions, e := asynq.ParseRedisURI(cfg.RedisURL)
	require.NoError(t, e)
	inspector := asynq.NewInspector(connectionOptions)
	defer inspector.Close()
	queued, e := inspector.ListPendingTasks("default")
	require.NoError(t, e)
	foundModeration, foundMail := false, false
	for _, job := range queued {
		if job.ID == left.ID && job.Type == "task:moderation" {
			foundModeration = true
		}
		if job.ID == mailNotificationID && job.Type == "email:notification" {
			foundMail = true
		}
		if job.ID == left.ID || job.ID == retried.ID || job.ID == mailNotificationID {
			_ = inspector.DeleteTask("default", job.ID)
		}
	}
	require.True(t, foundModeration)
	require.True(t, foundMail)
	a.Config.MailKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	registrationID := id()
	_, e = a.DB.Exec(ctx, "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,'newuser@go.test','REGISTER',$2,now()+interval '10 minutes')", registrationID, a.codeHash(registrationID, "123456"))
	require.NoError(t, e)
	status, _ = call(anonymous, "POST", "/api/auth/register", map[string]any{"email": "newuser@go.test", "password": "another-long-password", "code": "000000"})
	require.Equal(t, 400, status)
	var invalidAttempts int
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT attempts FROM email_codes WHERE id=$1", registrationID).Scan(&invalidAttempts))
	require.Equal(t, 1, invalidAttempts)
	status, registered := call(anonymous, "POST", "/api/auth/register", map[string]any{"email": "newuser@go.test", "password": "another-long-password", "code": "123456"})
	require.Equal(t, 201, status)
	require.Equal(t, "newuser@go.test", registered["user"].(map[string]any)["email"])
	status, _ = call(anonymous, "POST", "/api/auth/login", map[string]any{"email": "newuser@go.test", "password": "another-long-password"})
	require.Equal(t, 200, status)
	olderSession := makeClient()
	status, _ = call(olderSession, "POST", "/api/auth/login", map[string]any{"email": "newuser@go.test", "password": "another-long-password"})
	require.Equal(t, 200, status)
	resetID := id()
	_, e = a.DB.Exec(ctx, "INSERT INTO email_codes(id,email,purpose,code_hash,expires_at) VALUES($1,'newuser@go.test','RESET_PASSWORD',$2,now()+interval '10 minutes')", resetID, a.codeHash(resetID, "654321"))
	require.NoError(t, e)
	status, _ = call(anonymous, "POST", "/api/auth/reset-password", map[string]any{"email": "newuser@go.test", "password": "changed-long-password", "code": "654321"})
	require.Equal(t, 204, status)
	status, _ = call(olderSession, "GET", "/api/auth/me", nil)
	require.Equal(t, 401, status)
	status, _ = call(anonymous, "POST", "/api/auth/login", map[string]any{"email": "newuser@go.test", "password": "another-long-password"})
	require.Equal(t, 401, status)
	status, _ = call(anonymous, "POST", "/api/auth/login", map[string]any{"email": "newuser@go.test", "password": "changed-long-password"})
	require.Equal(t, 200, status)
	a.Hub.mu.Lock()
	var live *wsClient
	for client := range a.Hub.clients[taskID] {
		live = client
	}
	a.Hub.mu.Unlock()
	require.NotNil(t, live)
	status, _ = call(publisherClient, "POST", "/api/auth/logout", nil)
	require.Equal(t, 204, status)
	require.False(t, a.wsAuthorized(ctx, live, taskID))
	status, _ = call(adminClient, "PATCH", "/api/admin/users/"+admin.ID+"/status", map[string]any{"status": "DISABLED"})
	require.Equal(t, 403, status)
	var otherUserID string
	require.NoError(t, a.DB.QueryRow(ctx, "SELECT id FROM users WHERE email='other@go.test'").Scan(&otherUserID))
	status, _ = call(adminClient, "PATCH", "/api/admin/users/"+otherUserID+"/status", map[string]any{"status": "DISABLED"})
	require.Equal(t, 200, status)
	status, _ = call(otherClient, "GET", "/api/auth/me", nil)
	require.Equal(t, 403, status)
	// A transient database outage must not revoke an otherwise valid Redis session.
	transient, e := Open(ctx, cfg)
	require.NoError(t, e)
	defer transient.Close()
	token := strings.Repeat("a", 64)
	encoded, _ := json.Marshal(map[string]any{"userId": publisher.ID, "version": 0})
	require.NoError(t, transient.Redis.Set(ctx, transient.sessionKey(token), encoded, time.Minute).Err())
	transient.DB.Close()
	temporaryServer := httptest.NewServer(transient.router())
	defer temporaryServer.Close()
	request, e := http.NewRequest("GET", temporaryServer.URL+"/api/auth/me", nil)
	require.NoError(t, e)
	request.AddCookie(&http.Cookie{Name: transient.cookieName(), Value: token})
	response, e := http.DefaultClient.Do(request)
	require.NoError(t, e)
	response.Body.Close()
	require.Equal(t, 503, response.StatusCode)
	remainingSession, e := transient.Redis.Get(ctx, transient.sessionKey(token)).Result()
	require.NoError(t, e)
	require.NotEmpty(t, remainingSession)
}
