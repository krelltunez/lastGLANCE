import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react'
import { Plus, GripVertical, Search, UserCircle, Clock, ChevronDown, ChevronUp, Pin } from 'lucide-react'
import { useChores } from '@/hooks/useChores'
import { useDayRollover } from '@/hooks/useDayRollover'
import { ensureInboxCategory, reorderCategories } from '@/db/queries'
import { CategorySection } from '@/components/CategorySection/CategorySection'
import { PinnedSection } from '@/components/PinnedSection/PinnedSection'
import { LogModal } from '@/components/LogModal/LogModal'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import { ChoreFormModal } from '@/components/ChoreFormModal/ChoreFormModal'
import { SearchModal } from '@/components/SearchModal/SearchModal'
import { useUsersContext } from '@/multiuser/UsersContext'
import { peekPendingOpenChore, clearPendingOpenChore } from '@/native/pendingOpenChore'
import { filterCategoryData } from '@/utils/choreFilter'
import { collectPinned } from '@/utils/pinned'
import { ICON_REGISTRY } from '@/icons/registry'
import { SHOW_PINNED_EVENT, type PinnedState } from './pinnedNav'
import type { Category, ChoreWithLastCompletion } from '@/types'
import type { CategoryWithChores } from '@/hooks/useChores'
import { useTranslation } from 'react-i18next'

interface Props {
  editMode: boolean
  onLogged?: () => void
  onPinnedState?: (state: PinnedState) => void
}

const SNAP_MS = 280
const MASONRY_GAP = 20 // px — 1.25rem, matches the former columnGap

function getColCount(containerWidth: number, itemCount: number): number {
  let cols: number
  if (containerWidth >= 2400) cols = 6
  else if (containerWidth >= 1920) cols = 5
  else if (containerWidth >= 1440) cols = 4
  else if (containerWidth >= 1200) cols = 3
  else if (containerWidth >= 800) cols = 2
  else cols = 1
  return Math.min(cols, Math.max(itemCount, 1))
}

interface MasonryPos { x: number; y: number }

// Pure packing function: ordered catIds × column count × measured heights → positions + container height.
// Shortest-column-next; leftmost column wins on tie (strict <).
function packMasonry(
  catIds: number[],
  cols: number,
  heights: Map<number, number>,
  cardWidth: number,
  gap: number,
): { positions: Map<number, MasonryPos>; containerHeight: number } {
  const positions = new Map<number, MasonryPos>()
  if (catIds.length === 0 || cardWidth <= 0) return { positions, containerHeight: 0 }

  const colHeights = new Array<number>(cols).fill(0)
  for (const id of catIds) {
    let shortest = 0
    for (let c = 1; c < cols; c++) {
      if (colHeights[c] < colHeights[shortest]) shortest = c
    }
    positions.set(id, { x: shortest * (cardWidth + gap), y: colHeights[shortest] })
    colHeights[shortest] += (heights.get(id) ?? 200) + gap
  }

  const maxH = Math.max(...colHeights)
  return { positions, containerHeight: maxH > gap ? maxH - gap : maxH }
}

const ADD_CAT_ID = -1

// A category's own icon on its narrow-layout tab, sized like the Pinned tab's
// pin and coloured with the tab text. Categories without one stay text-only.
function CategoryTabIcon({ name }: { name?: string }) {
  const Icon = name ? ICON_REGISTRY[name] : undefined
  return Icon ? <Icon size={11} className="shrink-0" /> : null
}

