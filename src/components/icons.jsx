// App icons: lucide glyphs at one stroke weight, so every icon in the chrome reads as one
// family. Callers keep using the Icon* names; size defaults to 16.
import {
  PanelLeft,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  Plus,
  Ellipsis,
  Search,
  Library,
  Activity,
  Settings,
  SquareTerminal,
  X,
  GitBranch,
  GitPullRequest,
  FileDiff,
  Check,
  ArrowUp,
  Clock,
  Copy,
  ExternalLink,
  FolderTree,
  File,
  LayoutGrid,
  GitCompareArrows,
  RotateCw,
  Undo2,
  Minus,
  CornerDownLeft,
} from 'lucide-react';

const icon = (Glyph) => {
  const C = ({ size = 16, ...rest }) => <Glyph size={size} strokeWidth={1.75} aria-hidden="true" {...rest} />;
  return C;
};

export const IconSidebar = icon(PanelLeft);
export const IconFolder = icon(Folder);
export const IconFolderOpen = icon(FolderOpen);
export const IconFolderPlus = icon(FolderPlus);
export const IconChevron = icon(ChevronRight);
export const IconPlus = icon(Plus);
export const IconMore = icon(Ellipsis);
export const IconSearch = icon(Search);
export const IconLibrary = icon(Library);
export const IconActivity = icon(Activity);
export const IconGear = icon(Settings);
export const IconTerminal = icon(SquareTerminal);
export const IconClose = icon(X);
export const IconBranch = icon(GitBranch);
export const IconPullRequest = icon(GitPullRequest);
export const IconDiff = icon(FileDiff);
export const IconCheck = icon(Check);
export const IconArrowUp = icon(ArrowUp);
export const IconClock = icon(Clock);
export const IconCopy = icon(Copy);
export const IconExternal = icon(ExternalLink);
export const IconFiles = icon(FolderTree);
export const IconFile = icon(File);
export const IconGrid = icon(LayoutGrid);
export const IconReview = icon(GitCompareArrows);
export const IconRefresh = icon(RotateCw);
export const IconUndo = icon(Undo2);
export const IconMinus = icon(Minus);
export const IconInsert = icon(CornerDownLeft);

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
