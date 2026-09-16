interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * ny-authority-debt — New York public authority debt issuance.
 * Fleet #1001.
 *
 * New York's Authorities Budget Office requires every public authority to
 * report the debt it issues each fiscal year, and the state publishes that on
 * data.ny.gov as four Socrata datasets split by authority class. Together they
 * are issue-level: project, closing date, par, refunding-vs-new, true interest
 * cost, term, and a link to the authority's own official statement.
 *
 * WHY FOUR DATASETS AND NOT ONE. The classes are legally distinct kinds of
 * issuer (a state authority is not an Industrial Development Agency), they are
 * maintained separately, and a caller asking "who issued debt in New York"
 * means all four. So the pack queries all four and labels each row with the
 * class it came from, rather than making the caller know the taxonomy.
 *
 * ── CUSIP IS DELIBERATELY DROPPED ────────────────────────────────────────
 * The State Authorities dataset (83xh-6x8i) carries a `cusip_number` column,
 * populated on 1,295 rows with real 9-character CUSIPs. CUSIP identifiers are
 * licensed by CUSIP Global Services, and that licence — not copyright in the
 * underlying facts — is the binding constraint. This pack therefore never
 * returns, indexes or filters on that column: it is stripped in `shape()` and
 * there is no CUSIP input anywhere. Everything keys on the issuer name, and
 * FIGI (via the `openfigi` pack) is the identifier we point callers at for an
 * individual bond. Do not "helpfully" add it back.
 *
 * ── EMMA IS LINKED, NEVER FETCHED ────────────────────────────────────────
 * MSRB's EMMA terms are a contract accepted by using the site, and they forbid
 * building a database from their content. This pack makes exactly one gesture
 * toward EMMA: it composes a search URL for the issuer name. It never fetches,
 * parses, caches or redistributes anything from emma.msrb.org. The field is
 * named `emma_search_url` rather than something like `emma_bond_page` because
 * that is what it honestly is — verified 2026-09-01 that the path returns 200,
 * but the page is script-driven and we deliberately do not parse it, so we
 * cannot promise the query parameter pre-fills the search.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────
 * This is PRIMARY-MARKET issuance: what was sold, when, on what terms. It is
 * not the secondary trade tape, and no reported transaction prices exist here.
 * Most municipal bonds also trade infrequently enough to have no current price
 * at all; what vendors sell as a muni "price" is usually an EVALUATED price,
 * an estimate rather than a trade. Tool descriptions say so, because a caller
 * who assumes otherwise will misread silence as "no trades happened".
 */


const BASE = 'https://data.ny.gov/resource';
const UA = 'pipeworx-mcp-ny-authority-debt/1.0 (+https://pipeworx.io)';

/**
 * The four authority classes. `id` is the Socrata resource.
 *
 * TRAP worth keeping written down: querying another state's Socrata catalog
 * (e.g. data.texas.gov) returns these SAME dataset ids, because the Socrata
 * catalog API FEDERATES across domains. Texas does not publish them. Always
 * check `metadata.domain` on a catalog hit before attributing a dataset to a
 * state. Verified 2026-09-01: all four report domain data.ny.gov.
 */
const CLASSES = [
  { key: 'state', id: '83xh-6x8i', label: 'State Authority' },
  { key: 'local', id: 'qbd7-9grw', label: 'Local Authority' },
  { key: 'ida', id: 'cci8-aavx', label: 'Industrial Development Agency' },
  { key: 'ldc', id: 'sh2f-cc7d', label: 'Local Development Corporation' },
] as const;

type ClassKey = (typeof CLASSES)[number]['key'];

const CAVEAT =
  'New York public authority debt ISSUANCE (primary market): what each authority sold, when, and on what terms, as reported to the Authorities Budget Office. Reported secondary-market trade prices are NOT included — and most municipal bonds trade infrequently enough to have no current market price at all, so their absence is not a gap in this data. CUSIP identifiers are deliberately not returned (separately licensed). To identify an individual bond instead: openfigi_search on the issuer name returns candidate bonds each carrying a ticker with its coupon and maturity, and openfigi_map with {idType:"TICKER", marketSecDes:"Muni"} turns one of those tickers into its FIGI. openfigi_search will not find a bond by ticker.';

