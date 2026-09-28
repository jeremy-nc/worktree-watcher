import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { SharedCache } from '../application/ports'
import { SharedFetch } from '../application/sharedFetch'
import { sharedPullRequestSource } from '../application/sharedSources'
import { BACKGROUND_STALENESS_FACTOR, CacheEntry, decide } from '../domain/sharedCache'
import { FileSharedCache } from '../infrastructure/fileSharedCache'

const MINUTE = 60_000
const INTERVAL = 5 * MINUTE
const NOW = 1_000_000_000

const logger = { info: () => undefined, error: () => undefined }

function entry(ageMs: number): CacheEntry<string> {
  return { fetchedAt: NOW - ageMs, value: 'cached' }
}

describe('decide', () => {
  const base = { now: NOW, intervalMs: INTERVAL, focused: true, peerFetching: false }

  it('uses a fresh entry, focused or not', () => {
    assert.equal(decide({ ...base, entry: entry(MINUTE) }), 'use-cache')
    assert.equal(decide({ ...base, focused: false, entry: entry(MINUTE) }), 'use-cache')
  })

  it('has the focused window refetch once an entry is a poll interval old', () => {
    assert.equal(decide({ ...base, entry: entry(INTERVAL) }), 'fetch')
  })

  it('lets a background window keep showing stale data rather than fetch', () => {
    assert.equal(decide({ ...base, focused: false, entry: entry(INTERVAL * 2) }), 'use-cache')
  })

  it('lets a background window catch up once past the staleness ceiling', () => {
    const ceiling = INTERVAL * BACKGROUND_STALENESS_FACTOR
    assert.equal(decide({ ...base, focused: false, entry: entry(ceiling) }), 'fetch')
  })

  it('fetches with nothing cached even in the background, so a new window is not empty', () => {
    assert.equal(decide({ ...base, focused: false }), 'fetch')
  })

  it('waits for a peer already fetching instead of duplicating its request', () => {
    assert.equal(decide({ ...base, peerFetching: true }), 'wait-for-peer')
    assert.equal(decide({ ...base, peerFetching: true, entry: entry(INTERVAL) }), 'wait-for-peer')
  })

  it('still prefers a fresh entry over waiting', () => {
    assert.equal(decide({ ...base, peerFetching: true, entry: entry(MINUTE) }), 'use-cache')
  })

  it('distrusts an entry stamped in the future, as after the clock went backwards', () => {
    assert.equal(decide({ ...base, entry: entry(-MINUTE) }), 'fetch')
  })
})

/** In-memory `SharedCache`, with a hook to simulate another window. */
class FakeCache implements SharedCache {
  readonly entries = new Map<string, CacheEntry<unknown>>()
  readonly locks = new Set<string>()
  writes = 0

  async read<T>(key: string): Promise<CacheEntry<T> | undefined> {
    return this.entries.get(key) as CacheEntry<T> | undefined
  }
  async write<T>(key: string, value: T, fetchedAt: number): Promise<void> {
    this.writes += 1
    this.entries.set(key, { value, fetchedAt })
  }
  async tryLock(key: string): Promise<boolean> {
    if (this.locks.has(key)) {
      return false
    }
    this.locks.add(key)
    return true
  }
  async unlock(key: string): Promise<void> {
    this.locks.delete(key)
  }
  async isLocked(key: string): Promise<boolean> {
    return this.locks.has(key)
  }
}

