import type { TaskStatus } from '../lib/types';
import { taskStatusLabels } from '../lib/task-presentation';
import { StatusGlyph } from './icons';

const statusClass: Record<TaskStatus, string> = {
  PENDING_REVIEW: 'st-review',
  OPEN: 'st-open',
  IN_PROGRESS: 'st-prog',
  COMPLETED: 'st-done',
  CANCELLED: 'st-cancel',
};

export function StatusBadge({
  status,
  size,
}: {
  status: TaskStatus;
  size?: 'lg';
}) {
  return (
    <span
      className={`st ${statusClass[status]}${size === 'lg' ? ' st-lg' : ''}`}
    >
      <StatusGlyph status={status} size={size === 'lg' ? 14 : 12} />
      {taskStatusLabels[status]}
    </span>
  );
}
