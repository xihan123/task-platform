package platform

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
	"taskplatform/api/internal/db"
)

func Open(ctx context.Context, cfg Config) (*App, error) {
	pool, e := pgxpool.New(ctx, cfg.DatabaseURL)
	if e != nil {
		return nil, errors.New("database connection unavailable")
	}
	options, e := redis.ParseURL(cfg.RedisURL)
	if e != nil {
		pool.Close()
		return nil, errors.New("invalid Redis URL")
	}
	options.DialTimeout = time.Second
	options.ReadTimeout = time.Second
	options.WriteTimeout = time.Second
	client := redis.NewClient(options)
	queueOpt, e := asynq.ParseRedisURI(cfg.RedisURL)
	if e != nil {
		pool.Close()
		_ = client.Close()
		return nil, errors.New("invalid Redis queue URL")
	}
	app := &App{Config: cfg, DB: pool, Q: db.New(pool), Redis: client, Queue: asynq.NewClient(queueOpt), Validate: validator.New(), Hub: newHub()}
	return app, nil
}
func (a *App) Close() { _ = a.Queue.Close(); _ = a.Redis.Close(); a.DB.Close() }
func Run(ctx context.Context, cfg Config) error {
	if e := db.Migrate(ctx, cfg.DatabaseURL); e != nil {
		return fmt.Errorf("database migration failed: %w", e)
	}
	app, e := Open(ctx, cfg)
	if e != nil {
		return e
	}
	defer app.Close()
	if e = os.MkdirAll(cfg.AttachmentDir, 0700); e != nil {
		return errors.New("attachment storage unavailable")
	}
	queueOpt, e := asynq.ParseRedisURI(cfg.RedisURL)
	if e != nil {
		return e
	}
	workerContext, stopWorker := context.WithCancel(ctx)
	defer stopWorker()
	workerDone := make(chan struct{})
	go func() {
		defer close(workerDone)
		for workerContext.Err() == nil {
			server := asynq.NewServer(queueOpt, asynq.Config{Concurrency: 4, Queues: map[string]int{"default": 1}})
			if err := server.Start(asynq.HandlerFunc(app.asynqHandler)); err == nil {
				<-workerContext.Done()
				server.Shutdown()
				return
			}
			slog.Warn("queue worker restarting", "status", "RETRY_PENDING")
			select {
			case <-workerContext.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}()
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				app.recoverModeration(ctx)
				app.recoverEmail(ctx)
				_ = app.cleanAttachments(ctx)
			}
		}
	}()
	httpServer := &http.Server{Addr: cfg.Host + ":" + strconv.Itoa(cfg.Port), Handler: app.router(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	slog.Info("api ready", "status", "STARTED", "port", cfg.Port)
	e = httpServer.ListenAndServe()
	stopWorker()
	<-workerDone
	if errors.Is(e, http.ErrServerClosed) {
		return nil
	}
	return e
}
func SeedAdmin(ctx context.Context, cfg Config, email, password string) error {
	if e := db.Migrate(ctx, cfg.DatabaseURL); e != nil {
		return e
	}
	app, e := Open(ctx, cfg)
	if e != nil {
		return e
	}
	defer app.Close()
	return app.seedAdmin(ctx, email, password)
}
func ConfigureAI(ctx context.Context, cfg Config, base, model, secret string) error {
	if e := db.Migrate(ctx, cfg.DatabaseURL); e != nil {
		return e
	}
	app, e := Open(ctx, cfg)
	if e != nil {
		return e
	}
	defer app.Close()
	_, e = app.saveAIResource(ctx, aiConfigInput{BaseURL: base, Model: model, APIKey: secret})
	return e
}
func Healthcheck(cfg Config) error {
	client := &http.Client{Timeout: 3 * time.Second}
	response, e := client.Get("http://127.0.0.1:" + strconv.Itoa(cfg.Port) + "/api/health")
	if e != nil {
		return e
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return errors.New("api not ready")
	}
	return nil
}
func Main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	cfg, e := LoadConfig()
	if e != nil {
		slog.Error("configuration invalid", "reason", e, "status", "FAILED")
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	command := "serve"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	switch command {
	case "serve":
		e = Run(ctx, cfg)
	case "migrate":
		e = db.Migrate(ctx, cfg.DatabaseURL)
	case "seed-admin":
		e = SeedAdmin(ctx, cfg, os.Getenv("ADMIN_EMAIL"), os.Getenv("ADMIN_PASSWORD"))
	case "configure-ai":
		e = ConfigureAI(ctx, cfg, os.Getenv("AI_BASE_URL"), os.Getenv("AI_MODEL"), os.Getenv("AI_API_KEY"))
	case "healthcheck":
		e = Healthcheck(cfg)
	default:
		e = errors.New("unknown command")
	}
	if e != nil {
		slog.Error("command failed", "action", command, "reason", e, "status", "FAILED")
		os.Exit(1)
	}
}
