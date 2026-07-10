import { describe, it, expect } from 'vitest'
import {
  MAX_MEDIA_SIZE,
  MEDIA_EXTENSIONS,
  MEDIA_ACCEPT,
  VIDEO_EXTENSIONS,
  isVideoFilename,
  validateMediaFile,
  mediaUploadTimeoutMs,
  describeMediaUploadError,
} from './media-constants'
import { ApiError } from './api/client'

// Build a File with a controlled `.size` without allocating GB of bytes.
function fakeFile(name: string, size: number): File {
  const f = new File(['x'], name, { type: '' })
  Object.defineProperty(f, 'size', { value: size, configurable: true })
  return f
}

describe('validateMediaFile', () => {
  it('accepts each supported extension (case-insensitive)', () => {
    for (const ext of MEDIA_EXTENSIONS) {
      expect(validateMediaFile(fakeFile(`rec.${ext}`, 1024)).ok).toBe(true)
      expect(validateMediaFile(fakeFile(`rec.${ext.toUpperCase()}`, 1024)).ok).toBe(true)
    }
  })

  it('rejects unknown or missing extensions with the format message', () => {
    const bad = validateMediaFile(fakeFile('notes.txt', 1024))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('Accepted formats')
    expect(validateMediaFile(fakeFile('noext', 1024)).ok).toBe(false)
  })

  it('accepts a file exactly at the cap and rejects one over it', () => {
    expect(validateMediaFile(fakeFile('rec.mp4', MAX_MEDIA_SIZE)).ok).toBe(true)
    const over = validateMediaFile(fakeFile('rec.mp4', MAX_MEDIA_SIZE + 1))
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.error).toContain('4GB')
  })

  it('MEDIA_ACCEPT lists both dotted extensions and MIME types', () => {
    for (const ext of MEDIA_EXTENSIONS) {
      expect(MEDIA_ACCEPT).toContain(`.${ext}`)
    }
    expect(MEDIA_ACCEPT).toContain('video/mp4')
    expect(MEDIA_ACCEPT).toContain('audio/mpeg')
  })
})

describe('mediaUploadTimeoutMs', () => {
  it('floors small files at 2 minutes', () => {
    expect(mediaUploadTimeoutMs(1024)).toBe(120_000)
  })
  it('#544: never clamps an in-limit file below its own floor-rate estimate', () => {
    // The old fixed 6 h cap sat below the ~6.28 h a 4 GiB upload implies at
    // the 190 KB/s floor — an at-cap upload would abort ~95% complete.
    const FLOOR_BYTES_PER_SEC = 190_000
    const maxEstimate = Math.ceil(MAX_MEDIA_SIZE / FLOOR_BYTES_PER_SEC) * 1000 + 30_000
    expect(mediaUploadTimeoutMs(MAX_MEDIA_SIZE)).toBe(maxEstimate)
    expect(mediaUploadTimeoutMs(MAX_MEDIA_SIZE)).toBeGreaterThan(6 * 60 * 60 * 1000)
  })
  it('caps oversize inputs at the max-size estimate', () => {
    expect(mediaUploadTimeoutMs(100 * 1024 ** 3)).toBe(mediaUploadTimeoutMs(MAX_MEDIA_SIZE))
  })
  it('scales between the floor and the cap for a mid-size file', () => {
    const t = mediaUploadTimeoutMs(1024 ** 3) // ~1 GB
    expect(t).toBeGreaterThan(120_000)
    expect(t).toBeLessThan(mediaUploadTimeoutMs(MAX_MEDIA_SIZE))
  })
})

describe('isVideoFilename', () => {
  it('classifies video extensions case-insensitively', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(isVideoFilename(`rec.${ext}`)).toBe(true)
      expect(isVideoFilename(`rec.${ext.toUpperCase()}`)).toBe(true)
    }
  })
  it('classifies audio and unknown extensions as non-video', () => {
    expect(isVideoFilename('rec.mp3')).toBe(false)
    expect(isVideoFilename('rec.wav')).toBe(false)
    expect(isVideoFilename('rec.m4a')).toBe(false)
    expect(isVideoFilename('noext')).toBe(false)
  })
})

describe('backend mirror agreement (#544)', () => {
  // Each side pins the same literals: the backend twin is
  // test_media.py::TestMediaConstantsMirror (routers/media.py MAX_MEDIA_SIZE +
  // models/conversation.py VIDEO_FORMATS). Changing one side without the
  // other fails that side's suite — the mirror this file exists to guarantee.
  it('pins MAX_MEDIA_SIZE to the backend cap', () => {
    expect(MAX_MEDIA_SIZE).toBe(4 * 1024 ** 3)
  })
  it('pins the accepted extension list to the backend sniffable formats', () => {
    expect([...MEDIA_EXTENSIONS].sort()).toEqual(['m4a', 'mov', 'mp3', 'mp4', 'wav', 'webm'])
  })
  it('pins VIDEO_EXTENSIONS to backend VIDEO_FORMATS', () => {
    expect([...VIDEO_EXTENSIONS].sort()).toEqual(['mov', 'mp4', 'webm'])
    // and every video extension is also an accepted upload extension
    for (const ext of VIDEO_EXTENSIONS) {
      expect(MEDIA_EXTENSIONS).toContain(ext)
    }
  })
})

describe('describeMediaUploadError', () => {
  it('prefers the backend detail for 413 / 400 / 507', () => {
    expect(describeMediaUploadError(new ApiError(413, { detail: 'Media file exceeds 4GB limit' }, {})))
      .toMatch(/4\s?GB/i)
    expect(describeMediaUploadError(new ApiError(400, { detail: 'Unsupported media format. Accepted formats: …' }, {})))
      .toMatch(/unsupported media format/i)
    expect(describeMediaUploadError(new ApiError(507, { detail: 'Not enough disk space to save the recording.' }, {})))
      .toMatch(/disk space/i)
  })
  it('gives its own message when the status has no useful detail', () => {
    // ApiError with no detail → message is the "Request failed…" placeholder,
    // which must NOT be surfaced verbatim.
    const m = describeMediaUploadError(new ApiError(507, {}, {}))
    expect(m).toMatch(/disk space/i)
    expect(m).not.toMatch(/request failed/i)
  })
  it('maps a timeout abort to a timed-out message', () => {
    const e = new Error('aborted'); e.name = 'TimeoutError'
    expect(describeMediaUploadError(e)).toMatch(/timed out/i)
  })
  it('maps a network reject to an interrupted message', () => {
    expect(describeMediaUploadError(new TypeError('Failed to fetch'))).toMatch(/interrupted|connection/i)
  })
  it('falls back for unknown errors', () => {
    expect(describeMediaUploadError({})).toMatch(/couldn’t be attached|could/i)
  })
})
