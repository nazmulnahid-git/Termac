import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

export default function TerminalPane({
  tab,
  isActive,
  onTitleChange,
  onCwdChange,
  onAddBookmark,
  isBookmarked,
}) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const fitAddonRef = useRef(null)
  const initializedRef = useRef(false)
  const cleanupRef = useRef(null)
  const [currentCwd, setCurrentCwd] = useState(tab.cwd || '')
  const [copied, setCopied] = useState(false)

  const refreshCwd = useCallback(async () => {
    try {
      const cwd = await window.termac.getCwd({ id: tab.id })
      if (cwd && cwd !== currentCwd) {
        setCurrentCwd(cwd)
        onCwdChange?.(tab.id, cwd)
      }
    } catch {}
  }, [tab.id, currentCwd, onCwdChange])

  useEffect(() => {
    if (initializedRef.current || !containerRef.current) return
    initializedRef.current = true

    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, Monaco, 'JetBrains Mono', monospace",
      fontSize: 13.5,
      lineHeight: 1.45,
      letterSpacing: 0.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      theme: {
        background: '#13121d',
        foreground: '#e2e2e8',
        cursor: '#a78bfa',
        cursorAccent: '#13121d',
        selectionBackground: 'rgba(167, 139, 250, 0.28)',
        selectionForeground: '#ffffff',
        black: '#1f1e2e',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#e4e4e7',
        brightBlack: '#52525b',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#fafafa',
      },
      allowTransparency: true,
      scrollback: 10000,
      drawBoldTextInBrightColors: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)

    termRef.current = term
    fitAddonRef.current = fitAddon

    // Initial fit
    setTimeout(() => {
      try {
        fitAddon.fit()
      } catch (e) {}
    }, 80)

    // Create PTY
    const cols = term.cols
    const rows = term.rows
    window.termac.createPty({ id: tab.id, cwd: tab.cwd, cols, rows })

    // On terminal input -> send to PTY & check CWD on Enter
    const inputDisposable = term.onData((data) => {
      window.termac.writePty({ id: tab.id, data })
      if (data.includes('\r')) {
        setTimeout(refreshCwd, 250)
      }
    })

    // Handle PTY output -> write to terminal
    const removeDataListener = window.termac.onPtyData(({ id, data }) => {
      if (id === tab.id && termRef.current) {
        termRef.current.write(data)
      }
    })

    const removeExitListener = window.termac.onPtyExit(({ id }) => {
      if (id === tab.id && termRef.current) {
        termRef.current.write('\r\n\x1b[90m[Process finished]\x1b[0m\r\n')
      }
    })

    // Track title changes from shell
    const titleDisposable = term.onTitleChange((title) => {
      if (!title) return
      const parts = title.split(':')
      const short = parts[parts.length - 1].trim()
      const dirName = short.split('/').pop() || short
      onTitleChange(dirName || 'Terminal')
      refreshCwd()
    })

    // Resize observer for smooth responsive terminal
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit()
        } catch (e) {}
      }
    })
    resizeObserver.observe(containerRef.current)

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.termac.resizePty({ id: tab.id, cols, rows })
    })

    // Initial CWD poll
    setTimeout(refreshCwd, 400)

    cleanupRef.current = () => {
      inputDisposable.dispose()
      titleDisposable.dispose()
      resizeDisposable.dispose()
      resizeObserver.disconnect()
      removeDataListener()
      removeExitListener()
      term.dispose()
    }

    return () => {
      if (cleanupRef.current) cleanupRef.current()
    }
  }, [tab.id])

  // Refit & focus whenever tab becomes active
  useEffect(() => {
    if (isActive) {
      setTimeout(() => {
        try {
          fitAddonRef.current?.fit()
        } catch (e) {}
        termRef.current?.focus()
      }, 50)
      refreshCwd()
    }
  }, [isActive, refreshCwd])

  const handleBookmarkCwd = useCallback(async () => {
    const cwd = currentCwd || (await window.termac.getCwd({ id: tab.id }))
    if (cwd) {
      const name = cwd.split('/').filter(Boolean).pop() || cwd
      onAddBookmark(name, cwd)
    }
  }, [currentCwd, tab.id, onAddBookmark])

  const handleCopyPath = useCallback(() => {
    if (currentCwd) {
      navigator.clipboard.writeText(currentCwd)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [currentCwd])

  const handleRevealFinder = useCallback(() => {
    if (currentCwd && window.termac.openPath) {
      window.termac.openPath(currentCwd)
    }
  }, [currentCwd])

  // Format cwd for display
  const displayPath = currentCwd
    ? currentCwd.replace(/^\/Users\/[^/]+/, '~')
    : tab.title

  return (
    <div className={`terminal-pane ${isActive ? 'active' : ''}`}>
      <div className="terminal-card">
        <div className="terminal-toolbar">
          <div className="terminal-toolbar-left">
            <span className="terminal-badge-tag">zsh</span>
            <span className="terminal-tab-cwd" title={currentCwd || tab.cwd}>
              {displayPath}
            </span>
          </div>

          <div className="terminal-toolbar-right">
            <button
              className="terminal-tool-btn"
              onClick={handleCopyPath}
              title={copied ? 'Copied!' : 'Copy path'}
            >
              {copied ? (
                <span className="copied-text">✓ Copied</span>
              ) : (
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                  <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
                  <path d="M3 11V3.5A1.5 1.5 0 014.5 2H11" stroke="currentColor" strokeWidth="1.3"/>
                </svg>
              )}
            </button>

            <button
              className="terminal-tool-btn"
              onClick={handleRevealFinder}
              title="Reveal in Finder"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                <path d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293l1.414 1.414a1 1 0 00.707.293H13a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
            </button>

            <button
              className={`terminal-tool-btn ${isBookmarked ? 'pinned-active' : ''}`}
              onClick={handleBookmarkCwd}
              title={isBookmarked ? 'Bookmarked' : 'Pin folder to bookmarks (⌘B)'}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill={isBookmarked ? 'currentColor' : 'none'}>
                <path d="M3 2h10a1 1 0 011 1v11.586a.5.5 0 01-.853.354L8 9.793l-5.147 5.147A.5.5 0 012 14.586V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3"/>
              </svg>
            </button>
          </div>
        </div>

        <div className="terminal-container" ref={containerRef} />
      </div>
    </div>
  )
}