interface Raw { [k: string]: unknown }

function s(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' || t.toLowerCase() === 'none' ? null : t;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Socrata floating timestamps: "2024-05-09T00:00:00.000" -> "2024-05-09". */
function day(v: unknown): string | null {
  const t = String(v ?? '');
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * `statement_url` arrives as a Socrata URL object ({url: "..."}), not a bare
 * string.
 *
 * Where it points varies and BOTH cases matter: many rows link to a PDF hosted
 * on emma.msrb.org (all ten sampled Dormitory Authority issues did), others to
 * the authority's own site (bpca.ny.gov). Either way this is a LINK that New
 * York itself published, passed straight through — which is exactly the
 * "deep-link to the authoritative document, never fetch it" line. Nothing here
 * requests, parses or stores the target.
 */
function statementUrl(v: unknown): string | null {
  if (v && typeof v === 'object' && 'url' in (v as Record<string, unknown>)) {
    return s((v as Record<string, unknown>).url);
  }
  return s(v);
}

function emmaSearchUrl(issuer: string): string {
  return `https://emma.msrb.org/Search/Search.aspx?searchText=${encodeURIComponent(issuer)}`;
}

function shape(r: Raw, cls: { key: string; label: string }) {
  const issuer = s(r.authority_name) ?? '';
  return {
    authority: issuer,
    authority_class: cls.label,
    authority_class_key: cls.key,
    fiscal_year_end: day(r.fiscal_year_end_date),
    issued_debt_this_year: s(r.issued_debt_obligations) === 'Y',
    type_of_debt: s(r.type_of_debt),
    program: s(r.program),
    project_name: s(r.project_name),
    bond_closing_date: day(r.bond_closing_date),
    taxable_status: s(r.taxable_status),
    issue_process: s(r.issue_process),
    interest_type: s(r.interest_type),
    term_years: num(r.term_years),
    true_interest_cost_pct: num(r.true_interest_cost),
    cost_of_issuance: num(r.cost_of_issuance),
    new_amount: num(r.new_amount),
    refunding_amount: num(r.refunding_amount),
    total_amount: num(r.total_amount),
    official_statement_url: statementUrl(r.statement_url),
    emma_search_url: issuer ? emmaSearchUrl(issuer) : null,
    // cusip_number is intentionally absent — see the file header.
  };
}

/** PostgREST-style single quotes must be doubled inside a SoQL string literal. */
const soq = (v: string) => v.replace(/'/g, "''");

async function socrata(id: string, query: string): Promise<Raw[]> {
  const res = await fetchWithTimeout(
    `${BASE}/${id}.json?${query}`,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    'data.ny.gov',
  );
  if (!res.ok) throw await httpError(res, `data.ny.gov ${id}`);
  return (await res.json()) as Raw[];
}

function pickClasses(k?: string): typeof CLASSES[number][] {
  if (!k) return [...CLASSES];
  const want = k.toLowerCase().trim();
  const hit = CLASSES.filter(
    (c) => c.key === want || c.label.toLowerCase().includes(want),
  );
  return hit.length ? hit : [...CLASSES];
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ny_authority_debt_search',
    description:
      'Search New York municipal bond and debt issues sold by public authorities — state authorities, local authorities, Industrial Development Agencies and Local Development Corporations. Returns the issuing authority, the project financed, bond closing date, par amount split into new money and refunding, true interest cost, term, tax-exempt or taxable status, competitive or negotiated sale, and a link to the authority\'s own official statement. Answers "what bonds did the Dormitory Authority issue", "New York tax-exempt issues over $100 million", "who financed this project". This is primary-market issuance as reported to the Authorities Budget Office; reported secondary-market trade prices are not included, and most municipal bonds trade too infrequently to have a current price at all.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        authority: { type: 'string', description: 'Issuing authority name, matched loosely — "Dormitory" finds "Dormitory Authority of the State of New York".' },
        authority_class: { type: 'string', description: 'Restrict to one class: state | local | ida | ldc. Omit to search all four.' },
        project: { type: 'string', description: 'Free-text match on the financed project name.' },
        type_of_debt: { type: 'string', description: 'Free-text match on the debt type, e.g. "General Obligation", "Revenue".' },
        taxable_status: { type: 'string', description: 'e.g. "Tax Exempt" or "Taxable".' },
        since: { type: 'string', description: 'Earliest bond closing date, YYYY-MM-DD.' },
        until: { type: 'string', description: 'Latest bond closing date, YYYY-MM-DD.' },
        min_amount: { type: 'number', description: 'Minimum total par amount in dollars.' },
        limit: { type: 'number', description: 'Max issues to return (default 50, max 500).' },
      },
      required: [],
    },
  },
  {
    name: 'ny_authority_debt_profile',
    description:
      'Everything one New York public authority has issued: every bond and debt issue with its terms, plus totals by fiscal year and a breakdown of new money versus refunding. Answers "how much has the Dormitory Authority borrowed", "what has Battery Park City Authority issued and at what interest cost", "is this issuer mostly refinancing". Covers primary-market issuance only — no reported trade prices.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        authority: { type: 'string', description: 'Authority name, matched loosely, e.g. "Battery Park City".' },
        limit: { type: 'number', description: 'Max issues to return (default 200, max 500).' },
      },
      required: ['authority'],
    },
  },
  {
    name: 'ny_authority_debt_totals',
    description:
      'Aggregate New York public authority borrowing by year and by authority class — total par issued, how much was new money versus refunding, and the most active issuers. Answers "how much did New York authorities borrow in 2024", "which New York issuers borrow the most", "how much of this is refinancing". Primary-market issuance only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        authority_class: { type: 'string', description: 'Restrict to one class: state | local | ida | ldc. Omit for all four.' },
        since: { type: 'string', description: 'Earliest bond closing date, YYYY-MM-DD.' },
        top: { type: 'number', description: 'How many top issuers to return (default 15).' },
      },
      required: [],
    },
  },
  {
    name: 'ny_authority_debt_coverage',
    description:
      'What New York public authority debt data is available: the four authority classes covered, how many issues each holds, the date range, and an explicit statement of what is NOT here (no reported secondary-market trade prices, no CUSIP identifiers). Read this before treating an empty search result as evidence that an authority issued nothing.',
    inputSchema: { type: 'object' as const, properties: {}, required: [] },
  },
];

