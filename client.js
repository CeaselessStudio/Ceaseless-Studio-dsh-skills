/**
 * Клиентская половина плагина «Скиллы».
 *
 * Кнопка «Скиллы» в шапке чата: счётчик и поповер с каталогом. Каталог приходит
 * из RPC `skills/list` для текущей сессии - это тот же список, что видит меню
 * `/`, включая файловые скиллы проекта и личные. Если сессия ещё не готова,
 * панель откатывается на запасной каталог хоста (только встроенные и плагинные)
 * и честно пишет об этом.
 *
 * Текст SKILL.md приходит с хоста отдельным запросом: браузер файлы не читает.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-skills',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const FILE_ENDPOINT = '/plugin/skills/file'
    const ITEM_ENDPOINT = '/plugin/skills/item'
    const FALLBACK_ENDPOINT = '/plugin/skills'
    const CACHE_MS = 60000

    // контекст плагина: нужен компоненту, чтобы позвать RPC каталога
    let clientCtx = null

    // порядок групп в панели
    const GROUPS = [
      ['dsh', 'Проект · .dsh/skills'],
      ['agents', '.agents/skills'],
      ['claude', '.claude/skills'],
      ['other', 'Другие каталоги'],
      ['builtin', 'Без файла · встроенные'],
    ]
    const GROUP_ORDER = new Map(GROUPS.map(([key], index) => [key, index]))
    const GROUP_LABELS = new Map(GROUPS)

    const T = {
      text: 'var(--dsw-alias-text-primary, #e6e6e6)',
      dim: 'var(--dsw-alias-text-secondary, rgba(230,230,230,0.6))',
      faint: 'var(--dsw-alias-text-tertiary, rgba(230,230,230,0.4))',
      bg: 'var(--dsw-alias-bg-elevated, #1c1c20)',
      border: 'var(--dsw-alias-border-subtle, rgba(255,255,255,0.12))',
      hover: 'var(--dsw-alias-bg-hover, rgba(255,255,255,0.06))',
      danger: '#f85149',
      warn: '#d29922',
      mono: 'var(--dsw-alias-font-mono, ui-monospace, Consolas, monospace)',
    }

    function timeOf(stamp) {
      if (!stamp) return '-'
      const date = new Date(stamp)
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    /** Источник выводим из пути: RPC отдаёт только имя, описание и путь. */
    function groupOf(skill) {
      const path = skill.path ?? ''
      if (path === '') return 'builtin'
      if (/[\\/]\.dsh[\\/]skills[\\/]/i.test(path)) return 'dsh'
      if (/[\\/]\.agents[\\/]skills[\\/]/i.test(path)) return 'agents'
      if (/[\\/]\.claude[\\/]skills[\\/]/i.test(path)) return 'claude'
      return 'other'
    }

    function groupSkills(skills) {
      const groups = new Map()
      for (const skill of skills) {
        const key = groupOf(skill)
        const bucket = groups.get(key) ?? []
        bucket.push(skill)
        groups.set(key, bucket)
      }
      return [...groups.entries()]
        .sort(([left], [right]) => (GROUP_ORDER.get(left) ?? 99) - (GROUP_ORDER.get(right) ?? 99))
        .map(([key, rows]) => ({ key, label: GROUP_LABELS.get(key) ?? key, rows }))
    }

    function Star() {
      return h(
        'svg',
        { width: 11, height: 11, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { flex: '0 0 auto' } },
        h('path', {
          d: 'M8 1.6l1.75 4.4 4.65.35-3.55 3 1.1 4.6L8 11.35 4.05 13.95l1.1-4.6L1.6 6.35l4.65-.35z',
          fill: 'currentColor',
        }),
      )
    }

    function Pill({ children, tone = 'dim' }) {
      return h(
        'span',
        {
          style: {
            fontSize: '10px',
            lineHeight: 1.4,
            padding: '0 5px',
            borderRadius: '4px',
            border: `1px solid ${T.border}`,
            color: tone === 'dim' ? T.faint : T.dim,
            whiteSpace: 'nowrap',
          },
        },
        children,
      )
    }

    function Badges({ skill }) {
      return h(
        'span',
        { style: { display: 'inline-flex', gap: '4px', flexWrap: 'wrap' } },
        h(Pill, null, skill.modelInvocable ? 'модель' : 'только /имя'),
      )
    }

    function Body({ detail }) {
      if (detail === undefined || detail.loading) {
        return h('div', { style: { padding: '6px 10px 10px', fontSize: '11px', color: T.dim } }, 'Загружаю текст…')
      }
      if (detail.error) {
        return h('div', { style: { padding: '6px 10px 10px', fontSize: '11px', color: T.danger } }, detail.error)
      }
      return h(
        'div',
        { style: { padding: '2px 10px 10px' } },
        h(
          'pre',
          {
            style: {
              margin: 0,
              maxHeight: '38vh',
              overflow: 'auto',
              padding: '8px',
              borderRadius: '6px',
              background: 'rgba(0,0,0,0.28)',
              border: `1px solid ${T.border}`,
              fontSize: '11px',
              lineHeight: 1.5,
              fontFamily: T.mono,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: T.text,
            },
          },
          detail.content,
        ),
        detail.truncated ? h('div', { style: { marginTop: '4px', fontSize: '10px', color: T.faint } }, 'текст обрезан') : null,
      )
    }

    function Row({ skill, detail, expanded, onToggle }) {
      return h(
        'div',
        { style: { borderBottom: `1px solid ${T.border}` } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => onToggle(skill.name),
            'aria-expanded': expanded,
            title: skill.path ?? 'встроенный скилл без файла',
            style: {
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '6px 10px',
              background: expanded ? T.hover : 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              font: 'inherit',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('span', { style: { fontSize: '12px', color: T.text, fontFamily: T.mono } }, skill.name),
            h('span', { style: { flex: '1 1 auto' } }),
            h(Badges, { skill }),
            h('span', { style: { fontSize: '10px', color: T.faint } }, expanded ? '▾' : '▸'),
          ),
          h(
            'div',
            {
              style: {
                marginTop: '2px',
                fontSize: '11px',
                lineHeight: 1.45,
                color: T.dim,
                display: '-webkit-box',
                WebkitLineClamp: expanded ? 'unset' : 2,
                WebkitBoxOrient: 'vertical',
                overflow: expanded ? 'visible' : 'hidden',
              },
            },
            skill.description,
          ),
        ),
        expanded ? h(Body, { detail }) : null,
      )
    }

    function Panel({ state, cache, expanded, onToggle, onRefresh, refreshing }) {
      const [query, setQuery] = useState('')
      const skills = state.skills

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase()
        if (needle === '') return skills
        return skills.filter(
          (skill) =>
            skill.name.toLowerCase().includes(needle) ||
            (skill.description ?? '').toLowerCase().includes(needle) ||
            (skill.whenToUse ?? '').toLowerCase().includes(needle),
        )
      }, [skills, query])

      const groups = useMemo(() => groupSkills(visible), [visible])
      const hidden = skills.length - visible.length

      return h(
        'div',
        {
          role: 'dialog',
          'aria-label': 'Скиллы',
          onMouseDown: (event) => event.stopPropagation(),
          style: {
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: '480px',
            maxHeight: '66vh',
            display: 'flex',
            flexDirection: 'column',
            background: T.bg,
            color: T.text,
            border: `1px solid ${T.border}`,
            borderRadius: '10px',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
            zIndex: 40,
            overflow: 'hidden',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 10px 6px',
              borderBottom: `1px solid ${T.border}`,
            },
          },
          h('div', { style: { fontSize: '12px', fontWeight: 600 } }, 'Скиллы'),
          h('span', { style: { fontSize: '11px', color: T.dim } }, String(skills.length)),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: { fontSize: '11px', color: T.faint } }, timeOf(state.fetchedAt)),
          h(
            'button',
            {
              type: 'button',
              onClick: onRefresh,
              disabled: refreshing,
              style: {
                fontSize: '11px',
                color: T.text,
                background: 'transparent',
                border: `1px solid ${T.border}`,
                borderRadius: '6px',
                padding: '2px 8px',
                cursor: refreshing ? 'default' : 'pointer',
                opacity: refreshing ? 0.6 : 1,
              },
            },
            refreshing ? 'Обновляю…' : 'Обновить',
          ),
        ),
        h(
          'div',
          { style: { padding: '6px 10px', borderBottom: `1px solid ${T.border}` } },
          h('input', {
            type: 'search',
            value: query,
            placeholder: 'Поиск по имени и описанию',
            onChange: (event) => setQuery(event.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '4px 8px',
              fontSize: '11px',
              color: T.text,
              background: 'transparent',
              border: `1px solid ${T.border}`,
              borderRadius: '6px',
              outline: 'none',
            },
          }),
        ),
        h(
          'div',
          { style: { overflow: 'auto', flex: '1 1 auto' } },
          state.partial
            ? h(
                'div',
                { style: { padding: '8px 10px', fontSize: '11px', color: T.warn, borderBottom: `1px solid ${T.border}` } },
                state.partial,
              )
            : null,
          state.error
            ? h('div', { style: { padding: '10px', fontSize: '11px', color: T.danger } }, state.error)
            : null,
          skills.length === 0 && !state.error
            ? h('div', { style: { padding: '12px 10px', fontSize: '12px', color: T.dim } }, 'скиллов нет')
            : null,
          visible.length === 0 && skills.length > 0
            ? h('div', { style: { padding: '12px 10px', fontSize: '12px', color: T.dim } }, 'ничего не найдено')
            : null,
          groups.map((group) =>
            h(
              'div',
              { key: group.key },
              h(
                'div',
                {
                  style: {
                    padding: '8px 10px 4px',
                    fontSize: '10px',
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: T.faint,
                  },
                },
                `${group.label} - ${group.rows.length}`,
              ),
              group.rows.map((skill) =>
                h(Row, {
                  key: skill.name,
                  skill,
                  detail: cache[skill.name],
                  expanded: expanded === skill.name,
                  onToggle,
                }),
              ),
            ),
          ),
          hidden > 0
            ? h('div', { style: { padding: '8px 10px', fontSize: '10px', color: T.faint } }, `скрыто фильтром: ${hidden}`)
            : null,
        ),
      )
    }

    const emptyState = { skills: [], fetchedAt: 0, partial: null, error: null }

    async function fetchCatalog(sessionId) {
      // 1) RPC сессии: полный каталог, тот же, что у меню `/`
      if (sessionId !== undefined && clientCtx?.remote?.skills !== undefined) {
        try {
          const result = await clientCtx.remote.skills.list({ sessionId }, new AbortController().signal)
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          return {
            skills: result.value.skills.map((skill) => ({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse ?? null,
              path: skill.path ?? null,
              modelInvocable: Boolean(skill.modelInvocable),
            })),
            partial: null,
          }
        } catch (error) {
          // 2) запасной каталог хоста: только встроенные и плагинные скиллы
          const response = await fetch(FALLBACK_ENDPOINT, { cache: 'no-store' })
          const body = await response.json()
          return {
            skills: (body.data?.skills ?? []).map((skill) => ({
              name: skill.name,
              description: skill.description,
              whenToUse: skill.whenToUse ?? null,
              path: skill.path ?? null,
              modelInvocable: Boolean(skill.invocation?.modelInvocable),
            })),
            partial: `каталог сессии недоступен (${String(error?.message ?? error)}), показаны только встроенные скиллы`,
          }
        }
      }

      const response = await fetch(FALLBACK_ENDPOINT, { cache: 'no-store' })
      const body = await response.json()
      return {
        skills: (body.data?.skills ?? []).map((skill) => ({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse ?? null,
          path: skill.path ?? null,
          modelInvocable: Boolean(skill.invocation?.modelInvocable),
        })),
        partial: 'сессия не определена, показаны только встроенные скиллы',
      }
    }

    function SkillsButton(props) {
      // сессию даёт сам слот (`inject` в регистрации); без неё каталог RPC не открыть
      const sessionId = props?.sessionId ?? props?.session?.sessionId
      const [open, setOpen] = useState(false)
      const [state, setState] = useState(emptyState)
      const [busy, setBusy] = useState(false)
      const [expanded, setExpanded] = useState(null)
      const [cache, setCache] = useState({})

      // зеркала для колбэков: замыкание useCallback не должно держать первый рендер
      const stateRef = useRef(state)
      stateRef.current = state
      const cacheRef = useRef({})
      const rootRef = useRef(null)

      const putCache = useCallback((name, entry) => {
        cacheRef.current = { ...cacheRef.current, [name]: entry }
        setCache(cacheRef.current)
      }, [])

      const load = useCallback(async () => {
        setBusy(true)
        try {
          const next = await fetchCatalog(sessionId)
          setState({ ...next, fetchedAt: Date.now(), error: null })
        } catch (error) {
          setState((current) => ({ ...current, error: String(error?.message ?? error) }))
        } finally {
          setBusy(false)
        }
      }, [sessionId])

      useEffect(() => {
        void load()
      }, [load])

      // пока панель открыта, каталог перечитывается раз в минуту: правки SKILL.md
      // подхватываются без перезагрузки страницы
      useEffect(() => {
        if (!open) return undefined
        const timer = setInterval(() => void load(), CACHE_MS)
        return () => clearInterval(timer)
      }, [open, load])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open])

      // клик по скиллу: текст берём у хоста, результат живёт в памяти панели
      const openSkill = useCallback(
        (name) => {
          setExpanded((current) => (current === name ? null : name))
          if (cacheRef.current[name] !== undefined) return

          const skill = stateRef.current.skills.find((item) => item.name === name)
          if (skill === undefined) return

          // файл читаем по пути; у встроенных скиллов пути нет - тело отдаёт реестр хоста
          const url = skill.path
            ? `${FILE_ENDPOINT}?path=${encodeURIComponent(skill.path)}`
            : `${ITEM_ENDPOINT}?name=${encodeURIComponent(name)}`

          putCache(name, { loading: true })
          void (async () => {
            let entry
            try {
              const response = await fetch(url, { cache: 'no-store' })
              const body = await response.json()
              entry = body.ok
                ? { content: body.content ?? '', truncated: Boolean(body.truncated) }
                : { error: body.error }
            } catch (error) {
              entry = { error: String(error?.message ?? error) }
            }
            putCache(name, entry)
          })()
        },
        [putCache],
      )

      const count = state.skills.length
      const title =
        state.error !== null
          ? `Скиллы: ${state.error}`
          : state.fetchedAt === 0
            ? 'Скиллы: загружаю каталог'
            : `Скиллы: ${count}`

      return h(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            title,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '24px',
              padding: '0 8px',
              fontSize: '11px',
              color: T.text,
              background: open ? T.hover : 'transparent',
              border: `1px solid ${T.border}`,
              borderRadius: '6px',
              cursor: 'pointer',
            },
          },
          h(Star, null),
          'Скиллы',
          state.fetchedAt === 0 ? null : h('span', { style: { fontSize: '10px', color: T.dim } }, String(count)),
        ),
        open
          ? h(Panel, {
              state,
              cache,
              expanded,
              onToggle: openSkill,
              onRefresh: () => void load(),
              refreshing: busy,
            })
          : null,
      )
    }

    return {
      inject: ['slots', 'remote', 'remote.skills'],
      apply(ctx) {
        clientCtx = ctx
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'skills-panel',
              order: 91,
              inject: (sessionId) => ({ sessionId }),
            },
            SkillsButton,
          ),
        )
      },
    }
  },
})
