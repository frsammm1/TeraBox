# TeraBox Internal API — Reverse Engineering Project
## PRD + Agent Prompt Document
**Version:** 1.0 | **Status:** Research & Implementation Phase

---

---

# PART 1 — AGENT PROMPT

## Mission

Tujhe TeraBox (Baidu Pan-based cloud storage service) ka internal/private download API fully reverse-engineer karna hai aur usse ek production-ready TypeScript downloader module mein implement karna hai jo existing `artifacts/api-server/src/lib/` structure mein fit ho sake.

**Target outcome:** Download speed jo currently 2–50 KB/s hai (public `dlink` via `dm.terabox.app`) woh 10–50 MB/s tak pahunche, bina kisi paid third-party API ya kisi existing open-source repo ke code ko copy kiye.

---

## Background — Jo Abhi Hai

### Current Download Flow (Throttled Path)

```
User sends TeraBox share link
       ↓
GET https://dm.terabox.app/sharing/link?surl=XXX
  (HTML page se jsToken extract karo)
       ↓
GET https://dm.terabox.app/share/list?jsToken=...&shorturl=...
  (JSON response mein dlink milti hai)
       ↓
GET <dlink>   ← YE THROTTLED HAI — Baidu CDN limits this to ~3 KB/s per connection
```

**File:** `artifacts/api-server/src/lib/terabox.ts` — class `TeraBoxClient`

### Current Download Implementation

```typescript
// artifacts/api-server/src/lib/transfer.ts — class ChunkedHttpFileDownloader
// Parallel Range requests use karta hai — 8 chunks default
// Limit: TeraBox per-IP bandwidth cap still applies
```

---

## What You Need to Find

### 1. Authentication Tokens (Primary Target)

TeraBox/Baidu Pan internal API kuch additional tokens use karta hai jo web share API mein nahi hote:

| Token | Kahan milta hai | Purpose |
|-------|-----------------|---------|
| `BDUSS` | Cookie — Baidu login session | Primary auth token |
| `STOKEN` | Cookie — secondary session | API auth |
| `ptoken` | API response ya cookie | Download permission |
| `logid` | Generated / cookie | Request tracking |
| `sign` | Computed from JS function | Anti-tamper signature |
| `timestamp` | Current Unix timestamp | Sign freshness |

**Inhe kaise nikalen:** TeraBox Android APK ke network traffic mein, ya TeraBox web app mein jab koi apne account se file download kare tab request headers mein ye sab milte hain.

### 2. Internal Download Endpoint (Primary Target)

Public dlink format:
```
https://d0XX-bj.terabox.com/file/XXXXX?...
  (redirects through Baidu CDN, throttled)
```

Internal/direct format (ye dhundna hai):
```
Likely candidates:
- https://d.terabox.com/rest/2.0/xpan/file?method=download&...
- https://pan.baidu.com/rest/2.0/xpan/multimedia?method=download&...
- https://c3.terabox.com/file/XXXX?...
- Baidu P2SP protocol (peer-assisted download)
```

**Expected parameters to find:**
- `fs_id` (file system ID — unique per file)
- `sign` (HMAC or MD5 based computed value)
- `timestamp`
- `uk` (user key / user ID)
- `shareid`
- `sekey` or `randsk` (share encryption key)

### 3. Sign Computation Algorithm

TeraBox compute karta hai ek `sign` parameter jo download URL ko authenticate karta hai. Ye likely:
- MD5(BDUSS + file_path + timestamp) based hai
- Ya HMAC-SHA256 kuch constant key se
- Ya JavaScript `signRequest()` function se jo APK mein embedded hai

**Ye extract karna hai aur TypeScript mein reimplement karna hai.**

---

## Reverse Engineering Approach — Step by Step

### Method A: Network Traffic Capture (Fastest)

#### Setup

```bash
# Android Emulator setup (Genymotion ya Android Studio AVD)
# MitmProxy install karo
pip install mitmproxy

# Proxy start karo
mitmweb --listen-port 8888 --ssl-insecure

# Emulator mein proxy set karo: Settings → WiFi → Proxy → Manual
# Host: 10.0.2.2, Port: 8888
# CA cert install karo: http://mitm.it

# TeraBox APK install karo emulator mein
# Version: latest from APKPure ya APKMirror
```

