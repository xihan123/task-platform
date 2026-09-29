package platform

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	mailaddress "net/mail"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"

	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
)

type Config struct {
	Environment       string   `env:"NODE_ENV" envDefault:"development"`
	Host              string   `env:"API_HOST" envDefault:"127.0.0.1"`
	Port              int      `env:"API_PORT" envDefault:"4000"`
	TrustProxyHops    int      `env:"TRUST_PROXY_HOPS" envDefault:"0"`
	DatabaseURL       string   `env:"DATABASE_URL,required"`
	RedisURL          string   `env:"REDIS_URL,required"`
	RedisPrefix       string   `env:"REDIS_KEY_PREFIX" envDefault:"task-platform:"`
	WebOrigins        []string `env:"WEB_ORIGINS" envSeparator:"," envDefault:"http://localhost:3000,http://127.0.0.1:3000"`
	SessionTTL        int      `env:"SESSION_TTL_SECONDS" envDefault:"604800"`
	AIKey             string   `env:"AI_KEY_ENCRYPTION_KEY"`
	AITimeout         int      `env:"AI_TIMEOUT_MS" envDefault:"120000"`
	AICooldown        int      `env:"AI_COOLDOWN_SECONDS" envDefault:"60"`
	ModerationEnabled bool     `env:"MODERATION_ENABLED" envDefault:"true"`
	EmailEnabled      bool     `env:"EMAIL_ENABLED" envDefault:"false"`
	SMTPHost          string   `env:"SMTP_HOST"`
	SMTPPort          int      `env:"SMTP_PORT" envDefault:"587"`
	SMTPSecure        bool     `env:"SMTP_SECURE" envDefault:"false"`
	SMTPRequireTLS    bool     `env:"SMTP_REQUIRE_TLS" envDefault:"true"`
	SMTPUser          string   `env:"SMTP_USER"`
	SMTPPassword      string   `env:"SMTP_PASSWORD"`
	MailFrom          string   `env:"MAIL_FROM"`
	AppURL            string   `env:"APP_URL" envDefault:"http://localhost:3000"`
	MailKey           string   `env:"MAIL_ENCRYPTION_KEY"`
	AttachmentDir     string   `env:"ATTACHMENT_STORAGE_DIR" envDefault:".data/attachments"`
}

func LoadConfig() (Config, error) {
	if os.Getenv("NODE_ENV") != "production" {
		_ = godotenv.Load("../../.env")
		_ = godotenv.Overload(".env")
	}
	var cfg Config
	if err := env.Parse(&cfg); err != nil {
		return cfg, fmt.Errorf("invalid environment configuration: %w", err)
	}
	if databaseURL, err := url.Parse(cfg.DatabaseURL); err == nil {
		query := databaseURL.Query()
		if schema := query.Get("schema"); schema != "" {
			if !regexp.MustCompile("^[a-zA-Z_][a-zA-Z0-9_]*$").MatchString(schema) {
				return cfg, errors.New("invalid DATABASE_URL schema")
			}
			query.Del("schema")
			if schema != "public" {
				query.Set("search_path", schema)
			}
			databaseURL.RawQuery = query.Encode()
			cfg.DatabaseURL = databaseURL.String()
		}
	}
	if cfg.Port < 1 || cfg.Port > 65535 || cfg.TrustProxyHops < 0 || cfg.TrustProxyHops > 1 || cfg.SessionTTL < 60 || cfg.SessionTTL > 2592000 || cfg.AITimeout < 100 || cfg.AITimeout > 600000 || cfg.AICooldown < 1 || cfg.AICooldown > 3600 {
		return cfg, errors.New("invalid numeric configuration")
	}
	if cfg.SMTPPort < 1 || cfg.SMTPPort > 65535 || !regexp.MustCompile("^[a-zA-Z0-9:_-]{1,80}$").MatchString(cfg.RedisPrefix) {
		return cfg, errors.New("invalid SMTP port or Redis prefix")
	}
	if cfg.AIKey != "" {
		key, err := base64.StdEncoding.DecodeString(cfg.AIKey)
		if err != nil || len(key) != 32 {
			return cfg, errors.New("invalid AI_KEY_ENCRYPTION_KEY")
		}
	}
	for _, entry := range []struct {
		value   string
		schemes []string
	}{{cfg.DatabaseURL, []string{"postgres", "postgresql"}}, {cfg.RedisURL, []string{"redis", "rediss"}}} {
		parsed, err := url.Parse(entry.value)
		if err != nil || parsed.Host == "" || !slices.Contains(entry.schemes, parsed.Scheme) {
			return cfg, errors.New("invalid database or Redis URL")
		}
	}
	if net.ParseIP(cfg.Host) == nil {
		return cfg, errors.New("API_HOST must be an IP address")
	}
	if cfg.Environment == "production" {
		if !filepath.IsAbs(cfg.AttachmentDir) {
			return cfg, errors.New("production attachment directory must be absolute")
		}
		if len(cfg.WebOrigins) == 0 {
			return cfg, errors.New("WEB_ORIGINS is required")
		}
		for _, origin := range cfg.WebOrigins {
			parsed, err := url.Parse(origin)
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.String() != origin {
				return cfg, errors.New("WEB_ORIGINS must contain HTTPS origins")
			}
		}
	}
	if cfg.EmailEnabled {
		if cfg.SMTPHost == "" || cfg.MailFrom == "" || cfg.MailKey == "" || (cfg.SMTPUser == "") != (cfg.SMTPPassword == "") {
			return cfg, errors.New("invalid SMTP configuration")
		}
		address, err := mailaddress.ParseAddress(cfg.MailFrom)
		if err != nil || address.Address != cfg.MailFrom {
			return cfg, errors.New("invalid MAIL_FROM")
		}
		if key, err := base64.StdEncoding.DecodeString(cfg.MailKey); err != nil || len(key) != 32 {
			return cfg, errors.New("invalid MAIL_ENCRYPTION_KEY")
		}
		if cfg.Environment == "production" && (cfg.SMTPUser == "" || (!cfg.SMTPSecure && !cfg.SMTPRequireTLS)) {
			return cfg, errors.New("production SMTP requires credentials and TLS")
		}
		if parsed, err := url.Parse(cfg.AppURL); err != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil || (cfg.Environment == "production" && parsed.Scheme != "https") || parsed.String() != cfg.AppURL {
			return cfg, errors.New("invalid APP_URL")
		}
	}
	return cfg, nil
}
