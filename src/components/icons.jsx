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
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageSquarePlus,
  GitCommitHorizontal,
  GitMerge,
  ArrowDown,
  ChevronDown,
  Send,
  Trash2,
  Pencil,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleCheck,
  CircleX,
  CircleDot,
  LoaderCircle,
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
export const IconMaximize = icon(Maximize2);
export const IconMinimize = icon(Minimize2);
export const IconComment = icon(MessageSquare);
export const IconCommentAdd = icon(MessageSquarePlus);
export const IconCommit = icon(GitCommitHorizontal);
export const IconPR = icon(GitPullRequest);
export const IconMerge = icon(GitMerge);
export const IconArrowDown = icon(ArrowDown);
export const IconChevronDown = icon(ChevronDown);
export const IconSend = icon(Send);
export const IconTrash = icon(Trash2);
export const IconPencil = icon(Pencil);
export const IconCollapseAll = icon(ChevronsDownUp);
export const IconExpandAll = icon(ChevronsUpDown);
export const IconCheckCircle = icon(CircleCheck);
export const IconXCircle = icon(CircleX);
export const IconDot = icon(CircleDot);
// Spins while a git or gh action runs (.spin in app.css).
export const IconSpinner = ({ size = 16, ...rest }) => <LoaderCircle size={size} strokeWidth={2} className="spin" aria-hidden="true" {...rest} />;

// App mark: a prompt and cursor, bracketed out to three sessions. Same drawing as build/icon.svg.
// Mint parts take currentColor; the session tiles stay paper-white on any background.
export const LogoMark = ({ size = 28, ...rest }) => (
  <svg width={size} height={(size * 438) / 612} viewBox="-306 -219 612 438" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
    <path strokeWidth="70" d="M-271 -121L-169 -19L-271 83" />
    <path strokeWidth="34" d="M133 -162H131A50 50 0 0 0 81 -112V112A50 50 0 0 0 131 162H133M81 0H128" />
    <g stroke="none">
      <rect x="-149" y="46" width="179" height="51" rx="25.5" fill="#fbfbfc" />
      <g fill="#fbfbfc">
        <rect x="165" y="-219" width="141" height="114" rx="30" />
        <rect x="165" y="-57" width="141" height="114" rx="30" />
        <rect x="165" y="105" width="141" height="114" rx="30" />
      </g>
      <g fill="currentColor">
        <circle cx="235.5" cy="-162" r="26" />
        <circle cx="235.5" cy="0" r="26" />
        <circle cx="235.5" cy="162" r="26" />
      </g>
    </g>
  </svg>
);