#### Traffic Filter Karo

MitmProxy mein in requests ko dhundho:
```python
# mitmproxy filter script — save as filter.py
def response(flow):
    if "terabox" in flow.request.host or "baidu.com" in flow.request.host:
        if any(kw in flow.request.path for kw in ["download", "file", "xpan", "pcs"]):
            print(f"\n{'='*60}")
            print(f"URL: {flow.request.url}")
            print(f"Method: {flow.request.method}")
            print(f"Headers: {dict(flow.request.headers)}")
            print(f"Params: {dict(flow.request.query)}")
            if flow.response:
                print(f"Status: {flow.response.status_code}")
                print(f"Response (first 2000 chars): {flow.response.text[:2000]}")
```

#### Capture karo

1. TeraBox app open karo
2. Login karo apne account se
3. Koi bhi file download start karo (large file prefer karo)
4. Immediately download cancel karo
5. mitmweb dashboard mein sab requests dekho: `http://localhost:8081`

**Focus on:** Download initiation ke waqt jo request jaye, uski URL, headers, aur response mein jo direct link mile.

---

### Method B: APK Decompile (Most Complete)

#### Tools

```bash
# jadx — best Java/Kotlin decompiler
# Download: https://github.com/skylot/jadx/releases
jadx-gui terabox.apk

# Ya command line
jadx -d output_dir terabox.apk
```

#### Classes Dhundho

jadx mein search karo:
```
"download"     → DownloadManager, DownloadTask, FileDownloadHelper classes
"sign"         → SignatureUtils, RequestSigner, ya koi bhi sign() method
"BDUSS"        → AuthManager, TokenManager
"dlink"        → ShareDownloadHelper
"fs_id"        → FileInfo, PanFile
"xpan"         → ApiService, PanApiClient
```

#### Key File Patterns

```java
// Typical patterns jo TeraBox/Baidu apps use karte hain:

// Sign computation (ye exact algorithm dhundho):
String sign = MD5.hash(uk + shareid + fs_id + timestamp + SECRET_KEY);

// Ya HMAC variant:
String sign = HMAC.sha256(message, APP_KEY);

// Download URL construction:
String url = "https://d.terabox.com/rest/2.0/xpan/file" +
    "?method=download" +
    "&app_id=250528" +
    "&fsid=" + fs_id +
    "&uk=" + uk +
    "&shareid=" + shareid +
    "&timestamp=" + timestamp +
    "&sign=" + sign +
    "&channel=chunlei";
```

---

### Method C: Web App JavaScript Analysis (Easiest to Start)

```javascript
// Browser DevTools → Network tab → Filter: download
// TeraBox web app pe login karo aur koi file download karo
// Request capture karo

// Console mein run karo:
window._bdstoken  // Baidu token
document.cookie   // Saare cookies dekho (BDUSS, STOKEN etc.)

// XHR intercept karo:
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url) {
    if (url.includes('download') || url.includes('file')) {
        console.log('XHR:', method, url);
    }
    return origOpen.apply(this, arguments);
};

const origFetch = window.fetch;
window.fetch = function(url, opts) {
    if (String(url).includes('download') || String(url).includes('file')) {
        console.log('FETCH:', url, opts?.headers);
    }
    return origFetch.apply(this, arguments);
};
```

---

## Expected Findings Format

Jab koi bhi method se data mile, ise is format mein document karo:

### Download API Specification

```yaml
endpoint: "https://_____.terabox.com/___"
method: GET
auth_method: "Cookie + Query params"

required_cookies:
  BDUSS: "session token from login"
  STOKEN: "secondary token"
  ndus: "already have this"

required_query_params:
  fs_id: "unique file ID from file listing"
  uk: "user ID of share owner"
  shareid: "share ID"
  sign: "computed — algorithm: ____"
  timestamp: "unix timestamp"
  app_id: "250528"

sign_algorithm:
  input: ["field1", "field2", ...]
  method: "MD5 / HMAC-SHA256 / custom"
  key: "___"
  output_format: "hex / base64"

speed_observed: "_____ MB/s"
throttled: yes/no
requires_premium: yes/no
```

