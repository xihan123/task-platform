import type { ReactNode } from 'react';
import type { TaskStatus } from '../lib/types';

/* 统一线性图标：18 viewBox / 1.5 描边 / currentColor */

function IconBase({
  size = 15,
  strokeWidth = 1.5,
  children,
}: {
  size?: number;
  strokeWidth?: number;
  children: ReactNode;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

export const IconFlow = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M2.75 9h12.5" />
    <path d="M6.4 6.2v5.6M11.6 6.2v5.6" />
  </IconBase>
);

export const IconGrid = ({ size }: IconProps) => (
  <IconBase size={size}>
    <rect x="2.5" y="2.5" width="5" height="5" rx="1" />
    <rect x="10.5" y="2.5" width="5" height="5" rx="1" />
    <rect x="2.5" y="10.5" width="5" height="5" rx="1" />
    <rect x="10.5" y="10.5" width="5" height="5" rx="1" />
  </IconBase>
);

export const IconList = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M6 4.5h9M6 9h9M6 13.5h9" />
    <path d="M2.75 4.5h.5M2.75 9h.5M2.75 13.5h.5" />
  </IconBase>
);

export const IconUsers = ({ size }: IconProps) => (
  <IconBase size={size}>
    <circle cx="7" cy="6" r="2.75" />
    <path d="M2.5 14.5c0-2.5 2-4.25 4.5-4.25s4.5 1.75 4.5 4.25" />
    <path d="M12 3.6a2.6 2.6 0 0 1 0 4.8M13.4 10.6c1.4.6 2.35 2 2.35 3.9" />
  </IconBase>
);

export const IconShield = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M9 2.25 3.75 4.3v4.2c0 3.1 2.1 5.9 5.25 7 3.15-1.1 5.25-3.9 5.25-7V4.3Z" />
    <path d="M6.9 9.1 8.4 10.6l2.85-3" />
  </IconBase>
);

export const IconSliders = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M3 5.4h4.2M10.8 5.4H15M3 12.6h6.6M13.2 12.6H15" />
    <circle cx="9" cy="5.4" r="1.9" />
    <circle cx="11.4" cy="12.6" r="1.9" />
  </IconBase>
);

export const IconArrowLeft = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M14.5 9H4M8.4 4.6 4 9l4.4 4.4" />
  </IconBase>
);

export const IconChevronLeft = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M11 4.5 6.5 9l4.5 4.5" />
  </IconBase>
);

export const IconChevronRight = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M7 4.5 11.5 9 7 13.5" />
  </IconBase>
);

export const IconChevronDown = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M4.5 7 9 11.5 13.5 7" />
  </IconBase>
);

export const IconChevronUp = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M4.5 11 9 6.5l4.5 4.5" />
  </IconBase>
);

export const IconLock = ({ size }: IconProps) => (
  <IconBase size={size}>
    <rect x="3.75" y="7.9" width="10.5" height="7.35" rx="1.6" />
    <path d="M6.15 7.9V5.8a2.85 2.85 0 0 1 5.7 0v2.1" />
  </IconBase>
);

export const IconClock = ({ size }: IconProps) => (
  <IconBase size={size}>
    <circle cx="9" cy="9" r="6.25" />
    <path d="M9 5.4V9l2.7 1.8" />
  </IconBase>
);

export const IconSend = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M15.25 9 3.25 3.75l2.1 5.25-2.1 5.25Z" />
    <path d="M5.35 9h9.9" />
  </IconBase>
);

export const IconClose = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M4.5 4.5l9 9M13.5 4.5l-9 9" />
  </IconBase>
);

export const IconSearch = ({ size }: IconProps) => (
  <IconBase size={size}>
    <circle cx="8" cy="8" r="4.75" />
    <path d="m11.5 11.5 3.75 3.75" />
  </IconBase>
);

export const IconPlus = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M9 3.5v11M3.5 9h11" />
  </IconBase>
);

export const IconRefresh = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M14.6 7.4A5.9 5.9 0 0 0 3.5 9M3.4 10.6A5.9 5.9 0 0 0 14.5 9" />
    <path d="M14.7 3.6v3.8h-3.8M3.3 14.4v-3.8h3.8" />
  </IconBase>
);

export const IconInbox = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="M2.75 9.75h3.5l1.25 2h3l1.25-2h3.5" />
    <path d="M4.25 3.75h9.5l1.5 6v4.5h-12.5v-4.5Z" />
  </IconBase>
);

export const IconCheck = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="m4 9.5 3.2 3.2L14 5.8" />
  </IconBase>
);

export const IconServer = ({ size }: IconProps) => (
  <IconBase size={size}>
    <rect x="2.75" y="2.75" width="12.5" height="5" rx="1.2" />
    <rect x="2.75" y="10.25" width="12.5" height="5" rx="1.2" />
    <path d="M5.4 5.25h.01M5.4 12.75h.01" />
  </IconBase>
);

export const IconLayers = ({ size }: IconProps) => (
  <IconBase size={size}>
    <path d="m9 2.5 6.5 3.4L9 9.3 2.5 5.9Z" />
    <path d="m2.5 9.4 6.5 3.4 6.5-3.4M2.5 12.6l6.5 3.4 6.5-3.4" />
  </IconBase>
);

export const IconKey = ({ size }: IconProps) => (
  <IconBase size={size}>
    <circle cx="6" cy="11.75" r="3.25" />
    <path d="m8.5 9.25 6.75-6.75M12.5 5.25l2 2M10.25 7.5l1.75 1.75" />
  </IconBase>
);

/* 状态圆环字形：形状 + 色相双重编码（灰度安全） */

export function StatusGlyph({
  status,
  size = 12,
}: {
  status: TaskStatus;
  size?: number;
}) {
  switch (status) {
    case 'PENDING_REVIEW':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6.1" strokeDasharray="2.6 2.4" />
        </svg>
      );
    case 'OPEN':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6.1" />
        </svg>
      );
    case 'IN_PROGRESS':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6.1" />
          <path
            d="M9 2.9a6.1 6.1 0 0 1 0 12.2Z"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case 'COMPLETED':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 18 18"
          stroke="currentColor"
          strokeWidth={1.75}
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6.1" fill="currentColor" />
          <path
            d="M6.1 9.2l2.15 2.15 3.75-4.1"
            fill="none"
            /* var() 在 SVG presentation attribute 中不解析，必须走 style */
            style={{ stroke: 'var(--st-done-bg)' }}
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'CANCELLED':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="9" cy="9" r="6.1" />
          <path d="M5.5 12.5 12.5 5.5" />
        </svg>
      );
  }
}
