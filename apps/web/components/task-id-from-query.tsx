'use client';

import { useSearchParams } from 'next/navigation';
import { TaskWorkspace } from './tasks/task-workspace';
import { TaskDetail } from './admin/task-detail';

export function TaskIdFromQuery({ mode }: { mode: 'publisher' | 'admin' }) {
  const id = useSearchParams().get('id');
  if (
    !id ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      id,
    )
  ) {
    return <p role="alert">任务链接无效。</p>;
  }
  return mode === 'admin' ? (
    <TaskDetail id={id} />
  ) : (
    <TaskWorkspace mode="detail" taskId={id} />
  );
}
