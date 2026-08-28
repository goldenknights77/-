// YouTube Data API v3 헬퍼 모듈
// - 쿼터 절약을 위해 가능한 배치(batch) 호출을 사용합니다.

const API_BASE = 'https://www.googleapis.com/youtube/v3'

export interface ApiTracker {
  calls: number
}

export function newTracker(): ApiTracker {
  return { calls: 0 }
}

export interface ChannelInfo {
  channelId: string
  title: string
  thumbnail: string
  handle?: string
  uploadsPlaylistId: string
}

export interface PlaylistVideoRef {
  videoId: string
  publishedAt: string // ISO string (실제 영상 게시 시각)
}

export interface VideoStats {
  videoId: string
  title: string
  publishedAt: string
  viewCount: number
  likeCount: number
  commentCount: number
  duration: string
  thumbnail: string
}

export class YouTubeApiError extends Error {
  status?: number
  reason?: string
  constructor(message: string, status?: number, reason?: string) {
    super(message)
    this.name = 'YouTubeApiError'
    this.status = status
    this.reason = reason
  }
}

async function ytFetch(
  path: string,
  params: Record<string, string>,
  apiKey: string,
  tracker?: ApiTracker
) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  if (tracker) tracker.calls += 1
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason || json?.error?.status || 'unknown_error'
    const message = json?.error?.message || `YouTube API 오류 (HTTP ${res.status})`
    throw new YouTubeApiError(message, res.status, reason)
  }
  return json
}

// ---------- 입력값 파싱 ----------

export type InputKind = 'id' | 'handle' | 'username' | 'custom' | 'search'

export interface ParsedInput {
  raw: string
  kind: InputKind
  value: string
}

export function parseChannelInput(rawLine: string): ParsedInput | null {
  const raw = rawLine.trim()
  if (!raw) return null

  // 순수 채널 ID
  if (/^UC[0-9A-Za-z_-]{22}$/.test(raw)) {
    return { raw, kind: 'id', value: raw }
  }

  // 순수 @handle
  if (/^@[\w.\-가-힣]+$/.test(raw)) {
    return { raw, kind: 'handle', value: raw }
  }

  // URL 형태 파싱
  try {
    const withProto = raw.startsWith('http') ? raw : `https://${raw}`
    const u = new URL(withProto)
    if (!/youtube\.com$/.test(u.hostname.replace(/^www\./, '')) && !/youtu\.be$/.test(u.hostname)) {
      // youtube 도메인이 아니면 검색어로 취급
      return { raw, kind: 'search', value: raw }
    }
    const parts = u.pathname.split('/').filter(Boolean)
    if (parts.length === 0) return { raw, kind: 'search', value: raw }

    if (parts[0] === 'channel' && parts[1]) {
      return { raw, kind: 'id', value: parts[1] }
    }
    if (parts[0].startsWith('@')) {
      return { raw, kind: 'handle', value: parts[0] }
    }
    if (parts[0] === 'c' && parts[1]) {
      return { raw, kind: 'custom', value: parts[1] }
    }
    if (parts[0] === 'user' && parts[1]) {
      return { raw, kind: 'username', value: parts[1] }
    }
    // youtube.com/SomeName (레거시 커스텀 URL)
    if (parts[0]) {
      return { raw, kind: 'custom', value: parts[0] }
    }
    return { raw, kind: 'search', value: raw }
  } catch {
    // URL 파싱 실패 -> 검색어 취급 (채널명 등)
    return { raw, kind: 'search', value: raw }
  }
}

function mapChannelItem(item: any): ChannelInfo | null {
  const uploadsPlaylistId = item?.contentDetails?.relatedPlaylists?.uploads
  if (!uploadsPlaylistId) return null
  return {
    channelId: item.id,
    title: item.snippet?.title || '(제목 없음)',
    thumbnail: item.snippet?.thumbnails?.default?.url || item.snippet?.thumbnails?.medium?.url || '',
    handle: item.snippet?.customUrl,
    uploadsPlaylistId
  }
}

// ID 목록을 50개씩 배치로 조회 (1 unit / call)
export async function resolveChannelsByIds(
  apiKey: string,
  ids: string[],
  tracker?: ApiTracker
): Promise<Map<string, ChannelInfo>> {
  const result = new Map<string, ChannelInfo>()
  const chunkSize = 50
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    const json = await ytFetch(
      '/channels',
      { part: 'snippet,contentDetails', id: chunk.join(',') },
      apiKey,
      tracker
    )
    for (const item of json.items || []) {
      const info = mapChannelItem(item)
      if (info) result.set(info.channelId, info)
    }
  }
  return result
}

export async function resolveChannelByHandle(
  apiKey: string,
  handle: string,
  tracker?: ApiTracker
): Promise<ChannelInfo | null> {
  const h = handle.startsWith('@') ? handle : `@${handle}`
  const json = await ytFetch('/channels', { part: 'snippet,contentDetails', forHandle: h }, apiKey, tracker)
  const item = json.items?.[0]
  return item ? mapChannelItem(item) : null
}

export async function resolveChannelByUsername(
  apiKey: string,
  username: string,
  tracker?: ApiTracker
): Promise<ChannelInfo | null> {
  const json = await ytFetch(
    '/channels',
    { part: 'snippet,contentDetails', forUsername: username },
    apiKey,
    tracker
  )
  const item = json.items?.[0]
  return item ? mapChannelItem(item) : null
}

