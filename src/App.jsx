import React, { useState, useCallback, useEffect, useRef } from 'react'
import Sidebar from './components/Sidebar'
import TerminalPane from './components/TerminalPane'
import CommandPalette from './components/CommandPalette'

const generateId = () => `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export default function App() {
  const [tabs, setTabs] = useState([])
  const [activeTabId, setActiveTabId] = useState(null)
  const [bookmarks, setBookmarks] = useState([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(250)
  const [isPaletteOpen, setIsPaletteOpen] = useState(false)
  const initialized = useRef(false)

  // Initialize and load persisted state
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const init = async () => {
      try {
        const bm = await window.termac.getBookmarks()
        if (bm && Array.isArray(bm)) {
          setBookmarks(bm)
        }

        const sidebarState = await window.termac.getSidebarState()
        if (sidebarState) {
          if (sidebarState.width) setSidebarWidth(sidebarState.width)
          if (sidebarState.collapsed !== undefined) setSidebarCollapsed(sidebarState.collapsed)
        }
      } catch (e) {
        console.error('Failed to load initial settings:', e)
      }

      // Create initial tab
      const id = generateId()
      setTabs([{ id, title: 'Terminal', cwd: null }])
      setActiveTabId(id)
    }

    init()
  }, [])

  const createTab = useCallback((cwd = null, title = null) => {
    const id = generateId()
    const newTab = {
      id,
      title: title || (cwd ? cwd.split('/').filter(Boolean).pop() : 'Terminal') || 'Terminal',
      cwd,
    }
    setTabs((prev) => [...prev, newTab])
    setActiveTabId(id)
    return id
  }, [])

  const closeTab = useCallback((id) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id)
      const next = prev.filter((t) => t.id !== id)
      if (next.length === 0) {
        // Always maintain at least one tab
        const newId = generateId()
        const newTab = { id: newId, title: 'Terminal', cwd: null }
        setActiveTabId(newId)
        return [newTab]
      }
      if (id === activeTabId) {
        const newIdx = Math.min(idx, next.length - 1)
        setActiveTabId(next[newIdx].id)
      }
      return next
    })
    window.termac.destroyPty({ id })
  }, [activeTabId])

  const closeOtherTabs = useCallback((keepId) => {
    setTabs((prev) => {
      prev.forEach((tab) => {
        if (tab.id !== keepId) {
          window.termac.destroyPty({ id: tab.id })
        }
      })
      const kept = prev.filter((t) => t.id === keepId)
      return kept
    })
    setActiveTabId(keepId)
  }, [])

  const duplicateTab = useCallback((tab) => {
    createTab(tab.cwd, tab.title)
  }, [createTab])

  const updateTabTitle = useCallback((id, title) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)))
  }, [])

  const updateTabCwd = useCallback((id, cwd) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, cwd } : t)))
  }, [])

  const reorderTabs = useCallback((fromIdx, toIdx) => {
    setTabs((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      return next
    })
  }, [])

  // Bookmarks
  const addBookmark = useCallback((name, dirPath) => {
    setBookmarks((prev) => {
      if (prev.some((b) => b.path === dirPath)) return prev
      const newBm = { id: `bm-${Date.now()}`, name, path: dirPath }
      const next = [...prev, newBm]
      window.termac.setBookmarks(next)
      return next
    })
  }, [])

  const removeBookmark = useCallback((id) => {
    setBookmarks((prev) => {
      const next = prev.filter((b) => b.id !== id)
      window.termac.setBookmarks(next)
      return next
    })
  }, [])

  const reorderBookmarks = useCallback((fromIdx, toIdx) => {
    setBookmarks((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, moved)
      window.termac.setBookmarks(next)
      return next
    })
  }, [])

  const browseDirectory = useCallback(async () => {
    try {
      const selectedDir = await window.termac.selectDirectory()
      if (selectedDir) {
        const folderName = selectedDir.split('/').filter(Boolean).pop() || selectedDir
        addBookmark(folderName, selectedDir)
        createTab(selectedDir, folderName)
      }
    } catch (e) {
      console.error('Directory picker failed:', e)
    }
  }, [addBookmark, createTab])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev
      window.termac.setSidebarState({ collapsed: next })
      return next
    })
  }, [])

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      const isCmd = e.metaKey || e.ctrlKey

      // Cmd+T: Command Palette / New tab
      if (isCmd && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setIsPaletteOpen((prev) => !prev)
        return
      }

      // Cmd+K: Command Palette
      if (isCmd && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setIsPaletteOpen(true)
        return
      }

      // Cmd+W: Close active tab
      if (isCmd && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (activeTabId) {
          closeTab(activeTabId)
        }
        return
      }

      // Cmd+S: Toggle sidebar
      if (isCmd && e.key.toLowerCase() === 's') {
        e.preventDefault()
        toggleSidebar()
        return
      }

      // Cmd+1 through Cmd+9: Switch tab
      if (isCmd && e.key >= '1' && e.key <= '9') {
        e.preventDefault()
        const targetIdx = parseInt(e.key, 10) - 1
        if (tabs[targetIdx]) {
          setActiveTabId(tabs[targetIdx].id)
        }
        return
      }

      // Cmd+Shift+[ or Cmd+Shift+]: Prev / Next Tab
      if (isCmd && (e.key === '{' || e.key === '[')) {
        e.preventDefault()
        const currentIdx = tabs.findIndex((t) => t.id === activeTabId)
        if (currentIdx > 0) {
          setActiveTabId(tabs[currentIdx - 1].id)
        } else if (tabs.length > 0) {
          setActiveTabId(tabs[tabs.length - 1].id)
        }
        return
      }

      if (isCmd && (e.key === '}' || e.key === ']')) {
        e.preventDefault()
        const currentIdx = tabs.findIndex((t) => t.id === activeTabId)
        if (currentIdx < tabs.length - 1) {
          setActiveTabId(tabs[currentIdx + 1].id)
        } else if (tabs.length > 0) {
          setActiveTabId(tabs[0].id)
        }
        return
      }

      // Cmd+B: Bookmark active tab CWD
      if (isCmd && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        const currentTab = tabs.find((t) => t.id === activeTabId)
        if (currentTab?.cwd) {
          const name = currentTab.cwd.split('/').filter(Boolean).pop() || currentTab.title
          addBookmark(name, currentTab.cwd)
        }
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [tabs, activeTabId, closeTab, toggleSidebar, addBookmark])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isCurrentTabBookmarked = activeTab?.cwd
    ? bookmarks.some((b) => b.path === activeTab.cwd)
    : false

  return (
    <div className="app">
      <Sidebar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onCloseOtherTabs={closeOtherTabs}
        onDuplicateTab={duplicateTab}
        onNewTab={() => createTab()}
        onReorderTabs={reorderTabs}
        bookmarks={bookmarks}
        onBookmarkClick={(bm) => createTab(bm.path, bm.name)}
        onRemoveBookmark={removeBookmark}
        onReorderBookmarks={reorderBookmarks}
        onAddBookmarkFromPath={addBookmark}
        onBrowseDirectory={browseDirectory}
        onOpenPalette={() => setIsPaletteOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapse={toggleSidebar}
        width={sidebarWidth}
      />

      <div className="terminal-area">
        {tabs.map((tab) => (
          <TerminalPane
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onTitleChange={(title) => updateTabTitle(tab.id, title)}
            onCwdChange={updateTabCwd}
            onAddBookmark={addBookmark}
            isBookmarked={tab.cwd ? bookmarks.some((b) => b.path === tab.cwd) : false}
          />
        ))}
      </div>

      <CommandPalette
        isOpen={isPaletteOpen}
        onClose={() => setIsPaletteOpen(false)}
        tabs={tabs}
        activeTabId={activeTabId}
        bookmarks={bookmarks}
        onSelectTab={setActiveTabId}
        onOpenBookmark={(bm) => createTab(bm.path, bm.name)}
        onNewTab={(cwd, title) => createTab(cwd, title)}
        onBrowseDirectory={browseDirectory}
        onToggleSidebar={toggleSidebar}
      />
    </div>
  )
}