---

## Implementation Target

### New TypeScript Class to Build

File: `artifacts/api-server/src/lib/terabox-internal.ts`

```typescript
export interface InternalDownloadOptions {
  fsId: string;          // File's unique ID
  uk: string;            // Share owner's user ID
  shareId: string;       // Share ID
  cookies: Record<string, string>;  // Must include BDUSS, STOKEN + existing ndus etc.
  requestTimeoutMs?: number;
}

export interface InternalDownloadResult {
  downloadUrl: string;   // Direct unthrottled CDN URL
  headers: Record<string, string>;  // Headers to use with download
  expiresAt?: Date;      // When URL expires
}

export class TeraBoxInternalClient {
  /** Resolves fs_id + auth → direct unthrottled download URL */
  async getDirectDownloadUrl(options: InternalDownloadOptions): Promise<InternalDownloadResult> {
    // IMPLEMENT THIS based on reverse engineering findings
  }

  /** Extracts fs_id from existing TeraBoxFile object */
  async enrichFile(
    file: TeraBoxFile,
    shareContext: ShareContext,
    cookies: Record<string, string>
  ): Promise<TeraBoxFile & { fsId: string }> {
    // IMPLEMENT THIS
  }
}
```

### Integration Points

1. **`terabox.ts`** — `TeraBoxClient.resolve()` ke output mein `fsId` add karo
2. **`transfer.ts`** — `HttpFileDownloader` ke before, `TeraBoxInternalClient.getDirectDownloadUrl()` try karo; agar fail hoto existing `dlink` pe fallback
3. **`config.ts`** — `TERABOX_USE_INTERNAL_API=true/false` env var add karo

---

## Success Criteria

- [ ] Internal download URL successfully generate ho rahi hai
- [ ] Download speed 10+ MB/s consistently hai (same VPS/server pe test)
- [ ] 100 consecutive file downloads fail nahi ho rahe
- [ ] Graceful fallback kaam kar raha hai (internal fail → dlink fallback)
- [ ] BDUSS/STOKEN cookie injection working hai
- [ ] Sign computation accurate hai (no 403/401 errors)
- [ ] Rate limiting detect karo aur handle karo
- [ ] Existing bot ke saath fully integrated hai

---

---

# PART 2 — PRODUCT REQUIREMENTS DOCUMENT (PRD)

## Document Info

| Field | Value |
|-------|-------|
| **Product** | TeraBox High-Speed Bulk Transfer Bot |
| **Version** | 2.0 (Internal API Release) |
| **Goal** | 10,000 files TeraBox → Telegram at 10–50 MB/s |
| **Current State** | 2–50 KB/s per file via public dlink |
| **Target State** | 10–50 MB/s per file via internal API |

---

## 1. Problem Statement

TeraBox ke public share API (`dm.terabox.app/share/list`) se milne wali `dlink` Baidu ke CDN se serve hoti hai jo free/regular traffic ke liye ~3 KB/s per TCP connection pe throttle hoti hai. Parallel chunk downloading (current fix) se 8–10 connections bana ke speed ~20–80 KB/s tak jaati hai, lekin:

- TeraBox per-IP bandwidth cap impose karta hai (estimated 100–500 KB/s max)
- 10,000 files × avg 200 MB = ~2 TB at 100 KB/s = **200+ hours** (impractical)
- TeraBox ke internal mobile API — jo app use karta hai apne registered users ke downloads ke liye — pe ye same throttle nahi hoti

**Estimated gap:** Internal API 100x–1000x faster hai public API ke muqable mein.

---

## 2. Goals

### Primary Goals

| Goal | Metric | Priority |
|------|--------|----------|
| Download speed badho | 10 MB/s minimum, 50 MB/s target | P0 |
| 10,000 file bulk transfer | Complete within 72 hours | P0 |
| Zero data loss | Every file verified after transfer | P0 |
| Bot stability | <0.1% unrecoverable failure rate | P1 |