describe('SharedFetch', () => {
  let cache: FakeCache
  let clock: number
  let focused: boolean
  let shared: SharedFetch
  let calls: number
  const fetcher = async (): Promise<string> => {
    calls += 1
    return `fetched-${calls}`
  }

  beforeEach(() => {
    cache = new FakeCache()
    clock = NOW
    focused = true
    calls = 0
    shared = new SharedFetch(cache, logger, {
      isFocused: () => focused,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
      },
      peerWaitMs: 1_000
    })
  })

  it('fetches and publishes when nothing is cached', async () => {
    assert.equal(await shared.get('k', INTERVAL, fetcher), 'fetched-1')
    assert.equal((await cache.read<string>('k'))?.value, 'fetched-1')
  })

  it('serves another window’s fresh result without touching the network', async () => {
    await cache.write('k', 'from-peer', NOW - MINUTE)
    assert.equal(await shared.get('k', INTERVAL, fetcher), 'from-peer')
    assert.equal(calls, 0)
  })

  it('keeps a background window off the network while data is merely stale', async () => {
    focused = false
    await cache.write('k', 'old', NOW - INTERVAL * 2)
    assert.equal(await shared.get('k', INTERVAL, fetcher), 'old')
    assert.equal(calls, 0)
  })

  it('releases the lock after fetching', async () => {
    await shared.get('k', INTERVAL, fetcher)
    assert.equal(await cache.isLocked('k'), false)
  })

  it('never caches a failure, and releases the lock through it', async () => {
    await assert.rejects(
      shared.get('k', INTERVAL, async () => {
        throw new Error('GitHub is down')
      }),
      /GitHub is down/
    )
    assert.equal(await cache.read('k'), undefined)
    assert.equal(await cache.isLocked('k'), false)
  })

  it('takes a peer’s result when it lands while waiting', async () => {
    cache.locks.add('k')
    const originalRead = cache.read.bind(cache)
    let reads = 0
    cache.read = async <T>(key: string) => {
      reads += 1
      if (reads === 2) {
        await cache.write(key, 'from-peer', clock)
      }
      return originalRead<T>(key)
    }

    assert.equal(await shared.get('k', INTERVAL, fetcher), 'from-peer')
    assert.equal(calls, 0)
  })

  it('fetches itself once a peer gives up without publishing', async () => {
    cache.locks.add('k')
    const gaveUp = new SharedFetch(cache, logger, {
      isFocused: () => true,
      now: () => clock,
      // The peer's fetch fails during our first wait: its lock vanishes and
      // nothing is written.
      sleep: async (ms) => {
        clock += ms
        cache.locks.delete('k')
      },
      peerWaitMs: 1_000
    })

    assert.equal(await gaveUp.get('k', INTERVAL, fetcher), 'fetched-1')
    assert.equal(calls, 1)
  })

  it('waits for the winner when it loses a lock race, instead of duplicating the request', async () => {
    // Both windows decided to fetch before either held the lock; the other won.
    cache.tryLock = async () => false
    const racing = new SharedFetch(cache, logger, {
      isFocused: () => true,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms
        await cache.write('k', 'from-winner', clock)
      },
      peerWaitMs: 1_000
    })

    assert.equal(await racing.get('k', INTERVAL, fetcher), 'from-winner')
    assert.equal(calls, 0)
  })

  it('stops waiting on a peer that never finishes, and fetches', async () => {
    cache.locks.add('k')
    assert.equal(await shared.get('k', INTERVAL, fetcher), 'fetched-1')
    assert.ok(clock - NOW >= 1_000, 'it should have waited the full allowance first')
  })
})

describe('sharedPullRequestSource', () => {
  it('shares one entry between windows that scanned their branches in a different order', async () => {
    const cache = new FakeCache()
    let calls = 0
    const inner = {
      available: async () => true,
      fetch: async () => {
        calls += 1
        return []
      }
    }
    const shared = new SharedFetch(cache, logger, { isFocused: () => true })
    const source = sharedPullRequestSource(inner, shared, 'acme', () => INTERVAL)

    await source.fetch([
      { repository: 'a', branch: 'x' },
      { repository: 'b', branch: 'y' }
    ])
    await source.fetch([
      { repository: 'b', branch: 'y' },
      { repository: 'a', branch: 'x' }
    ])
    assert.equal(calls, 1)
  })

  it('keeps separate entries for windows asking about different branches', async () => {
    const cache = new FakeCache()
    let calls = 0
    const inner = {
      available: async () => true,
      fetch: async () => {
        calls += 1
        return []
      }
    }
    const shared = new SharedFetch(cache, logger, { isFocused: () => true })
    const source = sharedPullRequestSource(inner, shared, 'acme', () => INTERVAL)

    await source.fetch([{ repository: 'a', branch: 'x' }])
    await source.fetch([{ repository: 'a', branch: 'z' }])
    assert.equal(calls, 2)
  })
})

