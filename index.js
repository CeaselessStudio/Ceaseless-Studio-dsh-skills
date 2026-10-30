/**
 * Хост-половина плагина «Скиллы».
 *
 * Каталог в интерфейсе строит клиентская половина: она зовёт RPC `skills/list`
 * для текущей сессии, то есть видит ровно тот список, что и меню `/`. Так вышло
 * не сразу: у хоста нет агента, поэтому `ctx.skills.list({ cwd })` отдаёт только
 * глобальный слой (встроенные и плагинные скиллы), а файловые живут в области
 * видимости пресета агента.
 *
 * Здесь остаётся то, чего браузер не может: чтение файла с диска и запасной
 * каталог на случай, если RPC недоступен.
 *
 *   GET /plugin/skills               - запасной каталог (без файловых скиллов)
 *   GET /plugin/skills/file?path=... - текст SKILL.md по пути
 *   GET /plugin/skills/item?name=... - текст скилла из реестра, когда файла нет:
 *                                      встроенные скиллы плагинов лежат в assets
 *                                      и операционного пути у них не бывает
 */

import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const LIST_ROUTE = '/plugin/skills'
const FILE_ROUTE = '/plugin/skills/file'
const ITEM_ROUTE = '/plugin/skills/item'
const DEFAULT_TTL_MS = 30000
const MAX_CONTENT_CHARS = 512 * 1024

// маркер загрузки модуля: отличает «пакет не импортирован» от «apply упал»
try {
  appendFileSync(join(HERE, '.activation.log'), `${new Date().toISOString()} import\n`)
} catch {
  // диагностика не должна мешать загрузке
}

// маршруты вешает веб-сервер, каталог собирает реестр скиллов
export const inject = ['webServer', 'skills']

const text = (value) => (typeof value === 'string' ? value : String(value ?? ''))

