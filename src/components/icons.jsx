// 16px stroke icons drawn with currentColor.
const Svg = ({ children, size = 16, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    {children}
  </svg>
);

export const IconSidebar = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
    <path d="M6 2.75v10.5" />
  </Svg>
);

export const IconFolder = (p) => (
  <Svg {...p}>
    <path d="M1.75 4.5c0-.97.78-1.75 1.75-1.75h2.4c.46 0 .9.18 1.23.51l.9.9c.33.33.77.51 1.23.51h3.24c.97 0 1.75.78 1.75 1.75v4.83c0 .97-.78 1.75-1.75 1.75H3.5c-.97 0-1.75-.78-1.75-1.75z" />
  </Svg>
);

export const IconFolderOpen = (p) => (
  <Svg {...p}>
    <path d="M1.75 11.5V4.5c0-.97.78-1.75 1.75-1.75h2.4c.46 0 .9.18 1.23.51l.9.9c.33.33.77.51 1.23.51h2.74c.97 0 1.75.78 1.75 1.75v.33" />
    <path d="M1.9 12.4l1.65-4.4c.25-.68.9-1.13 1.62-1.13h8.4c.6 0 1.02.6.8 1.17l-1.35 3.6c-.26.68-.9 1.11-1.63 1.11H2.6" />
  </Svg>
);

export const IconFolderPlus = (p) => (
  <Svg {...p}>
    <path d="M1.75 4.5c0-.97.78-1.75 1.75-1.75h2.4c.46 0 .9.18 1.23.51l.9.9c.33.33.77.51 1.23.51h3.24c.97 0 1.75.78 1.75 1.75v4.83c0 .97-.78 1.75-1.75 1.75H3.5c-.97 0-1.75-.78-1.75-1.75z" />
    <path d="M8 6.9v3.6M6.2 8.7h3.6" />
  </Svg>
);

export const IconChevron = (p) => (
  <Svg {...p}>
    <path d="M6 4l4 4-4 4" />
  </Svg>
);

export const IconPlus = (p) => (
  <Svg {...p}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);

export const IconMore = (p) => (
  <Svg {...p} strokeWidth="2.2">
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" />
  </Svg>
);

export const IconSearch = (p) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="M10.2 10.2l3.3 3.3" />
  </Svg>
);

export const IconLibrary = (p) => (
  <Svg {...p}>
    <rect x="2" y="2.75" width="12" height="3.5" rx="1.2" />
    <path d="M3 6.25v6c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-6M6.5 8.75h3" />
  </Svg>
);

export const IconActivity = (p) => (
  <Svg {...p}>
    <path d="M4.5 6.5a3.5 3.5 0 0 1 7 0c0 3 1.25 4.25 1.25 4.25H3.25S4.5 9.5 4.5 6.5z" />
    <path d="M6.6 13a1.5 1.5 0 0 0 2.8 0" />
  </Svg>
);

export const IconGear = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64L3.58 3.58" />
  </Svg>
);

export const IconTerminal = (p) => (
  <Svg {...p}>
    <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" />
    <path d="M4.75 6.25L6.75 8l-2 1.75M8.5 10h2.75" />
  </Svg>
);

export const IconClose = (p) => (
  <Svg {...p}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Svg>
);
