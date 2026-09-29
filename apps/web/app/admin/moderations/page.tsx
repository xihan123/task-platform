import { Suspense } from 'react';
import { TasksList } from '../../../components/admin/tasks-list';
import { Loading } from '../../../components/admin/common';

export default function ModerationsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TasksList moderation />
    </Suspense>
  );
}