### Secondary Goals

- Multiple account rotation support (speed aur limit bypass ke liye)
- Automatic throttle detection aur backoff
- Real-time progress dashboard
- Resumable downloads (crash recovery)

---

## 3. Technical Architecture

### 3.1 Current Architecture

```
TeraBox Share URL
      │
      ▼
TeraBoxClient.resolve()      ← dm.terabox.app (public API)
      │ returns dlink
      ▼
ChunkedHttpFileDownloader    ← 8 parallel Range requests
      │ ~20-80 KB/s
      ▼
Disk temp storage
      │
      ▼
MtprotoBotUploader           ← MTProto raw upload
      │
      ▼
Telegram Channel/Chat
```

### 3.2 Target Architecture

```
TeraBox Share URL
      │
      ▼
TeraBoxClient.resolve()           ← dm.terabox.app (existing, gets fs_id)
      │ returns {dlink, fs_id, uk, shareid}
      ▼
TeraBoxInternalClient             ← INTERNAL API (new)
  .getDirectDownloadUrl()
      │
      ├─ Sign compute (TypeScript reimplementation)
      ├─ BDUSS/STOKEN auth
      └─ Direct CDN URL (unthrottled)
      │ ~10-50 MB/s
      ▼
ChunkedHttpFileDownloader         ← 4-8 chunks (fewer needed now)
      │
      ▼
Disk temp storage
      │
      ├─ File > 2GB? → Split into parts
      │
      ▼
MtprotoBotUploader
      │
      ▼
Telegram
```

### 3.3 Component Breakdown

#### Component 1: `TeraBoxInternalClient` (New — Core of this PRD)

**Responsibilities:**
- BDUSS/STOKEN se authenticated download URL generate karna
- Sign algorithm compute karna
- URL expiry handle karna (likely 15–60 min)
- Rate limit detect karna (HTTP 429/403)

**Inputs:**
- `fs_id` — file ka unique ID (share list API se milta hai, usually `fs_id` field)
- `uk` — share owner ka user ID (share response mein hota hai)
- `shareid` — share ID
- `cookies` — `{BDUSS, STOKEN, ndus, ...}`

**Outputs:**
- Direct CDN download URL (no redirect, no throttle)
- Required headers for that URL
- Expiry time

#### Component 2: Enhanced `TeraBoxClient` (Modified)

Current `TeraBoxClient.resolve()` `fs_id` return nahi karta. Ise update karo:

```typescript
// Current TeraBoxFile interface:
export interface TeraBoxFile {
  name: string;
  path?: string;
  sizeBytes?: number;
  download?: string;  // ← throttled dlink
  thumbs?: Record<string, string>;
  isFolder: boolean;
}

// Target TeraBoxFile interface:
export interface TeraBoxFile {
  name: string;
  path?: string;
  sizeBytes?: number;
  download?: string;       // throttled dlink (fallback)
  fsId?: string;           // ← NEW: Baidu internal file ID
  thumbs?: Record<string, string>;
  isFolder: boolean;
}

// ResolvedShare mein bhi add karo:
export interface ResolvedShare {
  surl: string;
  directory?: string;
  files: TeraBoxFile[];
  uk?: string;        // ← NEW: share owner user ID
  shareId?: string;   // ← NEW: share ID
}
```

#### Component 3: Account Pool Manager (New — for scale)

10,000 files ke liye ek account ki bandwidth kaafi nahi hogi. Multiple TeraBox accounts rotate karo:

```typescript
export interface AccountConfig {
  cookies: Record<string, string>;  // BDUSS, STOKEN, ndus per account
  label: string;
  isHealthy: boolean;
  lastUsedAt: number;
  failureCount: number;
}

export class AccountPool {
  // Round-robin rotation
  getNext(): AccountConfig;

  // Mark unhealthy on 429/403
  markFailed(label: string): void;

  // Re-enable after cooldown
  recover(): void;
}
```

**Config:** `TERABOX_ACCOUNTS_JSON` env var — array of cookie objects

