package db

import (
	"context"
	"database/sql"
	"embed"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"io/fs"
)

//go:embed migrations/*.sql
var migrations embed.FS

func Migrate(ctx context.Context, url string) error {
	conn, err := sql.Open("pgx", url)
	if err != nil {
		return err
	}
	defer conn.Close()
	source, err := fs.Sub(migrations, "migrations")
	if err != nil {
		return err
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, conn, source)
	if err != nil {
		return err
	}
	_, err = provider.Up(ctx)
	return err
}