async function search(a: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
  const classes = pickClasses(a.authority_class as string | undefined);
  const w: string[] = ["issued_debt_obligations='Y'"];
  if (a.authority) w.push(`upper(authority_name) like upper('%${soq(String(a.authority))}%')`);
  if (a.project) w.push(`upper(project_name) like upper('%${soq(String(a.project))}%')`);
  if (a.type_of_debt) w.push(`upper(type_of_debt) like upper('%${soq(String(a.type_of_debt))}%')`);
  if (a.taxable_status) w.push(`upper(taxable_status) like upper('%${soq(String(a.taxable_status))}%')`);
  if (a.since) w.push(`bond_closing_date >= '${soq(String(a.since))}'`);
  if (a.until) w.push(`bond_closing_date <= '${soq(String(a.until))}'`);
  if (a.min_amount != null) w.push(`total_amount >= ${Number(a.min_amount)}`);

  const per = Math.max(Math.ceil(limit / classes.length), 10);
  const out: ReturnType<typeof shape>[] = [];
  const failed: string[] = [];

  await Promise.all(classes.map(async (c) => {
    try {
      // taxable_status exists only on the State Authorities dataset; asking
      // the others for it is a 400, so that filter narrows the class list
      // rather than erroring the whole call.
      const where = w.filter((x) => c.key === 'state' || !x.includes('taxable_status'));
      const rows = await socrata(
        c.id,
        `$where=${encodeURIComponent(where.join(' AND '))}&$order=bond_closing_date DESC&$limit=${per}`,
      );
      for (const r of rows) out.push(shape(r, c));
    } catch (e) {
      failed.push(`${c.label}: ${(e as Error).message.slice(0, 90)}`);
    }
  }));

  out.sort((x, y) => (y.bond_closing_date ?? '').localeCompare(x.bond_closing_date ?? ''));
  const issues = out.slice(0, limit);

  if (!issues.length) {
    return {
      found: false,
      reason: failed.length === classes.length ? 'upstream_error' : 'no_matching_issues',
      hint: failed.length === classes.length
        ? `data.ny.gov did not answer: ${failed.join('; ')}`
        : 'No issue matched. Widen the date range, drop min_amount, or try a shorter authority fragment — names are long and official ("Dormitory Authority of the State of New York").',
      classes_searched: classes.map((c) => c.label),
      ...(failed.length ? { partial_failures: failed } : {}),
      caveat: CAVEAT,
    };
  }

  return {
    found: true,
    count: issues.length,
    total_par: issues.reduce((n, i) => n + (i.total_amount ?? 0), 0),
    classes_searched: classes.map((c) => c.label),
    issues,
    ...(failed.length ? { partial_failures: failed } : {}),
    caveat: CAVEAT,
  };
}