#### Component 4: Bulk Transfer Pipeline (Enhanced)

10,000 files ke liye current queue system enhance karo:

```typescript
export interface BulkTransferRequest {
  surlList: string[];          // Multiple TeraBox share URLs
  targetChatId: number;
  concurrency?: number;        // Parallel downloads (default: 3)
  skipExisting?: boolean;      // Resume support
  notifyChatId?: number;       // Progress updates chat
}
```

**Enhanced features needed:**
- `SQLite` mein completed file IDs store karo (crash recovery)
- Per-file retry with exponential backoff
- ETA calculation for full batch
- Telegram message: "X/10000 complete (Y MB/s avg, ETA: Z hours)"

---

## 4. Detailed Feature Requirements

### F1: Internal API Integration

**F1.1 — Sign Algorithm Implementation**
- Source: Reverse engineer from APK decompile ya network capture
- Language: TypeScript, zero runtime dependencies (pure crypto)
- Input validation: Reject invalid `fs_id` formats
- Error handling: Throw `TeraBoxInternalError` on invalid signature

**F1.2 — Auth Cookie Management**
- `BDUSS` aur `STOKEN` env vars mein store honge (separate from existing `ndus`)
- Cookie refresh: BDUSS expire hone pe clear error throw karo (no silent fallback to wrong data)
- Cookie validation on startup: Test request karo, fail karo early

**F1.3 — URL Generation**
- Endpoint: (to be discovered via reverse engineering)
- URL caching: Same `fs_id` ke liye 10 min cache karo (download URLs reuse possible)
- Concurrent safety: Multiple transfers same `fs_id` request karein toh deduplicate

**F1.4 — Fallback Mechanism**
```typescript
async function getDownloadUrl(file: TeraBoxFile, context: ShareContext): Promise<DownloadSource> {
  if (config.useInternalApi && file.fsId && context.uk) {
    try {
      const internal = await internalClient.getDirectDownloadUrl({...});
      return { url: internal.downloadUrl, headers: internal.headers, source: 'internal' };
    } catch (error) {
      logger.warn('[terabox] Internal API failed, falling back to dlink', error);
    }
  }

  if (file.download) {
    return { url: file.download, headers: teraboxHeaders, source: 'dlink' };
  }

  throw new TeraBoxError('No download source available.');
}
```

---

### F2: Bulk Transfer Pipeline

**F2.1 — Bulk Queue Command**

Bot command: `/bulk <terabox-share-url> [file-count]`

```
User: /bulk https://terabox.app/s/XXXXX
Bot:  Found 247 files (12.4 GB total)
      Queue mein add kiye. Download speed: ~15 MB/s
      Estimated time: 14 minutes
      Progress: /bulkstatus
```

**F2.2 — Progress Tracking**

```
/bulkstatus command:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 Bulk Transfer #3
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Completed:  156 / 247 files
📥 Downloading: video_03.mp4 (63%)
⏳ Queued:     90 files
❌ Failed:      1 file (will retry)

Speed:   14.2 MB/s avg
ETA:     6 min 23 sec
Data:    8.7 GB / 13.8 GB
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**F2.3 — Resumability**

SQLite table:
```sql
CREATE TABLE bulk_file_state (
  bulk_id TEXT NOT NULL,
  file_path TEXT NOT NULL,  -- TeraBox path
  fs_id TEXT,
  status TEXT NOT NULL,     -- pending / downloading / completed / failed
  attempts INTEGER DEFAULT 0,
  telegram_message_id INTEGER,  -- Uploaded message ID for dedup
  completed_at INTEGER,
  error TEXT,
  PRIMARY KEY (bulk_id, file_path)
);
```

---

### F3: Account Pool (Multi-Account Support)

**F3.1 — Config**

```env
# Single account (existing):
TERABOX_COOKIES_JSON={"ndus":"...","BDUSS":"...","STOKEN":"..."}

