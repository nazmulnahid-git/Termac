import React, { useState, useEffect } from 'react'

export default function Sidebar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onDuplicateTab,
  onNewTab,
  onReorderTabs,
  bookmarks,
  onBookmarkClick,
  onRemoveBookmark,
  onReorderBookmarks,
  onAddBookmarkFromPath,
  onBrowseDirectory,
  onOpenPalette,
  collapsed,
  onToggleCollapse,
  width,
}) {
  const [draggedTabIdx, setDraggedTabIdx] = useState(null)
  const [dragOverTabIdx, setDragOverTabIdx] = useState(null)
  const [draggedBmIdx, setDraggedBmIdx] = useState(null)
  const [dragOverBmIdx, setDragOverBmIdx] = useState(null)
  const [contextMenu, setContextMenu] = useState(null)

  // Tab drag & drop
  const handleTabDragStart = (e, idx) => {
    setDraggedTabIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', idx.toString())
    e.currentTarget.classList.add('dragging')
  }

  const handleTabDragOver = (e, idx) => {
    e.preventDefault()
    if (draggedTabIdx !== null && draggedTabIdx !== idx) {
      setDragOverTabIdx(idx)
    }
  }

  const handleTabDrop = (e, idx) => {
    e.preventDefault()
    if (draggedTabIdx !== null && draggedTabIdx !== idx) {
      onReorderTabs(draggedTabIdx, idx)
    }
    setDraggedTabIdx(null)
    setDragOverTabIdx(null)
  }

  const handleTabDragEnd = (e) => {
    e.currentTarget.classList.remove('dragging')
    setDraggedTabIdx(null)
    setDragOverTabIdx(null)
  }

  // Bookmark drag & drop
  const handleBmDragStart = (e, idx) => {
    setDraggedBmIdx(idx)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleBmDragOver = (e, idx) => {
    e.preventDefault()
    if (draggedBmIdx !== null && draggedBmIdx !== idx) {
      setDragOverBmIdx(idx)
    }
  }

  const handleBmDrop = (e, idx) => {
    e.preventDefault()
    if (draggedBmIdx !== null && draggedBmIdx !== idx) {
      onReorderBookmarks(draggedBmIdx, idx)
    }
    setDraggedBmIdx(null)
    setDragOverBmIdx(null)
  }

  const handleBmDragEnd = () => {
    setDraggedBmIdx(null)
    setDragOverBmIdx(null)
  }

  // Context menus
  const handleBmContextMenu = (e, bm) => {
    e.preventDefault()
    setContextMenu({
      type: 'bookmark',
      x: e.clientX,
      y: e.clientY,
      item: bm,
    })
  }

  const handleTabContextMenu = (e, tab) => {
    e.preventDefault()
    setContextMenu({
      type: 'tab',
      x: e.clientX,
      y: e.clientY,
      item: tab,
    })
  }

  const closeContextMenu = () => setContextMenu(null)

  useEffect(() => {
    if (contextMenu) {
      const handler = () => closeContextMenu()
      window.addEventListener('click', handler)
      return () => window.removeEventListener('click', handler)
    }
  }, [contextMenu])

  if (collapsed) {
    return (
      <div className="sidebar sidebar-collapsed">
        <div className="sidebar-collapsed-bar">
          <div className="traffic-light-spacer-collapsed" />
          <button className="sidebar-toggle-btn" onClick={onToggleCollapse} title="Expand sidebar (⌘S)">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <button className="collapsed-palette-btn" onClick={onOpenPalette} title="Command Palette (⌘T)">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M11 11L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          <div className="collapsed-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                className={`collapsed-tab-dot ${tab.id === activeTabId ? 'active' : ''}`}
                onClick={() => onSelectTab(tab.id)}
                title={tab.title}
              />
            ))}
          </div>
          <button className="collapsed-new-btn" onClick={() => onNewTab()} title="New Tab (⌘T)">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="sidebar" style={{ width }}>
      {/* Header with macOS Traffic Light spacer and sidebar toggle */}
      <div className="sidebar-header">
        <div className="traffic-light-spacer" />
        <button className="sidebar-toggle-btn" onClick={onToggleCollapse} title="Collapse sidebar (⌘S)">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      {/* Arc Browser Style Command / Search Bar */}
      <div className="arc-search-box" onClick={onOpenPalette} title="Search tabs, bookmarks, or actions (⌘T)">
        <svg className="arc-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M11 11L14.5 14.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="arc-search-placeholder">Search or jump...</span>
        <kbd className="arc-search-kbd">⌘T</kbd>
      </div>

      {/* Bookmarks / Pinned Section */}
      <div className="sidebar-section pinned-section">
        <div className="section-label">
          <span className="section-title">PINNED</span>
          <button className="section-action-btn" onClick={onBrowseDirectory} title="Add folder from Finder...">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="bookmark-grid">
          {bookmarks.map((bm, idx) => (
            <div
              key={bm.id}
              className={`bookmark-tile ${dragOverBmIdx === idx ? 'drag-over' : ''}`}
              draggable
              onDragStart={(e) => handleBmDragStart(e, idx)}
              onDragOver={(e) => handleBmDragOver(e, idx)}
              onDrop={(e) => handleBmDrop(e, idx)}
              onDragEnd={handleBmDragEnd}
              onClick={() => onBookmarkClick(bm)}
              onContextMenu={(e) => handleBmContextMenu(e, bm)}
              title={`${bm.name}\n${bm.path}`}
            >
              <span className="bookmark-icon">📁</span>
              <span className="bookmark-name">{bm.name}</span>
              <button
                className="bookmark-delete-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemoveBookmark(bm.id)
                }}
                title="Remove bookmark"
              >
                ×
              </button>
            </div>
          ))}
          {bookmarks.length === 0 && (
            <div className="empty-hint">Pin folders from terminal or click +</div>
          )}
        </div>
      </div>

      <div className="sidebar-divider" />

      {/* Open Tabs Section */}
      <div className="sidebar-section tabs-section">
        <div className="section-label">
          <span className="section-title">OPEN TABS ({tabs.length})</span>
          <button className="section-action-btn" onClick={() => onNewTab()} title="New Tab (⌘T)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
        <div className="tab-list">
          {tabs.map((tab, idx) => (
            <div
              key={tab.id}
              className={`tab-item ${tab.id === activeTabId ? 'active' : ''} ${dragOverTabIdx === idx ? 'drag-over' : ''}`}
              draggable
              onDragStart={(e) => handleTabDragStart(e, idx)}
              onDragOver={(e) => handleTabDragOver(e, idx)}
              onDrop={(e) => handleTabDrop(e, idx)}
              onDragEnd={handleTabDragEnd}
              onClick={() => onSelectTab(tab.id)}
              onContextMenu={(e) => handleTabContextMenu(e, tab)}
            >
              <span className="tab-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4L8 2L12 4V12L8 14L4 12V4Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/>
                </svg>
              </span>
              <span className="tab-title">{tab.title}</span>
              {idx < 9 && <span className="tab-shortcut-num">⌘{idx + 1}</span>}
              <button
                className="tab-close-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseTab(tab.id)
                }}
                title="Close tab (⌘W)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Sidebar Footer */}
      <div className="sidebar-footer">
        <button className="new-tab-btn-footer" onClick={() => onNewTab()}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          <span>New Terminal</span>
          <kbd>⌘T</kbd>
        </button>
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.type === 'bookmark' && (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  onBookmarkClick(contextMenu.item)
                  closeContextMenu()
                }}
              >
                Open in New Tab
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  navigator.clipboard.writeText(contextMenu.item.path)
                  closeContextMenu()
                }}
              >
                Copy Path
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  window.termac.openPath?.(contextMenu.item.path)
                  closeContextMenu()
                }}
              >
                Reveal in Finder
              </button>
              <div className="context-menu-divider" />
              <button
                className="context-menu-item danger"
                onClick={() => {
                  onRemoveBookmark(contextMenu.item.id)
                  closeContextMenu()
                }}
              >
                Remove from Pinned
              </button>
            </>
          )}

          {contextMenu.type === 'tab' && (
            <>
              <button
                className="context-menu-item"
                onClick={() => {
                  onDuplicateTab?.(contextMenu.item)
                  closeContextMenu()
                }}
              >
                Duplicate Tab
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  if (contextMenu.item.cwd) {
                    onAddBookmarkFromPath?.(contextMenu.item.title, contextMenu.item.cwd)
                  }
                  closeContextMenu()
                }}
              >
                Pin Directory to Bookmarks
              </button>
              <button
                className="context-menu-item"
                onClick={() => {
                  if (contextMenu.item.cwd) {
                    navigator.clipboard.writeText(contextMenu.item.cwd)
                  }
                  closeContextMenu()
                }}
              >
                Copy Current Path
              </button>
              <div className="context-menu-divider" />
              <button
                className="context-menu-item"
                onClick={() => {
                  onCloseOtherTabs?.(contextMenu.item.id)
                  closeContextMenu()
                }}
              >
                Close Other Tabs
              </button>
              <button
                className="context-menu-item danger"
                onClick={() => {
                  onCloseTab(contextMenu.item.id)
                  closeContextMenu()
                }}
              >
                Close Tab
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
