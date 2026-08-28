import { Hono } from 'hono'
import { renderer } from './renderer'
import {
  getSetting,
  setSetting,
  deleteSetting,
  listChannels,
  listActiveChannels,
  findChannelByChannelId,
  insertChannel,
  deleteChannel,
  setChannelActive,
  createRun,
  getRun,
  listRuns,
  getPendingQueue,
  countQueue,
  markQueueDone,
  markQueueFailed,
  insertRunVideos,
  insertRunError,
  incrementRunCounters,
  finishRun,
  getRunVideos,
  getRunErrors,
  deleteRun,
  getRunningRun
} from './lib/db'
import {
  parseChannelInput,
  resolveChannelsByIds,
  resolveChannelGeneric,
  fetchRecentPlaylistVideos,
  fetchVideoStats,
  formatDuration,
  newTracker,
  YouTubeApiError
} from './lib/youtube'
import { maskApiKey } from './lib/mask'
import { nowISO, isoMinusHours, seoulDateString, seoulDateTimeString } from './lib/time'

type Bindings = {
  DB: D1Database
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(renderer)

const API_KEY_SETTING = 'youtube_api_key'

// ---------------------------------------------------------------------------
// Settings API
// ---------------------------------------------------------------------------

app.get('/api/settings', async (c) => {
  const key = await getSetting(c.env.DB, API_KEY_SETTING)
  return c.json({
    hasApiKey: !!key,
    apiKeyMasked: key ? maskApiKey(key) : null
  })
})

app.post('/api/settings/api-key', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const apiKey = (body?.apiKey || '').trim()
  if (!apiKey) {
    return c.json({ error: 'API 키를 입력해주세요.' }, 400)
  }
  // 간단한 검증 호출 (채널 조회 1건, 1 unit 소모)
  try {
    await resolveChannelsByIds(apiKey, ['UC_x5XG1OV2P6uZZ5FSM9Ttw']) // Google Developers 채널 (검증용)
  } catch (e: any) {
    if (e instanceof YouTubeApiError) {
      return c.json({ error: `API 키 검증 실패: ${e.message}` }, 400)
    }
    return c.json({ error: 'API 키 검증 중 오류가 발생했습니다.' }, 400)
  }
  await setSetting(c.env.DB, API_KEY_SETTING, apiKey)
  return c.json({ ok: true, apiKeyMasked: maskApiKey(apiKey) })
})

app.delete('/api/settings/api-key', async (c) => {
  await deleteSetting(c.env.DB, API_KEY_SETTING)
  return c.json({ ok: true })
})

async function requireApiKey(c: any): Promise<string | null> {
  const key = await getSetting(c.env.DB, API_KEY_SETTING)
  return key
}

// ---------------------------------------------------------------------------
// Channels API
// ---------------------------------------------------------------------------

app.get('/api/channels', async (c) => {
  const channels = await listChannels(c.env.DB)
  return c.json({ channels })
})

app.delete('/api/channels/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '잘못된 채널 id 입니다.' }, 400)
  await deleteChannel(c.env.DB, id)
  return c.json({ ok: true })
})

app.patch('/api/channels/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '잘못된 채널 id 입니다.' }, 400)
  const body = await c.req.json().catch(() => ({}))
  await setChannelActive(c.env.DB, id, !!body.active)
  return c.json({ ok: true })
})

// ---- 대량 등록 (배치 처리) ----
// 메모리 내 간단 잡 큐를 D1 없이 클라이언트가 직접 관리하도록,
// 클라이언트가 라인 배열을 청크로 나눠 여러 번 호출하는 방식으로 구현합니다.
// (별도 import job 테이블 없이도 충분히 안정적으로 동작)