# Multiple accounts (new):
TERABOX_ACCOUNTS_JSON=[
  {"label":"acc1","ndus":"...","BDUSS":"...","STOKEN":"..."},
  {"label":"acc2","ndus":"...","BDUSS":"...","STOKEN":"..."},
  {"label":"acc3","ndus":"...","BDUSS":"...","STOKEN":"..."}
]
```

**F3.2 — Rotation Strategy**
- Round-robin by default
- Weighted rotation based on success rate
- Auto-disable account on 3 consecutive failures
- Re-enable after 30 min cooldown

---

### F4: Monitoring & Alerting

**F4.1 — Admin Dashboard (`/admin` endpoint)**

Existing dashboard mein add karo:
```json
{
  "internal_api": {
    "enabled": true,
    "success_rate_1h": "94.2%",
    "avg_speed_mbps": 18.4,
    "fallback_rate_1h": "5.8%"
  },
  "accounts": [
    {"label": "acc1", "status": "healthy", "downloads_today": 412},
    {"label": "acc2", "status": "cooldown", "resumes_in": "12 min"},
    {"label": "acc3", "status": "healthy", "downloads_today": 389}
  ],
  "bulk_transfers": {
    "active": 1,
    "completed_today": 3,
    "files_transferred_today": 1847,
    "gb_transferred_today": 384.2
  }
}
```

---

## 5. Environment Variables — Full List

```env
# ── EXISTING ──────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_ALLOWED_USER_IDS=
TELEGRAM_ALLOW_PUBLIC=false
TELEGRAM_UPLOAD_ENABLED=true
CORS_ORIGIN=*
PORT=8080

# ── INTERNAL API (NEW) ────────────────────────────────────────────
# Enable/disable internal API (fallback to dlink if false)
TERABOX_USE_INTERNAL_API=true

# Single account mode (BDUSS + STOKEN added to existing cookie JSON)
TERABOX_COOKIES_JSON={"ndus":"...","browserid":"...","TSID":"...","BDUSS":"...","STOKEN":"..."}

# Multi-account mode (overrides TERABOX_COOKIES_JSON if set)
TERABOX_ACCOUNTS_JSON=[{"label":"acc1","ndus":"...","BDUSS":"...","STOKEN":"..."}]

# ── DOWNLOAD TUNING ───────────────────────────────────────────────
# Parallel connections per file (1-32)
TRANSFER_DOWNLOAD_CHUNKS=8

# Max concurrent file downloads
TRANSFER_QUEUE_CONCURRENCY=3

# ── BULK TRANSFER (NEW) ───────────────────────────────────────────
# SQLite DB for bulk transfer state (resume support)
BULK_DATABASE_PATH=/tmp/terabox-bulk.sqlite

# Max files per bulk job
BULK_MAX_FILES=50000

# Concurrent downloads in bulk mode
BULK_CONCURRENCY=5

