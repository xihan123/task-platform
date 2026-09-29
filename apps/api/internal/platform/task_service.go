package platform

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// TaskService owns every task status transition.
type TaskService struct{}

func (TaskService) Transition(ctx context.Context, tx pgx.Tx, taskID, from, to string) (bool, error) {
	allowed := map[string]map[string]bool{
		"PENDING_REVIEW": {"OPEN": true, "CANCELLED": true},
		"OPEN":           {"IN_PROGRESS": true, "CANCELLED": true},
		"IN_PROGRESS":    {"COMPLETED": true, "CANCELLED": true},
	}
	if !allowed[from][to] {
		return false, fail(409, "TASK_CONFLICT")
	}
	tag, err := tx.Exec(ctx, "UPDATE tasks SET status=$1,updated_at=now() WHERE id=$2 AND status=$3", to, taskID, from)
	return tag.RowsAffected() == 1, err
}