export function Ribbon({ editMode, onLogged, onPinnedState }: Props) {
  const { t } = useTranslation()
  const { data, loading, refresh } = useChores()
  // elapsed_days is computed inside the query, not in render, so a stale day
  // can only be corrected by re-reading — a re-render alone would not do it.
  useDayRollover(refresh)
  const { multiUserEnabled, meId, filter, setFilter, attentionOnly, setAttentionOnly } = useUsersContext()
  const [localData, setLocalData] = useState<CategoryWithChores[]>([])
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0)
  const [selectedChore, setSelectedChore] = useState<ChoreWithLastCompletion | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const [newChoreCategory, setNewChoreCategory] = useState<Category | null>(null)
  // Seed name for the new-chore form (e.g. from a share); '' for a blank add.
  const [newChoreName, setNewChoreName] = useState('')

  const [showSearch, setShowSearch] = useState(false)

  // Mobile FAB cluster collapse, persisted so the choice sticks across loads.
  const [fabsCollapsed, setFabsCollapsed] = useState(() => localStorage.getItem('lg-fabs-collapsed') === '1')
  const toggleFabs = () => setFabsCollapsed(c => {
    const next = !c
    localStorage.setItem('lg-fabs-collapsed', next ? '1' : '0')
    return next
  })

  // Category drag
  const [draggingCatId, setDraggingCatId] = useState<number | null>(null)
  const localDataRef = useRef<CategoryWithChores[]>([])
  const draggingCatIdRef = useRef<number | null>(null)
  const catListRef = useRef<HTMLElement | null>(null)
  const catItemSelector = useRef('')

  // Swipe (mobile)
  const [offset, setOffset] = useState(0)
  const [snapping, setSnapping] = useState(false)
  const isDragging = useRef(false)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const liveOffset = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const desktopGridRef = useRef<HTMLDivElement>(null)

  // Masonry measurement & layout
  const [containerWidth, setContainerWidth] = useState(0)
  const containerWidthRef = useRef(0)
  const cardHeightsRef = useRef<Map<number, number>>(new Map())
  const [, setPackVersion] = useState(0)
  // packPhase: 0 = hidden, 1 = placed (no transition), 2 = animated
  const [packPhase, setPackPhase] = useState<0 | 1 | 2>(0)
  const packPhaseRef = useRef<0 | 1 | 2>(0)

  const displayData = useMemo(
    () => filterCategoryData(localData, meId, filter, attentionOnly),
    [localData, meId, filter, attentionOnly]
  )

  // Single source for all rendering/navigation. Edit mode always shows the full,
  // unfiltered set (filters are hidden while editing); otherwise the filtered
  // view drives tabs, masonry packing, swipe bounds, keyboard nav and content,
  // so they stay in sync even when categories are hidden by the filter.
  const viewData = editMode ? localData : displayData
  const viewDataLengthRef = useRef(0)
  viewDataLengthRef.current = viewData.length

  // Pinned chores, drawn from the same filtered view so Soon / Mine apply to
  // them too. Hidden in edit mode, which is for arranging categories.
  const pinned = useMemo(() => editMode ? [] : collectPinned(displayData), [editMode, displayData])
  // The narrow layout pages through Pinned (when there is anything pinned)
  // and then each category; activeCategoryIndex indexes these pages, so a
  // category's page is its viewData index + pinnedOffset.
  const pinnedOffset = pinned.length > 0 ? 1 : 0
  const pageCount = viewData.length + pinnedOffset
  const pageCountRef = useRef(0)
  pageCountRef.current = pageCount

  // Refresh when a completion is logged from a toast notification
  useEffect(() => {
    function handleToastLog() { refresh(); onLogged?.() }
    window.addEventListener('lg:chore-logged', handleToastLog)
    return () => window.removeEventListener('lg:chore-logged', handleToastLog)
  }, [refresh, onLogged])

  // Open LogModal when a toast's Details button is tapped
  useEffect(() => {
    function handleOpenChore(e: Event) {
      const choreId = (e as CustomEvent<{ choreId: number }>).detail.choreId
      const chore = localDataRef.current.flatMap(d => [
        ...d.chores,
        ...d.subcategories.flatMap(s => s.chores),
      ]).find(c => c.id === choreId)
      if (chore) setSelectedChore(chore)
    }
    window.addEventListener('lg:open-chore', handleOpenChore)
    return () => window.removeEventListener('lg:open-chore', handleOpenChore)
  }, [])

  // Open LogModal for a chore requested via a notification tap. The request is
  // stashed (by sync_id) rather than fired as a one-shot event, because a tap
  // from a killed app can arrive before localData has loaded. We retry on every
  // data change and on the kick event, consuming the request once the chore is
  // found so a cold start still lands on the right chore.
  const consumePendingOpenChore = useCallback(() => {
    const syncId = peekPendingOpenChore()
    if (!syncId) return
    const chore = localDataRef.current.flatMap(d => [
      ...d.chores,
      ...d.subcategories.flatMap(s => s.chores),
    ]).find(c => c.sync_id === syncId)
    if (chore) {
      setSelectedChore(chore)
      clearPendingOpenChore()
    }
  }, [])

  useEffect(() => {
    window.addEventListener('lg:open-chore-pending', consumePendingOpenChore)
    return () => window.removeEventListener('lg:open-chore-pending', consumePendingOpenChore)
  }, [consumePendingOpenChore])

  useEffect(() => { consumePendingOpenChore() }, [localData, consumePendingOpenChore])

  // Stable refs so shortcut handlers don't need to re-register on state changes
  const activeCategoryIndexRef = useRef(0)
  activeCategoryIndexRef.current = activeCategoryIndex
  const ribbonModalOpenRef = useRef(false)
  ribbonModalOpenRef.current = showSearch || selectedChore !== null || addingCategory || newChoreCategory !== null

  // Every "add a chore" path that doesn't name a destination — the N shortcut,
  // launcher shortcuts, the Add widget, a share, Tasker's OPEN add — files into
  // the Inbox, the same category Tasker's CREATE uses when its payload has no
  // `project`. The user moves it somewhere permanent afterwards. Adding from a
  // category's own "+" button still targets that category: there the user has
  // already said where it goes.
  //
  // Resolved from the DB rather than from loaded state, so a cold-start launch
  // that fires before the Ribbon has data still lands somewhere real — which is
  // what the old pending-request stash existed to work around.
  const openNewChore = useCallback(async (name = '') => {
    const { category, created } = await ensureInboxCategory()
    setNewChoreName(name)
    setNewChoreCategory(category)
    // A brand new Inbox isn't in localData yet; pull it in so the form's
    // category list and the ribbon behind it agree.
    if (created) refresh()
  }, [refresh])

  // The keydown listener below is registered once on mount; this keeps it
  // pointed at the live callback without re-binding.
  const openNewChoreRef = useRef(openNewChore)
  openNewChoreRef.current = openNewChore

  useEffect(() => {
    function onOpenSearch() { setShowSearch(true) }
    function onNewChore(e: Event) {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name ?? ''
      openNewChore(name)
    }
    window.addEventListener('lg:open-search', onOpenSearch)
    window.addEventListener('lg:new-chore', onNewChore)
    return () => {
      window.removeEventListener('lg:open-search', onOpenSearch)
      window.removeEventListener('lg:new-chore', onNewChore)
    }
  }, [openNewChore])

  // Keyboard shortcuts owned by Ribbon: search, category nav, new chore
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName
      const editable = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as HTMLElement).isContentEditable

      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !editable && !ribbonModalOpenRef.current)) {
        e.preventDefault()
        setShowSearch(true)
        return
      }

      if (editable || ribbonModalOpenRef.current || e.metaKey || e.ctrlKey || e.altKey) return

      if (e.key === 'ArrowLeft' && window.innerWidth < 1060) {
        e.preventDefault()
        setActiveCategoryIndex(i => Math.max(0, i - 1))
      } else if (e.key === 'ArrowRight' && window.innerWidth < 1060) {
        e.preventDefault()
        setActiveCategoryIndex(i => Math.min(pageCountRef.current - 1, i + 1))
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        openNewChoreRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Sync localData from server when not dragging categories
  useEffect(() => {
    if (draggingCatIdRef.current === null) {
      setLocalData(data)
      localDataRef.current = data
    }
  }, [data])

  // Scroll active tab into view
  useEffect(() => {
    const el = tabsRef.current?.children[activeCategoryIndex] as HTMLElement | undefined
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeCategoryIndex])

  // Category drag listeners
  useEffect(() => {
    if (draggingCatId === null) return

    function onMove(e: PointerEvent) {
      if (!catListRef.current) return
      const cur = localDataRef.current
      const fromId = draggingCatIdRef.current
      if (fromId === null) return
      const fromIdx = cur.findIndex(d => d.category.id === fromId)
      if (fromIdx === -1) return

      const sel = catItemSelector.current
      let toIdx = -1
      for (let i = 0; i < cur.length; i++) {
        if (i === fromIdx) continue
        const id = cur[i].category.id
        const el = catListRef.current.querySelector(sel.replace(']', `="${id}"]`)) as HTMLElement | null
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          toIdx = i
          break
        }
      }
      if (toIdx === -1) return

      const next = [...cur]
      const [dragged] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, dragged)
      localDataRef.current = next
      setLocalData(next)
    }

    async function onUp() {
      if (draggingCatIdRef.current !== null) {
        const newOrder = localDataRef.current
        const newIdx = newOrder.findIndex(d => d.category.id === draggingCatIdRef.current)
        if (newIdx !== -1) setActiveCategoryIndex(newIdx)
        await reorderCategories(newOrder.map(d => d.category.id))
        refresh()
      }
      draggingCatIdRef.current = null
      setDraggingCatId(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [draggingCatId, refresh])

  function startCatDrag(e: React.PointerEvent, catId: number, listEl: HTMLElement, selector: string) {
    e.currentTarget.setPointerCapture(e.pointerId)
    catListRef.current = listEl
    catItemSelector.current = selector
    draggingCatIdRef.current = catId
    setDraggingCatId(catId)
  }

  useEffect(() => {
    const el = desktopGridRef.current
    if (!el) return
    const obs = new ResizeObserver(entries => {
      const w = entries[0].contentRect.width
      if (w === containerWidthRef.current) return
      containerWidthRef.current = w
      setContainerWidth(w)
      if (
        packPhaseRef.current === 0 &&
        cardHeightsRef.current.size >= viewDataLengthRef.current &&
        viewDataLengthRef.current > 0
      ) {
        packPhaseRef.current = 1
        setPackPhase(1)
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [viewData.length])

  const sortedCatIdsKey = [
    ...viewData.map(d => d.category.id),
    ...(editMode && viewData.length > 0 ? [ADD_CAT_ID] : []),
  ].sort((a, b) => a - b).join(',')
  useEffect(() => {
    const grid = desktopGridRef.current
    if (!grid) return

    const obs = new ResizeObserver(entries => {
      let changed = false
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        const id = parseInt(el.getAttribute('data-cat-card-id') ?? '0')
        if (!id) continue
        const h = el.offsetHeight
        if (cardHeightsRef.current.get(id) !== h) {
          cardHeightsRef.current.set(id, h)
          changed = true
        }
      }
      if (!changed) return
      setPackVersion(v => v + 1)
      if (
        packPhaseRef.current === 0 &&
        cardHeightsRef.current.size >= viewDataLengthRef.current &&
        containerWidthRef.current > 0
      ) {
        packPhaseRef.current = 1
        setPackPhase(1)
      }
    })

    grid.querySelectorAll<HTMLElement>('[data-cat-card-id]').forEach(el => obs.observe(el))
    return () => obs.disconnect()
  }, [sortedCatIdsKey])

  // A category card keeps a stable id but its *contents* change when a filter
  // is toggled (Soon / Mine) or edit mode flips — so its cached height goes
  // stale even though its id hasn't. The ResizeObserver above only re-attaches
  // when the *set* of categories changes, and on a mass toggle the browser can
  // also drop ResizeObserver notifications ("loop completed with undelivered
  // notifications"), leaving heights uncorrected and the masonry packing cards
  // on top of each other. Re-measure every visible card synchronously before
  // paint so packing never depends on async observer delivery for these cases.
  useLayoutEffect(() => {
    const grid = desktopGridRef.current
    if (!grid) return
    let changed = false
    grid.querySelectorAll<HTMLElement>('[data-cat-card-id]').forEach(el => {
      const id = parseInt(el.getAttribute('data-cat-card-id') ?? '0')
      if (!id) return
      const h = el.offsetHeight
      if (cardHeightsRef.current.get(id) !== h) {
        cardHeightsRef.current.set(id, h)
        changed = true
      }
    })
    if (changed) setPackVersion(v => v + 1)
  }, [filter, attentionOnly, editMode, sortedCatIdsKey])

  useEffect(() => {
    if (packPhase !== 1) return
    const raf = requestAnimationFrame(() => {
      packPhaseRef.current = 2
      setPackPhase(2)
    })
    return () => cancelAnimationFrame(raf)
  }, [packPhase])

  // Swipe handlers
  function handleTouchStart(e: React.TouchEvent) {
    if (snapping) return
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    isDragging.current = false
    liveOffset.current = 0
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (snapping) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = e.touches[0].clientY - touchStartY.current
    if (!isDragging.current) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) > Math.abs(dx)) return
      isDragging.current = true
    }
    const atStart = activeCategoryIndex === 0 && dx > 0
    const atEnd = activeCategoryIndex === pageCount - 1 && dx < 0
    const newOffset = (atStart || atEnd) ? dx * 0.2 : dx
    liveOffset.current = newOffset
    setOffset(newOffset)
  }

  function snap(targetOffset: number, afterSnap?: () => void) {
    setSnapping(true)
    setOffset(targetOffset)
    setTimeout(() => {
      afterSnap?.()
      setOffset(0)
      liveOffset.current = 0
      setSnapping(false)
    }, SNAP_MS)
  }

  function handleTouchEnd() {
    if (!isDragging.current) return
    isDragging.current = false
    const W = containerRef.current?.offsetWidth ?? 375
    const cur = liveOffset.current
    const threshold = W * 0.28

    if (cur < -threshold && activeCategoryIndex < pageCount - 1) {
      snap(-W, () => setActiveCategoryIndex(i => i + 1))
    } else if (cur > threshold && activeCategoryIndex > 0) {
      snap(W, () => setActiveCategoryIndex(i => i - 1))
    } else {
      snap(0)
    }
  }

  function handleTouchCancel() {
    if (!isDragging.current) return
    isDragging.current = false
    snap(0)
  }

  // When the Pinned page appears or goes away (first pin, last unpin, a
  // filter, edit mode), shift the index so the same category stays on screen.
  // Not on the first load: the app should open on Pinned, which is index 0.
  const prevPinnedOffsetRef = useRef<number | null>(null)
  const pagesReady = localData.length > 0
  useLayoutEffect(() => {
    const prev = prevPinnedOffsetRef.current
    prevPinnedOffsetRef.current = pagesReady ? pinnedOffset : null
    if (prev === null || prev === pinnedOffset) return
    setActiveCategoryIndex(i => Math.max(0, i + pinnedOffset - prev))
  }, [pinnedOffset, pagesReady])

  // The phone header's Pinned button: jump back to the Pinned tab, when there
  // is one.
  const pinnedOffsetRef = useRef(0)
  pinnedOffsetRef.current = pinnedOffset
  useEffect(() => {
    function onShowPinned() { if (pinnedOffsetRef.current > 0) setActiveCategoryIndex(0) }
    window.addEventListener(SHOW_PINNED_EVENT, onShowPinned)
    return () => window.removeEventListener(SHOW_PINNED_EVENT, onShowPinned)
  }, [])

  const pinnedShowing = pinnedOffset > 0 && activeCategoryIndex === 0
  useEffect(() => {
    onPinnedState?.({ available: pinnedOffset > 0, showing: pinnedShowing })
  }, [onPinnedState, pinnedOffset, pinnedShowing])

  // Keep the active page index in range when the visible set shrinks.
  useEffect(() => {
    setActiveCategoryIndex(i => Math.min(i, Math.max(0, pageCount - 1)))
  }, [pageCount])

  function openChore(chore: ChoreWithLastCompletion) { setSelectedChore(chore) }
  function closeChore() { setSelectedChore(null) }
  function afterLog() { refresh(); onLogged?.() }
  function selectSearchResult(chore: ChoreWithLastCompletion) { setShowSearch(false); setSelectedChore(chore) }
  // Hand the typed query straight to the new-chore form, pre-filled and filed
  // into the Inbox — the same destination every other undirected add uses.
  function createFromSearch(name: string) { setShowSearch(false); openNewChore(name) }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-slate-400 dark:text-slate-500 text-sm">{t('ribbon.loading')}</div>
      </div>
    )
  }

  const showEmpty = localData.length === 0
  // Filters can hide every category even though chores exist.
  const noMatches = !showEmpty && viewData.length === 0
  const noMatchesMessage = attentionOnly
    ? t('ribbon.nothingNeedsAttention')
    : t('ribbon.nothingAssignedToYou')
  const clearFilters = () => {
    setAttentionOnly(false)
    if (filter === 'mine') setFilter('all')
  }
  // One narrow-layout page: Pinned first when there is anything pinned, then
  // each category. Out-of-range indexes (no page before the first or after
  // the last) render nothing.
  function renderPage(index: number) {
    if (index < 0 || index >= pageCount) return null
    if (pinnedOffset && index === 0) {
      return <div className="p-4"><PinnedSection pinned={pinned} variant="page" onChoreTab={openChore} onRefresh={refresh} onLogged={onLogged} /></div>
    }
    const d = viewData[index - pinnedOffset]
    return <div className="p-4"><CategorySection key={d.category.id} data={d} allCategories={allCategories} editMode={editMode} onChoreTab={openChore} onRefresh={refresh} onLogged={onLogged} wrapChores /></div>
  }

  const allCategories = localData.flatMap(d => [d.category, ...d.subcategories.map(s => s.category)])

  const colCount = getColCount(containerWidth, viewData.length)
  const cardWidth = colCount > 0 && containerWidth > 0
    ? (containerWidth - MASONRY_GAP * (colCount - 1)) / colCount
    : 0
  const packIds = editMode && !showEmpty
    ? [...viewData.map(d => d.category.id), ADD_CAT_ID]
    : viewData.map(d => d.category.id)
  const { positions, containerHeight } = packMasonry(
    packIds,
    colCount,
    cardHeightsRef.current,
    cardWidth,
    MASONRY_GAP,
  )

  return (
    <>
      {/* ── Mobile: one category at a time with tab strip ── */}
      <div className="flex flex-col flex-1 overflow-hidden min-[1060px]:hidden">
        {!showEmpty && !noMatches && (
          <div ref={tabsRef} className="flex overflow-x-auto scrollbar-none border-b border-slate-200 dark:border-slate-700/60 bg-slate-100 dark:bg-slate-900 shrink-0">
            {pinnedOffset > 0 && (
              <button
                key="pinned"
                onClick={() => setActiveCategoryIndex(0)}
                className={`
                  shrink-0 flex items-center gap-1 px-3 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap
                  ${activeCategoryIndex === 0
                    ? 'text-green-400 border-b-2 border-green-400'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}
                `}
              >
                <Pin size={11} className="shrink-0" />
                {t('ribbon.pinned')}
              </button>
            )}
            {viewData.map((d, i) => (
              <button
                key={d.category.id}
                data-cat-tab-id={d.category.id}
                onClick={() => setActiveCategoryIndex(i + pinnedOffset)}
                className={`
                  shrink-0 flex items-center gap-1 px-3 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap
                  ${i + pinnedOffset === activeCategoryIndex
                    ? 'text-green-400 border-b-2 border-green-400'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}
                  ${draggingCatId === d.category.id ? 'opacity-40' : ''}
                `}
              >
                {editMode && (
                  <span
                    className="text-slate-300 dark:text-slate-600 hover:text-slate-400 shrink-0"
                    style={{ touchAction: 'none' }}
                    onPointerDown={e => {
                      e.stopPropagation()
                      startCatDrag(e, d.category.id, tabsRef.current!, '[data-cat-tab-id]')
                    }}
                  >
                    <GripVertical size={11} />
                  </span>
                )}
                <CategoryTabIcon name={d.category.icon} />
                {d.category.name}
              </button>
            ))}
            {editMode && (
              <button
                onClick={() => setAddingCategory(true)}
                className="shrink-0 flex items-center px-3 py-2.5 text-slate-400 dark:text-slate-500 hover:text-green-400 transition-colors border-l border-slate-200 dark:border-slate-700/60"
                aria-label={t('ribbon.addCategoryAriaLabel')}
              >
                <Plus size={13} />
              </button>
            )}
          </div>
        )}

        {showEmpty ? (
          <div className="flex-1">
            <EmptyState onAdd={() => setAddingCategory(true)} />
          </div>
        ) : noMatches ? (
          <div className="flex-1">
            <NoMatchesState message={noMatchesMessage} onClear={clearFilters} />
          </div>
        ) : (
          <div
            ref={containerRef}
            className="flex-1 overflow-hidden"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            style={{ touchAction: 'pan-y' }}
          >
            <div
              className="flex h-full"
              style={{
                width: '300%',
                transform: `translateX(calc(-33.333% + ${offset}px))`,
                transition: snapping ? `transform ${SNAP_MS}ms cubic-bezier(0.25, 1, 0.5, 1)` : 'none',
                willChange: 'transform',
              }}
            >
              <div className="overflow-y-auto" style={{ width: '33.333%' }}>
                {renderPage(activeCategoryIndex - 1)}
              </div>
              <div className="overflow-y-auto" style={{ width: '33.333%' }}>
                {renderPage(activeCategoryIndex)}
              </div>
              <div className="overflow-y-auto" style={{ width: '33.333%' }}>
                {renderPage(activeCategoryIndex + 1)}
              </div>
            </div>
          </div>
        )}

      </div>

      {/* ── Desktop: true masonry layout ── */}
      <div className="hidden min-[1060px]:block flex-1 overflow-y-auto">
        {showEmpty ? (
          <EmptyState onAdd={() => setAddingCategory(true)} />
        ) : noMatches ? (
          <NoMatchesState message={noMatchesMessage} onClear={clearFilters} />
        ) : (
          <div className="p-6">
            {pinned.length > 0 && (
              <div className="mb-5 bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-2xl p-5">
                <PinnedSection pinned={pinned} variant="row" onChoreTab={openChore} onRefresh={refresh} onLogged={onLogged} />
              </div>
            )}
            <div
              ref={desktopGridRef}
              style={{ position: 'relative', height: containerHeight }}
            >
              {viewData.map(d => {
                const pos = positions.get(d.category.id)
                return (
                  <div
                    key={d.category.id}
                    data-cat-card-id={d.category.id}
                    className="absolute bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-2xl p-5"
                    style={{
                      top: 0,
                      left: 0,
                      width: cardWidth > 0 ? cardWidth : undefined,
                      transform: pos ? `translate(${pos.x}px,${pos.y}px)` : undefined,
                      visibility: packPhase >= 1 ? 'visible' : 'hidden',
                      transition: packPhase >= 2 && draggingCatId === null ? 'transform 300ms ease' : 'none',
                      willChange: 'transform',
                    }}
                  >
                    <CategorySection
                      data={d}
                      allCategories={allCategories}
                      editMode={editMode}
                      onChoreTab={openChore}
                      onRefresh={refresh}
                      onLogged={onLogged}
                      onCategoryDragHandlePointerDown={editMode
                        ? e => startCatDrag(e, d.category.id, desktopGridRef.current!, '[data-cat-card-id]')
                        : undefined}
                      isCategoryDragging={draggingCatId === d.category.id}
                    />
                  </div>
                )
              })}
              {editMode && (() => {
                const pos = positions.get(ADD_CAT_ID)
                return (
                  <div
                    key="add-category"
                    data-cat-card-id={ADD_CAT_ID}
                    className="absolute rounded-2xl border border-dashed border-slate-300 dark:border-slate-700/60"
                    style={{
                      top: 0,
                      left: 0,
                      width: cardWidth > 0 ? cardWidth : undefined,
                      transform: pos ? `translate(${pos.x}px,${pos.y}px)` : undefined,
                      visibility: packPhase >= 1 && pos ? 'visible' : 'hidden',
                      transition: packPhase >= 2 && draggingCatId === null ? 'transform 300ms ease' : 'none',
                      willChange: 'transform',
                    }}
                  >
                    <button
                      onClick={() => setAddingCategory(true)}
                      className="w-full h-full flex items-center justify-center gap-2 p-5 py-8 text-sm text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 rounded-2xl hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <Plus size={15} />
                      {t('ribbon.addCategory')}
                    </button>
                  </div>
                )
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Floating actions, hidden in edit mode (which has its own per-category
          controls). Two tiers:
            • the filter/search tools, mobile only — desktop has them in the
              header — which collapse into the handle beneath them;
            • Add, at every breakpoint, anchoring the stack below that handle.
          Add sits outside the collapsible group deliberately: it creates rather
          than filters, and the primary action should stay put — and nearest the
          thumb — when the tools are put away. */}
      {!editMode && (
        <div className="fixed bottom-6 right-6 z-40 flex flex-col items-center gap-3 pointer-events-none">
        {!showEmpty && (
        <div className="min-[1060px]:hidden flex flex-col items-center gap-3">
          <button
            onClick={() => setAttentionOnly(!attentionOnly)}
            style={{ transitionDelay: `${fabsCollapsed ? 0 : 100}ms` }}
            className={`flex items-center justify-center w-16 h-16 rounded-full shadow-lg border active:scale-95 transition-all duration-300 ease-out ${
              fabsCollapsed ? 'opacity-0 translate-y-4 scale-90 pointer-events-none' : 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
            } ${
              attentionOnly
                ? 'bg-amber-500 dark:bg-amber-600 text-white border-amber-400/50'
                : 'bg-slate-800 dark:bg-slate-700 text-slate-100 border-slate-700 dark:border-slate-600 hover:bg-slate-700 dark:hover:bg-slate-600'
            }`}
            aria-pressed={attentionOnly}
            aria-label={t('ribbon.toggleSoonAriaLabel')}
            data-tooltip={t('app.soonTooltip')}
          >
            <Clock size={20} />
          </button>
          {multiUserEnabled && meId && (
            <button
              onClick={() => setFilter(filter === 'mine' ? 'all' : 'mine')}
              style={{ transitionDelay: '50ms' }}
              className={`flex items-center justify-center w-16 h-16 rounded-full shadow-lg border active:scale-95 transition-all duration-300 ease-out ${
                fabsCollapsed ? 'opacity-0 translate-y-4 scale-90 pointer-events-none' : 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
              } ${
                filter === 'mine'
                  ? 'bg-green-500 dark:bg-green-600 text-white border-green-400/50'
                  : 'bg-slate-800 dark:bg-slate-700 text-slate-100 border-slate-700 dark:border-slate-600 hover:bg-slate-700 dark:hover:bg-slate-600'
              }`}
              aria-label={t('ribbon.toggleMyTasksAriaLabel')}
            >
              <UserCircle size={20} />
            </button>
          )}
          <button
            onClick={() => setShowSearch(true)}
            style={{ transitionDelay: `${fabsCollapsed ? 100 : 0}ms` }}
            className={`flex items-center justify-center w-16 h-16 rounded-full bg-slate-800 dark:bg-slate-700 text-slate-100 shadow-lg border border-slate-700 dark:border-slate-600 hover:bg-slate-700 dark:hover:bg-slate-600 active:scale-95 transition-all duration-300 ease-out ${
              fabsCollapsed ? 'opacity-0 translate-y-4 scale-90 pointer-events-none' : 'opacity-100 translate-y-0 scale-100 pointer-events-auto'
            }`}
            aria-label={t('ribbon.searchChoresAriaLabel')}
            data-tooltip={t('ribbon.searchTitle')}
          >
            <Search size={20} />
          </button>
          <button
            onClick={toggleFabs}
            className="pointer-events-auto flex items-center justify-center w-11 h-11 rounded-full bg-slate-800/90 dark:bg-slate-700/90 text-slate-300 dark:text-slate-300 shadow-lg border border-slate-700 dark:border-slate-600 hover:bg-slate-700 dark:hover:bg-slate-600 active:scale-95 transition-all backdrop-blur-sm"
            aria-expanded={!fabsCollapsed}
            aria-label={fabsCollapsed ? t('ribbon.showFabsAriaLabel') : t('ribbon.hideFabsAriaLabel')}
          >
            {fabsCollapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          </button>
        </div>
        )}
          <button
            onClick={() => openNewChore()}
            className="pointer-events-auto flex items-center justify-center w-16 h-16 rounded-full bg-green-500 dark:bg-green-600 text-white shadow-lg border border-green-400/50 hover:bg-green-400 dark:hover:bg-green-500 active:scale-95 transition-all"
            aria-label={t('ribbon.addChoreAriaLabel')}
            data-tooltip={t('ribbon.addChoreTitle')}
          >
            <Plus size={24} />
          </button>
        </div>
      )}

      {selectedChore && !editMode && (
        <LogModal
          chore={selectedChore}
          onClose={closeChore}
          onLogged={() => { closeChore(); afterLog() }}
          onChanged={refresh}
        />
      )}

      {showSearch && (
        <SearchModal
          data={localData}
          onSelect={selectSearchResult}
          onCreate={createFromSearch}
          onClose={() => setShowSearch(false)}
        />
      )}

      {addingCategory && (
        <CategoryFormModal
          onClose={() => setAddingCategory(false)}
          onSaved={() => { setAddingCategory(false); refresh() }}
        />
      )}

      {newChoreCategory && (
        <ChoreFormModal
          category={newChoreCategory}
          allCategories={localData.flatMap(d => [d.category, ...d.subcategories.map(s => s.category)])}
          initialName={newChoreName}
          onClose={() => { setNewChoreCategory(null); setNewChoreName('') }}
          onSaved={() => { setNewChoreCategory(null); setNewChoreName(''); refresh() }}
        />
      )}
    </>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center h-full min-h-[60vh]">
      <p className="text-slate-400 dark:text-slate-500 text-sm">{t('ribbon.noCategories')}</p>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 transition-colors"
      >
        <Plus size={15} />
        {t('ribbon.addFirstCategory')}
      </button>
    </div>
  )
}

// Shown when active filters hide every category — either the "Soon" filter when
// nothing has aged into the amber zone, or the "Mine" filter when nothing is
// assigned to / shared with the current user.
function NoMatchesState({ message, onClear }: { message: string; onClear: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center h-full min-h-[60vh]">
      <Clock size={28} className="text-slate-300 dark:text-slate-600" />
      <p className="text-slate-400 dark:text-slate-500 text-sm">{message}</p>
      <button
        onClick={onClear}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
      >
        {t('ribbon.showAllChores')}
      </button>
    </div>
  )
}
