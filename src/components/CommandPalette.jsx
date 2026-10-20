import React, { useState, useEffect, useRef } from 'react'

export default function CommandPalette({
  isOpen,
  onClose,
  tabs,
  activeTabId,
  bookmarks,
  onSelectTab,
  onOpenBookmark,
  onNewTab,
  onBrowseDirectory,
  onToggleSidebar,
}) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 30)
    }
  }, [isOpen])

  // Filter items based on query
  const items = []

  // 1. New tab action
  if (query.trim()) {
    items.push({
      type: 'action',
      id: 'custom-path',
      title: `Open path: "${query.trim()}"`,
      subtitle: 'Open terminal at this directory',
      action: () => onNewTab(query.trim(), query.trim().split('/').pop()),
    })
  } else {
    items.push({
      type: 'action',
      id: 'new-tab-default',
      title: 'New Terminal Tab',
      subtitle: 'Open in home directory (~)',
      badge: '⌘T',
      action: () => onNewTab(),
    })
  }

  // 2. Open tabs
  tabs.forEach((tab, idx) => {
    if (!query || tab.title.toLowerCase().includes(query.toLowerCase()) || (tab.cwd && tab.cwd.toLowerCase().includes(query.toLowerCase()))) {
      items.push({
        type: 'tab',
        id: `tab-${tab.id}`,
        title: tab.title,
        subtitle: tab.cwd || 'Terminal session',
        badge: tab.id === activeTabId ? 'Active' : `⌘${idx + 1 <= 9 ? idx + 1 : ''}`,
        action: () => onSelectTab(tab.id),
      })
    }
  })

  // 3. Pinned bookmarks
  bookmarks.forEach((bm) => {
    if (!query || bm.name.toLowerCase().includes(query.toLowerCase()) || bm.path.toLowerCase().includes(query.toLowerCase())) {
      items.push({
        type: 'bookmark',
        id: `bm-${bm.id}`,
        title: bm.name,
        subtitle: bm.path,
        badge: 'Pinned',
        action: () => onOpenBookmark(bm),
      })
    }
  })

  // 4. Quick actions
  if (!query || 'browse pick folder directory'.includes(query.toLowerCase())) {
    items.push({
      type: 'action',
      id: 'browse-folder',
      title: 'Browse Folder in Finder...',
      subtitle: 'Pick any folder to open in new tab',
      action: onBrowseDirectory,
    })
  }

  if (!query || 'toggle sidebar collapse'.includes(query.toLowerCase())) {
    items.push({
      type: 'action',
      id: 'toggle-sidebar',
      title: 'Toggle Sidebar',
      subtitle: 'Show or hide navigation sidebar',
      badge: '⌘S',
      action: onToggleSidebar,
    })
  }

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, items.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => (prev - 1 + items.length) % Math.max(1, items.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const selected = items[selectedIndex]
      if (selected) {
        selected.action()
        onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!isOpen) return null

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="palette-search-wrapper">
          <svg className="palette-search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M11 11L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder="Search tabs, pinned bookmarks, or type a path..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="palette-esc-hint">esc</kbd>
        </div>

        <div className="palette-list">
          {items.map((item, idx) => (
            <div
              key={item.id}
              className={`palette-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => {
                item.action()
                onClose()
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div className="palette-item-icon">
                {item.type === 'tab' && (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4L8 2L12 4V12L8 14L4 12V4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                  </svg>
                )}
                {item.type === 'bookmark' && <span>📁</span>}
                {item.type === 'action' && (
                  <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3"/>
                    <path d="M8 5V11M5 8H11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                )}
              </div>
              <div className="palette-item-info">
                <span className="palette-item-title">{item.title}</span>
                {item.subtitle && <span className="palette-item-subtitle">{item.subtitle}</span>}
              </div>
              {item.badge && <span className="palette-item-badge">{item.badge}</span>}
            </div>
          ))}
          {items.length === 0 && (
            <div className="palette-empty">No matching tabs or bookmarks found</div>
          )}
        </div>
      </div>
    </div>
  )
}

