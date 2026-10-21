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

export const IconBranch = (p) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="4.5" r="1.5" />
    <path d="M4.5 5v6M11.5 6c0 3.25-7 2.25-7 5" />
  </Svg>
);

export const IconPullRequest = (p) => (
  <Svg {...p}>
    <circle cx="4.5" cy="3.5" r="1.5" />
    <circle cx="4.5" cy="12.5" r="1.5" />
    <circle cx="11.5" cy="12.5" r="1.5" />
    <path d="M4.5 5v6M11.5 11V6.5c0-1.1-.9-2-2-2H7.5M9 3L7.5 4.5 9 6" />
  </Svg>
);

export const IconDiff = (p) => (
  <Svg {...p}>
    <path d="M8 2.75v6.5M4.75 6h6.5M4.75 13.25h6.5" />
  </Svg>
);

export const IconCheck = (p) => (
  <Svg {...p}>
    <path d="M3.5 8.5l3 3 6-7" />
  </Svg>
);

export const IconArrowUp = (p) => (
  <Svg {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Svg>
);

export const IconClock = (p) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6.25" />
    <path d="M8 4.75V8l2.25 1.5" />
  </Svg>
);

export const IconCopy = (p) => (
  <Svg {...p}>
    <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.75" />
    <path d="M10.75 5.25V3.5c0-.97-.78-1.75-1.75-1.75H3.5c-.97 0-1.75.78-1.75 1.75V9c0 .97.78 1.75 1.75 1.75h1.75" />
  </Svg>
);

export const IconExternal = (p) => (
  <Svg {...p}>
    <path d="M9.5 2.75h3.75V6.5M13.25 2.75L7.5 8.5M12 9.5v2.75c0 .55-.45 1-1 1H3.75c-.55 0-1-.45-1-1V5c0-.55.45-1 1-1H6.5" />
  </Svg>
);

export const IconFiles = (p) => (
  <Svg {...p}>
    <path d="M5.25 4.25V3.5c0-.97.78-1.75 1.75-1.75h3.4l3.35 3.35v5.4c0 .97-.78 1.75-1.75 1.75h-.75" />
    <path d="M10.25 1.75v3.5h3.5" />
    <rect x="2.25" y="4.25" width="8" height="10" rx="1.75" />
  </Svg>
);

export const IconFile = (p) => (
  <Svg {...p}>
    <path d="M3.25 3.5c0-.97.78-1.75 1.75-1.75h3.9l3.85 3.85v6.9c0 .97-.78 1.75-1.75 1.75H5c-.97 0-1.75-.78-1.75-1.75z" />
    <path d="M8.75 1.75V5.6h3.85" />
  </Svg>
);

export const IconGrid = (p) => (
  <Svg {...p}>
    <rect x="2" y="2" width="5" height="5" rx="1.25" />
    <rect x="9" y="2" width="5" height="5" rx="1.25" />
    <rect x="2" y="9" width="5" height="5" rx="1.25" />
    <rect x="9" y="9" width="5" height="5" rx="1.25" />
  </Svg>
);

export const IconReview = (p) => (
  <Svg {...p}>
    <path d="M3.25 3.5c0-.97.78-1.75 1.75-1.75h3.9l3.85 3.85v6.9c0 .97-.78 1.75-1.75 1.75H5c-.97 0-1.75-.78-1.75-1.75z" />
    <path d="M8 6v4M6 8h4M6 12h4" />
  </Svg>
);

export const IconRefresh = (p) => (
  <Svg {...p}>
    <path d="M13.25 8a5.25 5.25 0 1 1-1.54-3.71" />
    <path d="M13.25 2.75v3h-3" />
  </Svg>
);

export const IconUndo = (p) => (
  <Svg {...p}>
    <path d="M5.5 3.25L2.75 6 5.5 8.75" />
    <path d="M2.75 6h6.5a4 4 0 0 1 0 8H7" />
  </Svg>
);

export const IconMinus = (p) => (
  <Svg {...p}>
    <path d="M3 8h10" />
  </Svg>
);

export const IconInsert = (p) => (
  <Svg {...p}>
    <path d="M2.75 8h7.5M7.5 5.25L10.25 8 7.5 10.75" />
    <path d="M10.75 2.75h1.5c.55 0 1 .45 1 1v8.5c0 .55-.45 1-1 1h-1.5" />
  </Svg>
);

// App mark: a terminal window branching out to three sessions. Same drawing as build/icon.svg.
export const LogoMark = ({ size = 28, ...rest }) => (
  <svg width={size} height={(size * 290) / 400} viewBox="33 25 400 290" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    <path strokeWidth="22" d="M278 150V114a40 40 0 0 0-40-40H92a40 40 0 0 0-40 40v96a40 40 0 0 0 40 40h146a40 40 0 0 0 40-40v-10" />
    <path strokeWidth="18" d="M278 150c22-10 22-90 97-95M278 200c22 10 22 90 97 95M272 175h123" />
    <path strokeWidth="18" d="M102 132l30 30-30 30" />
    <path strokeWidth="16" strokeOpacity="0.6" d="M165 208h55" />
    <g fill="currentColor" stroke="none">
      <circle cx="380" cy="55" r="26" />
      <circle cx="400" cy="175" r="26" />
      <circle cx="380" cy="285" r="26" />
    </g>
  </svg>
);