describe('FileSharedCache', () => {
  let directory: string
  let cache: FileSharedCache

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-cache-'))
    cache = new FileSharedCache(logger, directory)
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('round-trips an entry', async () => {
    await cache.write('github:prs:acme', [{ number: 1 }], 123)
    assert.deepEqual(await cache.read('github:prs:acme'), { fetchedAt: 123, value: [{ number: 1 }] })
  })

  it('leaves no temporary files behind a write', async () => {
    await cache.write('k', 'v', 1)
    const names = await fs.readdir(directory)
    assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0)
  })

  it('is read by another window’s instance', async () => {
    await cache.write('k', 'v', 1)
    const other = new FileSharedCache(logger, directory)
    assert.equal((await other.read<string>('k'))?.value, 'v')
  })

  it('ignores a file whose stored key does not match', async () => {
    await cache.write('k', 'v', 1)
    const [file] = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'))
    await fs.writeFile(path.join(directory, file), JSON.stringify({ key: 'other', fetchedAt: 1, value: 'x' }))
    assert.equal(await cache.read('k'), undefined)
  })

  it('treats an unreadable or corrupt entry as not cached', async () => {
    await cache.write('k', 'v', 1)
    const [file] = (await fs.readdir(directory)).filter((name) => name.endsWith('.json'))
    await fs.writeFile(path.join(directory, file), '{not json')
    assert.equal(await cache.read('k'), undefined)
  })

  it('grants a lock to exactly one window', async () => {
    const other = new FileSharedCache(logger, directory)
    assert.equal(await cache.tryLock('k'), true)
    assert.equal(await other.tryLock('k'), false)
    assert.equal(await other.isLocked('k'), true)
  })

  it('frees the lock on unlock', async () => {
    await cache.tryLock('k')
    await cache.unlock('k')
    assert.equal(await cache.isLocked('k'), false)
    assert.equal(await new FileSharedCache(logger, directory).tryLock('k'), true)
  })

  it('reclaims a lock left by a window that died mid-fetch', async () => {
    await cache.tryLock('k')
    const [lock] = (await fs.readdir(directory)).filter((name) => name.endsWith('.lock'))
    const longAgo = new Date(Date.now() - 10 * MINUTE)
    await fs.utimes(path.join(directory, lock), longAgo, longAgo)

    const other = new FileSharedCache(logger, directory)
    assert.equal(await other.isLocked('k'), false)
    assert.equal(await other.tryLock('k'), true)
  })

  it('fails open when the directory cannot be created', async () => {
    const blocked = path.join(directory, 'file')
    await fs.writeFile(blocked, '')
    const broken = new FileSharedCache(logger, path.join(blocked, 'cache'))

    assert.equal(await broken.read('k'), undefined)
    await broken.write('k', 'v', 1)
    assert.equal(await broken.tryLock('k'), true, 'locking cannot work here, so act alone')
    assert.equal(await broken.isLocked('k'), false)
  })

  it('prunes entries and debris past their retention, keeping recent ones', async () => {
    await cache.write('old', 'v', 1)
    await fs.writeFile(path.join(directory, 'abandoned.1.dead.tmp'), '')
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * MINUTE)
    for (const name of await fs.readdir(directory)) {
      await fs.utimes(path.join(directory, name), twoDaysAgo, twoDaysAgo)
    }
    await cache.write('new', 'v', 1)

    await cache.prune()
    assert.equal(await cache.read('old'), undefined)
    assert.equal((await cache.read<string>('new'))?.value, 'v')
    assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false)
  })

  it('tells one window when another publishes, but not about its own writes', async () => {
    const other = new FileSharedCache(logger, directory)
    let notified = 0
    const watching = cache.onPeerWrite(() => (notified += 1))
    await new Promise((resolve) => setTimeout(resolve, 100))

    await cache.write('mine', 'v', 1)
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.equal(notified, 0, 'a window’s own write is not news to it')

    await other.write('theirs', 'v', 1)
    await new Promise((resolve) => setTimeout(resolve, 900))
    assert.equal(notified, 1)
    watching.dispose()
  })
})
