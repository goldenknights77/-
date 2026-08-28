// D1 데이터베이스 접근 헬퍼

export interface ChannelRow {
  id: number
  channel_id: string
  title: string | null
  handle: string | null
  thumbnail: string | null
  uploads_playlist_id: string | null
  input_url: string | null
  active: number
  created_at: string
}

export interface RunRow {
  id: number
  run_date: string
  since_at: string
  started_at: string
  finished_at: string | null
  status: 'running' | 'completed' | 'failed'
  total_channels: number
  channels_checked: number
  channels_failed: number
  videos_found: number
  api_calls_used: number
  error: string | null
}

export interface RunVideoRow {
  id: number
  run_id: number
  channel_id: string
  channel_title: string
  channel_thumbnail: string
  video_id: string
  title: string
  published_at: string
  view_count: number
  like_count: number
  comment_count: number
  duration: string
  thumbnail: string
  video_url: string
  created_at: string
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run()
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM settings WHERE key = ?').bind(key).run()
}

export async function listChannels(db: D1Database): Promise<ChannelRow[]> {
  const res = await db.prepare('SELECT * FROM channels ORDER BY created_at DESC, id DESC').all<ChannelRow>()
  return res.results || []
}

export async function listActiveChannels(db: D1Database): Promise<ChannelRow[]> {
  const res = await db
    .prepare('SELECT * FROM channels WHERE active = 1 ORDER BY created_at ASC, id ASC')
    .all<ChannelRow>()
  return res.results || []
}

export async function findChannelByChannelId(db: D1Database, channelId: string): Promise<ChannelRow | null> {
  const row = await db.prepare('SELECT * FROM channels WHERE channel_id = ?').bind(channelId).first<ChannelRow>()
  return row || null
}

export async function insertChannel(
  db: D1Database,
  data: {
    channel_id: string
    title: string
    handle?: string | null
    thumbnail?: string | null
    uploads_playlist_id: string
    input_url: string
  }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO channels (channel_id, title, handle, thumbnail, uploads_playlist_id, input_url, active)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .bind(
      data.channel_id,
      data.title,
      data.handle || null,
      data.thumbnail || null,
      data.uploads_playlist_id,
      data.input_url
    )
    .run()
}

export async function deleteChannel(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM channels WHERE id = ?').bind(id).run()
}

export async function setChannelActive(db: D1Database, id: number, active: boolean): Promise<void> {
  await db.prepare('UPDATE channels SET active = ? WHERE id = ?').bind(active ? 1 : 0, id).run()
}

// ---------- Runs ----------

export async function getRunningRun(db: D1Database): Promise<RunRow | null> {
  const row = await db
    .prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1")
    .first<RunRow>()
  return row || null
}

export async function createRun(
  db: D1Database,
  runDate: string,
  sinceAt: string,
  channelIds: string[]
): Promise<RunRow> {
  const res = await db
    .prepare(
      `INSERT INTO runs (run_date, since_at, status, total_channels) VALUES (?, ?, 'running', ?)`
    )
    .bind(runDate, sinceAt, channelIds.length)
    .run()
  const runId = res.meta.last_row_id as number

  if (channelIds.length > 0) {
    const stmt = db.prepare('INSERT INTO run_queue (run_id, channel_id, status) VALUES (?, ?, ?)')
    const batch = channelIds.map((cid) => stmt.bind(runId, cid, 'pending'))
    // D1 batch API caps around 1000 statements; 200 channels is safe in one batch.
    await db.batch(batch)
  }

  const run = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(runId).first<RunRow>()
  return run as RunRow
}

export async function getRun(db: D1Database, id: number): Promise<RunRow | null> {
  const row = await db.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first<RunRow>()
  return row || null
}

export async function listRuns(db: D1Database, limit = 60): Promise<RunRow[]> {
  const res = await db
    .prepare('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?')
    .bind(limit)
    .all<RunRow>()
  return res.results || []
}

export async function getPendingQueue(
  db: D1Database,
  runId: number,
  limit: number
): Promise<{ id: number; channel_id: string }[]> {
  const res = await db
    .prepare("SELECT id, channel_id FROM run_queue WHERE run_id = ? AND status = 'pending' ORDER BY id ASC LIMIT ?")
    .bind(runId, limit)
    .all<{ id: number; channel_id: string }>()
  return res.results || []
}