export function apply(ctx, config = {}) {
  const trace = (note) => {
    try {
      appendFileSync(join(HERE, '.activation.log'), `${new Date().toISOString()} ${note}\n`)
    } catch {
      // диагностика не должна мешать загрузке
    }
  }

  const log = (message) => {
    try {
      ctx.logger?.warn?.(`[skills] ${message}`)
    } catch {
      // логгер есть не во всех композициях
    }
  }

  const ttlMs = Math.max(5000, Number(config.ttlMs) || DEFAULT_TTL_MS)
  const configuredCwds = (Array.isArray(config.cwd) ? config.cwd : [config.cwd]).filter(
    (value) => typeof value === 'string' && value.trim() !== '',
  )

  const state = {
    data: null,
    fetchedAt: 0,
    durationMs: null,
    running: null,
    error: null,
  }

  const payload = () => ({
    ok: state.data !== null,
    fetchedAt: state.fetchedAt,
    durationMs: state.durationMs,
    refreshing: state.running !== null,
    error: state.error,
    data: state.data,
  })

  /**
   * Где искать проектные скиллы: явный конфиг, воркспейсы профиля, затем cwd
   * процесса. Личные и встроенные скиллы от cwd не зависят, поэтому в конце
   * списка стоит «без cwd» - так они попадут в каталог при любом раскладе.
   */
  function candidateCwds() {
    const list = []
    const push = (value) => {
      if (typeof value !== 'string' || value.trim() === '') return
      const path = value.trim()
      if (!list.includes(path)) list.push(path)
    }

    configuredCwds.forEach(push)

    try {
      const registry = ctx.get('workspaceRegistry')
      for (const workspace of registry?.list?.() ?? []) push(workspace?.path)
    } catch (error) {
      log(`реестр воркспейсов недоступен: ${text(error)}`)
    }

    push(process.cwd())
    return [...list, undefined]
  }

  function startRefresh() {
    if (state.running !== null) return state.running

    const started = Date.now()
    state.running = (async () => {
      const merged = new Map()
      for (const cwd of candidateCwds()) {
        let skills = []
        try {
          skills = await ctx.skills.list(cwd === undefined ? {} : { cwd })
        } catch (failure) {
          log(`каталог для ${cwd ?? 'без cwd'} не собран: ${text(failure?.message ?? failure)}`)
        }
        for (const skill of skills) if (!merged.has(skill.name)) merged.set(skill.name, skill)
      }

      state.data = {
        generatedAt: new Date().toISOString(),
        ttlMs,
        skills: [...merged.values()].sort((left, right) => (left.name < right.name ? -1 : 1)),
      }
      state.fetchedAt = Date.now()
      state.error = null
    })()
      .catch((error) => {
        state.error = text(error?.message ?? error)
        log(state.error)
      })
      .finally(() => {
        state.durationMs = Date.now() - started
        state.running = null
      })

    return state.running
  }

  /** Свежесть кэша: обновляем в фоне, ответ отдаём сразу из того, что есть. */
  function ensureFresh(force) {
    if (force || state.data === null || Date.now() - state.fetchedAt > ttlMs) void startRefresh()
  }

  const sendJson = (response, status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(JSON.stringify(body))
  }

  const listHandler = async (request, response) => {
    const url = new URL(request.url ?? LIST_ROUTE, 'http://localhost')
    ensureFresh(url.searchParams.get('refresh') === '1')
    // первый запрос после старта: сборка каталога уже идёт, ждём её, чтобы не
    // отдать пустой ответ (дальше отвечаем из кэша мгновенно)
    if (state.data === null && state.running !== null) {
      await Promise.race([state.running, new Promise((resolve) => setTimeout(resolve, 8000))])
    }
    sendJson(response, 200, payload())
  }

  /**
   * Файл скилла по пути из каталога. Маршрут локальный и неаутентифицированный,
   * поэтому читаем только то, что похоже на скилл: путь с каталогом `skills`,
   * файл `.md`, без переходов вверх.
   */
  const fileHandler = async (request, response) => {
    const url = new URL(request.url ?? FILE_ROUTE, 'http://localhost')
    const raw = url.searchParams.get('path') ?? ''
    if (raw === '') {
      sendJson(response, 400, { ok: false, error: 'не указан путь' })
      return
    }

    const target = resolve(raw)
    const looksLikeSkill =
      /[\\/]skills[\\/]/i.test(target) &&
      /\.md$/i.test(target) &&
      !target.split(/[\\/]/).includes('..')
    if (!looksLikeSkill) {
      sendJson(response, 403, { ok: false, error: 'путь не похож на файл скилла' })
      return
    }

    try {
      const content = await readFile(target, 'utf8')
      sendJson(response, 200, {
        ok: true,
        path: target,
        truncated: content.length > MAX_CONTENT_CHARS,
        content: content.slice(0, MAX_CONTENT_CHARS),
      })
    } catch (error) {
      const message = text(error?.message ?? error)
      log(`файл ${target} не прочитан: ${message}`)
      sendJson(response, 404, { ok: false, error: message })
    }
  }

  /**
   * Текст скилла из реестра, когда пути на диске нет: встроенные скиллы плагинов
   * лежат внутри их assets и операционным путём не адресуются. Тело отдаёт сам
   * провайдер, поэтому разбирать формат не нужно.
   */
  const itemHandler = async (request, response) => {
    const url = new URL(request.url ?? ITEM_ROUTE, 'http://localhost')
    const name = url.searchParams.get('name') ?? ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      sendJson(response, 400, { ok: false, error: 'некорректное имя скилла' })
      return
    }

    // проектные скиллы видны только в cwd своего воркспейса, встроенные - всегда
    for (const cwd of [...candidateCwds()]) {
      try {
        const skill = await ctx.skills.get(name, cwd === undefined ? {} : { cwd })
        if (skill === undefined || typeof skill.content !== 'string') continue
        sendJson(response, 200, {
          ok: true,
          name: skill.name,
          path: skill.path ?? null,
          provider: skill.provider ?? null,
          truncated: skill.content.length > MAX_CONTENT_CHARS,
          content: skill.content.slice(0, MAX_CONTENT_CHARS),
        })
        return
      } catch (error) {
        log(`скилл ${name} не открылся: ${text(error?.message ?? error)}`)
      }
    }

    sendJson(response, 404, { ok: false, error: `скилл "${name}" не отдаёт текст` })
  }

  const registerRoute = (server, path, handler) => {
    if (!server || typeof server.register !== 'function') {
      log('сервис webServer без метода register')
      return () => {}
    }
    try {
      return server.register({ kind: 'exact', path, handler })
    } catch (error) {
      log(`маршрут ${path} не зарегистрирован: ${text(error)}`)
      return () => {}
    }
  }

  try {
    ctx.effect(() => {
      const disposeList = registerRoute(ctx.webServer, LIST_ROUTE, listHandler)
      const disposeFile = registerRoute(ctx.webServer, FILE_ROUTE, fileHandler)
      const disposeItem = registerRoute(ctx.webServer, ITEM_ROUTE, itemHandler)

      ensureFresh(true)

      // провайдер прислал новый каталог (правка SKILL.md, смена пресета) - сбрасываем кэш
      let disposeChange = () => {}
      try {
        disposeChange = ctx.on('skills/change', () => {
          state.fetchedAt = 0
          ensureFresh(false)
        })
      } catch (error) {
        log(`подписка на skills/change не удалась: ${text(error)}`)
      }

      return () => {
        disposeList()
        disposeFile()
        disposeItem()
        disposeChange()
      }
    })
  } catch (error) {
    trace(`effect-error: ${String((error && error.stack) || error).split('\n').slice(0, 3).join(' | ')}`)
    throw error
  }
}