# ── ADMIN ─────────────────────────────────────────────────────────
ADMIN_API_KEY=your-secret-key-min-16-chars
```

---

## 6. Implementation Phases

### Phase 1: Reverse Engineering (Research) — Week 1

**Deliverables:**
- [ ] Internal download API endpoint documented
- [ ] Sign algorithm extracted aur verified
- [ ] `fs_id` extraction from share API confirmed
- [ ] Speed test results documented (10 files, various sizes)
- [ ] `TERABOX_INTERNAL_API_FINDINGS.md` file — exact endpoint, params, sign algo

**Tools needed:**
- Android emulator (Genymotion ya AVD) + mitmproxy
- jadx-gui
- Python script for sign algorithm testing
- Wireshark (optional, deeper packet inspection)

### Phase 2: Core Implementation — Week 1–2

**Deliverables:**
- [ ] `terabox-internal.ts` — `TeraBoxInternalClient` class complete
- [ ] `terabox.ts` — `fs_id`, `uk`, `shareid` extraction added
- [ ] `transfer.ts` — Internal API se URL fetch, fallback to dlink
- [ ] `config.ts` — New env vars added
- [ ] Unit tests for sign algorithm

### Phase 3: Account Pool + Bulk Transfer — Week 2–3

**Deliverables:**
- [ ] `account-pool.ts` — Multi-account rotation
- [ ] `bulk-transfer.ts` — 10,000 file pipeline
- [ ] Bot commands: `/bulk`, `/bulkstatus`, `/bulkcancel`
- [ ] Resumable state in SQLite
- [ ] Admin dashboard updated

### Phase 4: Production Testing — Week 3–4

**Deliverables:**
- [ ] 1,000 file test run (verify speed, stability)
- [ ] 10,000 file test run (full goal)
- [ ] Error rate <0.1% verified
- [ ] Documentation complete

---

## 7. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| TeraBox changes internal API | Medium | High | Fallback to dlink always available |
| BDUSS tokens expire | High | Medium | Early expiry detection + clear error |
| IP ban from bulk requests | Medium | High | Account rotation + request pacing |
| APK obfuscation (ProGuard) | Medium | Medium | Multiple reverse engineering methods |
| Sign algorithm changes with app update | Low | High | Pin to known-working APK version |
| TeraBox Premium required for speed | Low | Critical | Test with free + premium accounts |

---

## 8. Out of Scope (Is PRD mein nahi)

- TeraBox account creation automation
- Payment for TeraBox Premium (manual karna hoga)
- Illegal content handling (project ki existing policies apply)
- Non-TeraBox services (Google Drive, Mega — alag PRD chahiye)

---

## 9. Open Questions (Reverse Engineering ke baad answer honge)

1. Kya `fs_id` public share API se directly milta hai, ya alag API call chahiye?
2. Kya internal download URLs same CDN serve karte hain ya alag dedicated CDN?
3. Sign algorithm mein koi app-version-specific constant hai?
4. BDUSS validity period kitna hai? (Typically 10 years Baidu mein)
5. Kya free accounts bhi internal API pe full speed paate hain?
6. Rate limit trigger karne ke liye minimum requests per minute kya hai?

---

## Appendix A: Known TeraBox/Baidu API References

### Public Endpoints (Already Known)
```
GET https://dm.terabox.app/sharing/link?surl=XXX
GET https://dm.terabox.app/share/list?...
GET https://dm.terabox.app/share/verify?...  (password-protected shares)
```

### Likely Internal Endpoints (To Verify)
```
GET https://d.terabox.com/rest/2.0/xpan/file?method=download&...
GET https://pan.baidu.com/rest/2.0/xpan/multimedia?method=download&...
GET https://c3.terabox.com/file/...
POST https://pan.baidu.com/api/downloadurl?...
```

### Known App IDs
```
app_id: "250528"          (web)
app_id: "2919"            (Android legacy)
app_id: "7493840"         (iOS)
channel: "chunlei"        (Baidu Pan channel identifier)
```

### Useful Reference Projects (Study Only — No Code Copy)
```
bypy          — Baidu Pan Python CLI (sign algo reference)
BaiduPCS-Go   — Go implementation
baidupcs-web  — Web UI (has JS sign computation)
```

> **NOTE:** Inke code ko directly copy mat karo — sirf sign algorithm ki concept samajhne ke liye dekho aur independently TypeScript mein implement karo.

---

## Appendix B: File Structure After Implementation

```
artifacts/api-server/src/
├── index.ts                     (modified — account pool init)
├── config.ts                    (modified — new env vars)
├── server.ts                    (modified — bulk endpoints)
└── lib/
    ├── terabox.ts               (modified — fs_id, uk, shareid in response)
    ├── terabox-internal.ts      ← NEW: Internal API client + sign algorithm
    ├── account-pool.ts          ← NEW: Multi-account rotation
    ├── bulk-transfer.ts         ← NEW: 10,000 file pipeline
    ├── telegram.ts              (modified — /bulk commands)
    ├── transfer.ts              (modified — internal API integration)
    ├── transfer-store.ts        (no change)
    ├── mtproto-uploader.ts      (no change)
    ├── share-service.ts         (minor — cache key includes fs_id)
    ├── cache.ts                 (no change)
    └── utils.ts                 (no change)
```

---

*Document End — Version 1.0*
*Next step: Phase 1 — Android emulator setup + mitmproxy capture*