export async function countQueue(
  db: D1Database,
  runId: number
): Promise<{ pending: number; done: number; failed: number; total: number }> {
  const res = await db
    .prepare(
      `SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COUNT(*) as total
       FROM run_queue WHERE run_id = ?`
    )
    .bind(runId)
    .first<any>()
  return {
    pending: Number(res?.pending || 0),
    done: Number(res?.done || 0),
    failed: Number(res?.failed || 0),
    total: Number(res?.total || 0)
  }
}

export async function markQueueDone(db: D1Database, queueId: number): Promise<void> {
  await db.prepare("UPDATE run_queue SET status = 'done' WHERE id = ?").bind(queueId).run()
}

export async function markQueueFailed(db: D1Database, queueId: number, error: string): Promise<void> {
  await db.prepare("UPDATE run_queue SET status = 'failed', error = ? WHERE id = ?").bind(error, queueId).run()
}

export async function insertRunVideos(
  db: D1Database,
  runId: number,
  videos: Array<{
    channel_id: string
    channel_title: string
    channel_thumbnail: string
    video_id: string
    title: string
    published_at: string
    view_count: number
    like_count: number
    comment_count: number
    duration: string
    thumbnail: string
    video_url: string
  }>
): Promise<void> {
  if (videos.length === 0) return
  const stmt = db.prepare(
    `INSERT INTO run_videos
      (run_id, channel_id, channel_title, channel_thumbnail, video_id, title, published_at,
       view_count, like_count, comment_count, duration, thumbnail, video_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const batch = videos.map((v) =>
    stmt.bind(
      runId,
      v.channel_id,
      v.channel_title,
      v.channel_thumbnail,
      v.video_id,
      v.title,
      v.published_at,
      v.view_count,
      v.like_count,
      v.comment_count,
      v.duration,
      v.thumbnail,
      v.video_url
    )
  )
  await db.batch(batch)
}

export async function insertRunError(
  db: D1Database,
  runId: number,
  channelId: string,
  channelTitle: string,
  message: string
): Promise<void> {
  await db
    .prepare('INSERT INTO run_errors (run_id, channel_id, channel_title, message) VALUES (?, ?, ?, ?)')
    .bind(runId, channelId, channelTitle, message)
    .run()
}

export async function incrementRunCounters(
  db: D1Database,
  runId: number,
  delta: { checked?: number; failed?: number; videosFound?: number; apiCalls?: number }
): Promise<void> {
  await db
    .prepare(
      `UPDATE runs SET
        channels_checked = channels_checked + ?,
        channels_failed = channels_failed + ?,
        videos_found = videos_found + ?,
        api_calls_used = api_calls_used + ?
       WHERE id = ?`
    )
    .bind(delta.checked || 0, delta.failed || 0, delta.videosFound || 0, delta.apiCalls || 0, runId)
    .run()
}

export async function finishRun(db: D1Database, runId: number, status: 'completed' | 'failed', error?: string): Promise<void> {
  await db
    .prepare("UPDATE runs SET status = ?, finished_at = datetime('now'), error = ? WHERE id = ?")
    .bind(status, error || null, runId)
    .run()
}

export async function getRunVideos(db: D1Database, runId: number, minViews = 0): Promise<RunVideoRow[]> {
  const res = await db
    .prepare(
      `SELECT * FROM run_videos WHERE run_id = ? AND view_count >= ? ORDER BY view_count DESC, published_at DESC`
    )
    .bind(runId, minViews)
    .all<RunVideoRow>()
  return res.results || []
}

export async function getRunErrors(db: D1Database, runId: number): Promise<any[]> {
  const res = await db
    .prepare('SELECT * FROM run_errors WHERE run_id = ? ORDER BY id ASC')
    .bind(runId)
    .all()
  return res.results || []
}

export async function deleteRun(db: D1Database, runId: number): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM run_videos WHERE run_id = ?').bind(runId),
    db.prepare('DELETE FROM run_errors WHERE run_id = ?').bind(runId),
    db.prepare('DELETE FROM run_queue WHERE run_id = ?').bind(runId),
    db.prepare('DELETE FROM runs WHERE id = ?').bind(runId)
  ])
}