app.post('/api/channels/resolve-batch', async (c) => {
  const apiKey = await requireApiKey(c)
  if (!apiKey) return c.json({ error: 'YouTube API 키를 먼저 등록해주세요.' }, 400)

  const body = await c.req.json().catch(() => ({}))
  const lines: string[] = Array.isArray(body?.lines) ? body.lines : []
  if (lines.length === 0) return c.json({ results: [] })

  const parsedList = lines.map((l) => ({ raw: l, parsed: parseChannelInput(l) })).filter((x) => x.parsed)

  const results: Array<{
    raw: string
    status: 'added' | 'duplicated' | 'failed'
    channelId?: string
    title?: string
    error?: string
  }> = []

  // id 종류는 벌크로 한번에 처리
  const idItems = parsedList.filter((x) => x.parsed!.kind === 'id')
  const otherItems = parsedList.filter((x) => x.parsed!.kind !== 'id')

  try {
    if (idItems.length > 0) {
      const idList = idItems.map((x) => x.parsed!.value)
      const map = await resolveChannelsByIds(apiKey, idList)
      for (const item of idItems) {
        const info = map.get(item.parsed!.value)
        if (!info) {
          results.push({ raw: item.raw, status: 'failed', error: '채널을 찾을 수 없습니다.' })
          continue
        }
        const exists = await findChannelByChannelId(c.env.DB, info.channelId)
        if (exists) {
          results.push({ raw: item.raw, status: 'duplicated', channelId: info.channelId, title: info.title })
          continue
        }
        await insertChannel(c.env.DB, {
          channel_id: info.channelId,
          title: info.title,
          handle: info.handle,
          thumbnail: info.thumbnail,
          uploads_playlist_id: info.uploadsPlaylistId,
          input_url: item.raw
        })
        results.push({ raw: item.raw, status: 'added', channelId: info.channelId, title: info.title })
      }
    }

    for (const item of otherItems) {
      try {
        const info = await resolveChannelGeneric(apiKey, item.parsed!)
        if (!info) {
          results.push({ raw: item.raw, status: 'failed', error: '채널을 찾을 수 없습니다.' })
          continue
        }
        const exists = await findChannelByChannelId(c.env.DB, info.channelId)
        if (exists) {
          results.push({ raw: item.raw, status: 'duplicated', channelId: info.channelId, title: info.title })
          continue
        }
        await insertChannel(c.env.DB, {
          channel_id: info.channelId,
          title: info.title,
          handle: info.handle,
          thumbnail: info.thumbnail,
          uploads_playlist_id: info.uploadsPlaylistId,
          input_url: item.raw
        })
        results.push({ raw: item.raw, status: 'added', channelId: info.channelId, title: info.title })
      } catch (e: any) {
        if (e instanceof YouTubeApiError && e.reason === 'quotaExceeded') {
          results.push({ raw: item.raw, status: 'failed', error: 'API 일일 쿼터가 초과되었습니다.' })
          // 쿼터 초과 시 나머지는 더 시도하지 않고 중단
          return c.json({ results, quotaExceeded: true })
        }
        results.push({ raw: item.raw, status: 'failed', error: e?.message || '알 수 없는 오류' })
      }
    }
  } catch (e: any) {
    if (e instanceof YouTubeApiError && e.reason === 'quotaExceeded') {
      return c.json({ results, quotaExceeded: true })
    }
    return c.json({ error: e?.message || '처리 중 오류가 발생했습니다.' }, 500)
  }

  return c.json({ results })
})

// ---------------------------------------------------------------------------
// Runs API (오늘의 24시간 체크)
// ---------------------------------------------------------------------------

const CHANNELS_PER_STEP = 8

app.post('/api/runs', async (c) => {
  const apiKey = await requireApiKey(c)
  if (!apiKey) return c.json({ error: 'YouTube API 키를 먼저 등록해주세요.' }, 400)

  const existing = await getRunningRun(c.env.DB)
  if (existing) {
    return c.json({ run: existing, resumed: true })
  }

  const channels = await listActiveChannels(c.env.DB)
  if (channels.length === 0) {
    return c.json({ error: '등록된 활성 채널이 없습니다. 먼저 채널을 추가해주세요.' }, 400)
  }

  const since = isoMinusHours(24)
  const run = await createRun(c.env.DB, seoulDateString(), since, channels.map((ch) => ch.channel_id))
  return c.json({ run })
})

app.get('/api/runs', async (c) => {
  const runs = await listRuns(c.env.DB)
  return c.json({ runs })
})

app.get('/api/runs/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const run = await getRun(c.env.DB, id)
  if (!run) return c.json({ error: 'not found' }, 404)
  const queue = await countQueue(c.env.DB, id)
  return c.json({ run, queue })
})

app.delete('/api/runs/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '잘못된 실행 id 입니다.' }, 400)
  await deleteRun(c.env.DB, id)
  return c.json({ ok: true })
})

app.get('/api/runs/:id/videos', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '잘못된 실행 id 입니다.' }, 400)
  const minViews = Number(c.req.query('minViews') || '0')
  const videos = await getRunVideos(c.env.DB, id, minViews)
  return c.json({ videos })
})

app.get('/api/runs/:id/errors', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '잘못된 실행 id 입니다.' }, 400)
  const errors = await getRunErrors(c.env.DB, id)
  return c.json({ errors })
})

