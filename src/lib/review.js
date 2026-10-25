// Review comments as plain text: what "Send to terminal", "Copy" and "Post to PR" hand over.
// Sorted by file and line, each with the line it points at, so an agent or reviewer can act
// on it without the panel.

export function reviewMarkdown(comments) {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const blocks = sorted.map((c) => {
    const where = `${c.path}:${c.line}${c.side === 'old' ? ' (removed line)' : ''}`;
    const quote = c.snippet?.trim() ? [`  > ${c.snippet.trim()}`] : [];
    const body = c.text.trim().split('\n').map((l) => `  ${l}`);
    return [where, ...quote, ...body].join('\n');
  });
  return `Review comments (${comments.length}):\n\n${blocks.join('\n\n')}`;
}