async function profile(a: Record<string, unknown>) {
  const name = String(a.authority ?? '').trim();
  const limit = Math.min(Math.max(Number(a.limit) || 200, 1), 500);
  if (!name) {
    return { found: false, reason: 'missing_authority', hint: 'Pass an authority name, e.g. {"authority":"Battery Park City"}.' };
  }
  const out: ReturnType<typeof shape>[] = [];
  await Promise.all(CLASSES.map(async (c) => {
    try {
      const rows = await socrata(
        c.id,
        `$where=${encodeURIComponent(`issued_debt_obligations='Y' AND upper(authority_name) like upper('%${soq(name)}%')`)}`
        + `&$order=bond_closing_date DESC&$limit=${limit}`,
      );
      for (const r of rows) out.push(shape(r, c));
    } catch { /* a class that 400s or is down is reported via count, not thrown */ }
  }));

  if (!out.length) {
    return {
      found: false,
      authority: name,
      reason: 'no_such_authority_or_no_issuance',
      hint: `No New York authority matching "${name}" reported a debt issue. Try a shorter fragment, or call ny_authority_debt_coverage to see what is covered.`,
      caveat: CAVEAT,
    };
  }

  const names = [...new Set(out.map((i) => i.authority))];
  const byYear: Record<string, { issues: number; total_par: number }> = {};
  let newMoney = 0; let refunding = 0;
  for (const i of out) {
    const y = (i.bond_closing_date ?? i.fiscal_year_end ?? '').slice(0, 4) || 'unknown';
    byYear[y] = byYear[y] ?? { issues: 0, total_par: 0 };
    byYear[y].issues += 1;
    byYear[y].total_par += i.total_amount ?? 0;
    newMoney += i.new_amount ?? 0;
    refunding += i.refunding_amount ?? 0;
  }

  return {
    found: true,
    authority: name,
    matched_authorities: names,
    total_issues: out.length,
    total_par: out.reduce((n, i) => n + (i.total_amount ?? 0), 0),
    new_money_total: newMoney,
    refunding_total: refunding,
    by_year: byYear,
    issues: out.slice(0, limit),
    caveat: CAVEAT,
  };
}

