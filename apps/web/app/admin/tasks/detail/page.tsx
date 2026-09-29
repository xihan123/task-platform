import { Suspense } from 'react';
import { TaskIdFromQuery } from '../../../../components/task-id-from-query';

export default function TaskPage() {
  return (
    <Suspense fallback={<p role="status">正在加载任务...</p>}>
      <TaskIdFromQuery mode="admin" />
    </Suspense>
  );
}
