// File: src/ui/theme.ts  v1.1
// Copyright (c) iOnline Consulting LLC. All rights reserved.
//
// Color palette ported from the DevMind WPF VSIX (DevMind/CLAUDE.md
// §"Output Rendering"). Ink renders via terminal ANSI palettes which
// are themselves user-customized, so an exact match is impossible —
// these are the same hex values the WPF extension uses; the terminal
// renders them as best it can.

export const theme = {
  /** Default foreground for assistant text and shell output. */
  normal: "#CCCCCC",
  /** Dimmed text for banners, status hints, completed reasoning. */
  dim: "#888888",
  /** User input echo and accent borders. */
  input: "#569CD6",
  /** Errors — shell stderr, build failures, tool errors. */
  error: "#F44747",
  /** Success — patch applied, build succeeded, task done. */
  success: "#4EC94E",
  /** Thinking / reasoning tokens (a muted purple-grey). */
  thinking: "#6A6A8A",
  /** In-progress / generating indicator. */
  pending: "#DCDCAA",
  /** Status bar Thinking... label when showReasoning=false and model is in reasoning phase. */
  thinkingActive: "#E07A0C",
} as const;