async function totals(a: Record<string, unknown>) {
  const classes = pickClasses(a.authority_class as string | undefined);
  const top = Math.min(Math.max(Number(a.top) || 15, 1), 100);
  const w = ["issued_debt_obligations='Y'"];
  if (a.since) w.push(`bond_closing_date >= '${soq(String(a.since))}'`);

  const rows: ReturnType<typeof shape>[] = [];
  await Promise.all(classes.map(async (c) => {
    try {
      const r = await socrata(
        c.id,
        `$where=${encodeURIComponent(w.join(' AND '))}&$limit=50000`,
      );
      for (const x of r) rows.push(shape(x, c));
    } catch { /* class-level failure surfaces as a missing class below */ }
  }));

  const byYear: Record<string, { issues: number; total_par: number; new_money: number; refunding: number }> = {};
  const byClass: Record<string, { issues: number; total_par: number }> = {};
  const byIssuer: Record<string, { issues: number; total_par: number }> = {};
  for (const i of rows) {
    const y = (i.bond_closing_date ?? i.fiscal_year_end ?? '').slice(0, 4) || 'unknown';
    byYear[y] = byYear[y] ?? { issues: 0, total_par: 0, new_money: 0, refunding: 0 };
    byYear[y].issues += 1;
    byYear[y].total_par += i.total_amount ?? 0;
    byYear[y].new_money += i.new_amount ?? 0;
    byYear[y].refunding += i.refunding_amount ?? 0;
    byClass[i.authority_class] = byClass[i.authority_class] ?? { issues: 0, total_par: 0 };
    byClass[i.authority_class].issues += 1;
    byClass[i.authority_class].total_par += i.total_amount ?? 0;
    byIssuer[i.authority] = byIssuer[i.authority] ?? { issues: 0, total_par: 0 };
    byIssuer[i.authority].issues += 1;
    byIssuer[i.authority].total_par += i.total_amount ?? 0;
  }

  return {
    found: rows.length > 0,
    issues_counted: rows.length,
    total_par: rows.reduce((n, i) => n + (i.total_amount ?? 0), 0),
    by_year: byYear,
    by_authority_class: byClass,
    top_issuers: Object.entries(byIssuer)
      .sort((a2, b2) => b2[1].total_par - a2[1].total_par)
      .slice(0, top)
      .map(([authority, v]) => ({ authority, ...v })),
    caveat: CAVEAT,
  };
}

async function coverage() {
  const per = await Promise.all(CLASSES.map(async (c) => {
    try {
      const [cnt] = await socrata(c.id, '$select=count(1)');
      const [rng] = await socrata(
        c.id,
        `$select=min(bond_closing_date) as a,max(bond_closing_date) as b&$where=${encodeURIComponent("issued_debt_obligations='Y'")}`,
      );
      return {
        authority_class: c.label,
        key: c.key,
        dataset: `https://data.ny.gov/d/${c.id}`,
        rows: Number((cnt as Raw).count_1 ?? 0),
        earliest_closing: day((rng as Raw).a),
        latest_closing: day((rng as Raw).b),
      };
    } catch (e) {
      return { authority_class: c.label, key: c.key, dataset: `https://data.ny.gov/d/${c.id}`, error: (e as Error).message.slice(0, 100) };
    }
  }));

  return {
    source: 'New York State Authorities Budget Office reporting, published on data.ny.gov',
    authority_classes: per,
    total_rows: per.reduce((n, p) => n + (('rows' in p ? p.rows : 0) || 0), 0),
    not_included: {
      trade_prices: 'No reported secondary-market transaction prices. Most municipal bonds trade infrequently and have no continuously updated price; vendor "prices" for them are typically EVALUATED estimates rather than trades.',
      cusip: 'CUSIP identifiers are not returned. They are separately licensed by CUSIP Global Services. Use the issuer name here, or openfigi_search to identify an individual bond by FIGI.',
      other_states: 'New York public authorities only. California issuance is covered by the ca-debtwatch pack; other states are not yet covered.',
    },
    caveat: CAVEAT,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ny_authority_debt_search': return search(args);
    case 'ny_authority_debt_profile': return profile(args);
    case 'ny_authority_debt_totals': return totals(args);
    case 'ny_authority_debt_coverage': return coverage();
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
