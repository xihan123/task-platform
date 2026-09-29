'use client';

import { AttachmentPicker } from '../attachments';
import { useRef, useState, type FormEvent } from 'react';
import type { AttachmentDto, CreateTaskInput } from '../../lib/types';
import taskCategories from '../../lib/task-categories.json';
import { taskErrorText } from '../../lib/task-presentation';

export function TaskForm({
  initial,
  save,
  cancel,
}: {
  initial?: CreateTaskInput & { attachments?: AttachmentDto[] };
  save: (input: CreateTaskInput) => Promise<void>;
  cancel?: () => void;
}) {
  const [values, setValues] = useState<CreateTaskInput>(
    initial ?? { title: '', summary: '', description: '', type: '' },
  );
  const [files, setFiles] = useState<AttachmentDto[]>(
    initial?.attachments ?? [],
  );
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const selectedCategory = taskCategories.find(
    (category) => category.id === values.type,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || uploading) return;
    const input: CreateTaskInput = {
      title: values.title.trim(),
      summary: values.summary.trim(),
      description: values.description.trim(),
      type: values.type.trim(),
    };
    if (Object.values(input).some((value) => !value)) {
      setError('请填写所有字段，内容不能只有空白。');
      return;
    }
    if (!taskCategories.some((category) => category.id === input.type)) {
      setError('请重新选择预设任务分类。');
      return;
    }
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      await save({ ...input, attachmentIds: files.map((file) => file.id) });
    } catch (error) {
      setError(taskErrorText(error));
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <form className="task-form" onSubmit={(event) => void submit(event)}>
      <p className="task-help">
        标题、摘要和类型公开可见。完整需求仅你和管理员可见。
      </p>
      <fieldset disabled={pending}>
        <legend className="sr-only">任务内容</legend>
        <div className="form-field">
          <label htmlFor="task-title">任务标题</label>
          <input
            id="task-title"
            required
            maxLength={160}
            value={values.title}
            onChange={(event) =>
              setValues({ ...values, title: event.target.value })
            }
          />
        </div>
        <div className="form-field">
          <label htmlFor="task-type">任务类型</label>
          <select
            id="task-type"
            required
            value={values.type}
            onChange={(event) =>
              setValues({ ...values, type: event.target.value })
            }
          >
            <option value="" disabled>
              请选择主要交付成果
            </option>
            {values.type && !selectedCategory && (
              <option value={values.type} disabled>
                原分类：{values.type}（请重新选择）
              </option>
            )}
            {taskCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </select>
          {selectedCategory && (
            <small className="task-category-help">
              {selectedCategory.description}
              {selectedCategory.technologies.length > 0 &&
                ` · 涉及技术：${selectedCategory.technologies.join('、')}`}
            </small>
          )}
        </div>
        <div className="form-field">
          <label htmlFor="task-summary">公开摘要</label>
          <textarea
            id="task-summary"
            required
            maxLength={500}
            rows={3}
            value={values.summary}
            onChange={(event) =>
              setValues({ ...values, summary: event.target.value })
            }
          />
        </div>
        <div className="form-field">
          <label htmlFor="task-description">完整需求（私密）</label>
          <textarea
            id="task-description"
            required
            maxLength={20000}
            rows={8}
            value={values.description}
            onChange={(event) =>
              setValues({ ...values, description: event.target.value })
            }
          />
        </div>
        <AttachmentPicker
          files={files}
          onChange={setFiles}
          onBusy={setUploading}
          existingIds={initial?.attachments?.map((file) => file.id)}
        />
        {error && (
          <p role="alert" className="error-message">
            {error}
          </p>
        )}
        <div className="task-actions">
          <button className="btn btn-pri" type="submit" disabled={uploading}>
            {pending ? '提交中...' : initial ? '保存并重新审核' : '提交审核'}
          </button>
          {cancel && (
            <button className="btn" type="button" onClick={cancel}>
              放弃编辑
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