// 마지막 수단 (100 units 소모 - 남용 주의)
export async function resolveChannelBySearch(
  apiKey: string,
  query: string,
  tracker?: ApiTracker
): Promise<ChannelInfo | null> {
  const json = await ytFetch(
    '/search',
    { part: 'snippet', type: 'channel', q: query, maxResults: '1' },
    apiKey,
    tracker
  )
  const item = json.items?.[0]
  const channelId = item?.snippet?.channelId || item?.id?.channelId
  if (!channelId) return null
  const map = await resolveChannelsByIds(apiKey, [channelId], tracker)
  return map.get(channelId) || null
}

// 여러 방법을 순서대로 시도하는 범용 리졸버 (handle/username/custom/search kind용)
export async function resolveChannelGeneric(
  apiKey: string,
  parsed: ParsedInput,
  tracker?: ApiTracker
): Promise<ChannelInfo | null> {
  if (parsed.kind === 'handle') {
    return await resolveChannelByHandle(apiKey, parsed.value, tracker)
  }
  if (parsed.kind === 'username') {
    const byUsername = await resolveChannelByUsername(apiKey, parsed.value, tracker)
    if (byUsername) return byUsername
    return await resolveChannelBySearch(apiKey, parsed.value, tracker)
  }
  if (parsed.kind === 'custom') {
    // 커스텀 URL은 forHandle(@없이 시도) -> forUsername -> search 순서로 시도
    try {
      const byHandle = await resolveChannelByHandle(apiKey, parsed.value, tracker)
      if (byHandle) return byHandle
    } catch {
      /* ignore and continue */
    }
    try {
      const byUsername = await resolveChannelByUsername(apiKey, parsed.value, tracker)
      if (byUsername) return byUsername
    } catch {
      /* ignore and continue */
    }
    return await resolveChannelBySearch(apiKey, parsed.value, tracker)
  }
  // search
  return await resolveChannelBySearch(apiKey, parsed.value, tracker)
}

// ---------- 업로드 재생목록에서 최근 영상 가져오기 ----------

const MAX_PAGES = 6 // 안전장치 (최대 300개 항목까지만 확인)

export async function fetchRecentPlaylistVideos(
  apiKey: string,
  playlistId: string,
  sinceISO: string,
  tracker?: ApiTracker
): Promise<PlaylistVideoRef[]> {
  const since = new Date(sinceISO).getTime()
  const results: PlaylistVideoRef[] = []
  let pageToken: string | undefined
  let page = 0

  while (page < MAX_PAGES) {
    page++
    const params: Record<string, string> = {
      part: 'contentDetails',
      playlistId,
      maxResults: '50'
    }
    if (pageToken) params.pageToken = pageToken

    const json = await ytFetch('/playlistItems', params, apiKey, tracker)
    const items = json.items || []
    if (items.length === 0) break

    let sawOlder = false
    for (const item of items) {
      const publishedAt = item?.contentDetails?.videoPublishedAt
      const videoId = item?.contentDetails?.videoId
      if (!videoId || !publishedAt) continue
      const t = new Date(publishedAt).getTime()
      if (t >= since) {
        results.push({ videoId, publishedAt })
      } else {
        sawOlder = true
      }
    }

    // 업로드 재생목록은 최신순 정렬이므로, since보다 오래된 항목을 만나면 더 이상 볼 필요 없음
    if (sawOlder) break
    pageToken = json.nextPageToken
    if (!pageToken) break
  }

  return results
}

function parseCount(v: any): number {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

// videoId 목록을 50개씩 배치로 통계 조회 (1 unit / call)
export async function fetchVideoStats(
  apiKey: string,
  videoIds: string[],
  tracker?: ApiTracker
): Promise<Map<string, VideoStats>> {
  const result = new Map<string, VideoStats>()
  const chunkSize = 50
  for (let i = 0; i < videoIds.length; i += chunkSize) {
    const chunk = videoIds.slice(i, i + chunkSize)
    if (chunk.length === 0) continue
    const json = await ytFetch(
      '/videos',
      { part: 'snippet,statistics,contentDetails', id: chunk.join(',') },
      apiKey,
      tracker
    )
    for (const item of json.items || []) {
      result.set(item.id, {
        videoId: item.id,
        title: item.snippet?.title || '(제목 없음)',
        publishedAt: item.snippet?.publishedAt,
        viewCount: parseCount(item.statistics?.viewCount),
        likeCount: parseCount(item.statistics?.likeCount),
        commentCount: parseCount(item.statistics?.commentCount),
        duration: item.contentDetails?.duration || '',
        thumbnail:
          item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || ''
      })
    }
  }
  return result
}

// ISO8601 duration (PT#H#M#S) -> "H:MM:SS" or "M:SS"
export function formatDuration(iso: string): string {
  if (!iso) return ''
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!m) return ''
  const h = parseInt(m[1] || '0', 10)
  const min = parseInt(m[2] || '0', 10)
  const s = parseInt(m[3] || '0', 10)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(min)}:${pad(s)}`
  return `${min}:${pad(s)}`
}