// 채널 배치 하나를 처리 (클라이언트가 완료될 때까지 반복 호출)
app.post('/api/runs/:id/step', async (c) => {
  const runId = Number(c.req.param('id'))
  const apiKey = await requireApiKey(c)
  if (!apiKey) return c.json({ error: 'YouTube API 키를 먼저 등록해주세요.' }, 400)

  const run = await getRun(c.env.DB, runId)
  if (!run) return c.json({ error: 'not found' }, 404)

  if (run.status !== 'running') {
    const queue = await countQueue(c.env.DB, runId)
    return c.json({ run, queue, done: true })
  }

  const batch = await getPendingQueue(c.env.DB, runId, CHANNELS_PER_STEP)
  if (batch.length === 0) {
    await finishRun(c.env.DB, runId, 'completed')
    const finished = await getRun(c.env.DB, runId)
    const queue = await countQueue(c.env.DB, runId)
    return c.json({ run: finished, queue, done: true })
  }

  const tracker = newTracker()
  const channels = await listChannels(c.env.DB)
  const channelMap = new Map(channels.map((ch) => [ch.channel_id, ch]))

  let checked = 0
  let failed = 0
  let videosFoundTotal = 0
  let quotaExceeded = false

  // 각 채널별로 재생목록 조회 -> videoId 목록 취합
  type PerChannelRefs = { channel: (typeof channels)[number]; queueId: number; refs: { videoId: string; publishedAt: string }[] }
  const perChannel: PerChannelRefs[] = []

  for (const q of batch) {
    if (quotaExceeded) {
      await markQueueFailed(c.env.DB, q.id, '쿼터 초과로 처리되지 않음')
      failed++
      continue
    }
    const ch = channelMap.get(q.channel_id)
    if (!ch || !ch.uploads_playlist_id) {
      await markQueueFailed(c.env.DB, q.id, '채널 정보를 찾을 수 없습니다.')
      await insertRunError(c.env.DB, runId, q.channel_id, ch?.title || '', '채널 정보를 찾을 수 없습니다.')
      failed++
      continue
    }
    try {
      const refs = await fetchRecentPlaylistVideos(apiKey, ch.uploads_playlist_id, run.since_at, tracker)
      perChannel.push({ channel: ch, queueId: q.id, refs })
    } catch (e: any) {
      const message = e instanceof YouTubeApiError ? e.message : e?.message || '알 수 없는 오류'
      await markQueueFailed(c.env.DB, q.id, message)
      await insertRunError(c.env.DB, runId, q.channel_id, ch.title || '', message)
      failed++
      if (e instanceof YouTubeApiError && e.reason === 'quotaExceeded') {
        quotaExceeded = true
      }
    }
  }

  // 이 배치에서 모인 모든 videoId를 한번에 통계 조회 (호출 수 최소화)
  const allVideoIds = Array.from(new Set(perChannel.flatMap((p) => p.refs.map((r) => r.videoId))))
  let statsMap = new Map<string, any>()
  if (allVideoIds.length > 0 && !quotaExceeded) {
    try {
      statsMap = await fetchVideoStats(apiKey, allVideoIds, tracker)
    } catch (e: any) {
      if (e instanceof YouTubeApiError && e.reason === 'quotaExceeded') {
        quotaExceeded = true
      }
      // 통계 조회 실패 시에도 채널 자체는 checked 처리하되 영상 없이 진행
    }
  }

  const videosToInsert: any[] = []
  for (const p of perChannel) {
    for (const ref of p.refs) {
      const stat = statsMap.get(ref.videoId)
      if (!stat) continue
      videosToInsert.push({
        channel_id: p.channel.channel_id,
        channel_title: p.channel.title || '',
        channel_thumbnail: p.channel.thumbnail || '',
        video_id: stat.videoId,
        title: stat.title,
        published_at: stat.publishedAt || ref.publishedAt,
        view_count: stat.viewCount,
        like_count: stat.likeCount,
        comment_count: stat.commentCount,
        duration: formatDuration(stat.duration),
        thumbnail: stat.thumbnail,
        video_url: `https://www.youtube.com/watch?v=${stat.videoId}`
      })
    }
    await markQueueDone(c.env.DB, p.queueId)
    checked++
  }
  videosFoundTotal += videosToInsert.length

  if (videosToInsert.length > 0) {
    await insertRunVideos(c.env.DB, runId, videosToInsert)
  }

  await incrementRunCounters(c.env.DB, runId, {
    checked,
    failed,
    videosFound: videosFoundTotal,
    apiCalls: tracker.calls
  })

  if (quotaExceeded) {
    await finishRun(c.env.DB, runId, 'failed', 'YouTube API 일일 쿼터가 초과되어 중단되었습니다.')
    const finished = await getRun(c.env.DB, runId)
    const queue = await countQueue(c.env.DB, runId)
    return c.json({ run: finished, queue, done: true, quotaExceeded: true })
  }

  const queue = await countQueue(c.env.DB, runId)
  const updatedRun = await getRun(c.env.DB, runId)
  const done = queue.pending === 0
  if (done && updatedRun && updatedRun.status === 'running') {
    await finishRun(c.env.DB, runId, 'completed')
  }
  const finalRun = done ? await getRun(c.env.DB, runId) : updatedRun

  return c.json({ run: finalRun, queue, done })
})

// ---------------------------------------------------------------------------
// Frontend
// ---------------------------------------------------------------------------

app.get('/', (c) => {
  return c.render(
    <div id="app">
      <div class="loading-shell">불러오는 중...</div>
    </div>
  )
})

export default app
