import { TaskWorkspace } from '../../components/tasks/task-workspace';
import { Suspense } from 'react';

export default function TasksPage() {
  return (
    <Suspense fallback={<p role="status">正在加载任务...</p>}>
      <TaskWorkspace mode="list" />
    </Suspense>
  );
}
