const cheerio = require("cheerio");

// Catalogs come from the SOURCE_URL env var (set in Vercel, no code edits needed).
// Format: one catalog per line (or separated by ;), as   Name|URL
// Example:
//   WebHD|https://1tamilmv.fi/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/&sortby=last_post&sortdirection=desc
//   Hollywood|https://1tamilmv.fi/index.php?/forums/forum/17-hollywood-movies-in-multi-audios/&sortby=last_post&sortdirection=desc
// "Name|" is optional; a bare URL gets an automatic name.
const DEFAULT_SOURCES = [
  "TamilMV - Latest WebHD|https://1tamilmv.fi/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/&sortby=last_post&sortdirection=desc",
  "TamilMV - Hollywood Multi Audio|https://1tamilmv.fi/index.php?/forums/forum/17-hollywood-movies-in-multi-audios/&sortby=last_post&sortdirection=desc",
].join("\n");

function parseSources(raw) {
  const used = new Set();
  return raw
    .split(/[\n;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((entry, i) => {
      const bar = entry.indexOf("|");
      let name, url;
      if (bar > 0 && !/^https?:/i.test(entry.slice(0, bar))) {
        name = entry.slice(0, bar).trim();
        url = entry.slice(bar + 1).trim();
      } else {
        url = entry;
        name = `TamilMV Catalog ${i + 1}`;
      }
      let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "catalog-" + (i + 1);
      if (used.has(id)) id += "-" + (i + 1);
      used.add(id);
      return { id, name, url };
    })
    .filter((x) => /^https?:\/\//i.test(x.url));
}

const SOURCES = parseSources(process.env.SOURCE_URL || DEFAULT_SOURCES);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CINEMETA = "https://v3-cinemeta.strem.io";

const manifest = {
  id: "community.tamilmv.webhd",
  version: "1.0.0",
  name: "TamilMV WebHD",
  description: "Latest WebHD / HD releases from the TamilMV forum, matched to IMDb IDs.",
  resources: ["catalog"],
  types: ["movie"],
  idPrefixes: ["tt"],
  catalogs: SOURCES.map((s) => ({ type: "movie", id: s.id, name: s.name })),
  behaviorHints: { configurable: false },
};

// ---------- helpers ----------

// "Mandaadi (2026) Tamil HQ HDRip ..." -> { title: "Mandaadi", year: 2026 }
function parseTitle(raw) {
  const text = raw.replace(/\s+/g, " ").trim();
  const m = text.match(/^(.*?)\s*[(\[]\s*((?:19|20)\d{2})\s*[)\]]/);
  if (!m) return null;
  // drop leading tags like "[Tamil]" or "(Dubbed)"
  const title = m[1].replace(/^(\s*[\[(][^\])]*[\])])+\s*/, "").trim();
  if (!title) return null;
  return { title, year: parseInt(m[2], 10) };
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const yearOf = (m) => parseInt(m.year || m.releaseInfo, 10) || 0;

const resolved = new Map(); // in-memory cache (per warm instance)

async function resolveImdb({ title, year }) {
  const key = `${norm(title)}:${year}`;
  if (resolved.has(key)) return resolved.get(key);

  let meta = null;
  try {
    const url = `${CINEMETA}/catalog/movie/top/search=${encodeURIComponent(title)}.json`;
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    if (r.ok) {
      const { metas = [] } = await r.json();
      const close = (m) => Math.abs(yearOf(m) - year) <= 1;
      meta =
        metas.find((m) => norm(m.name) === norm(title) && close(m)) ||
        metas.find((m) => yearOf(m) === year && (norm(m.name).includes(norm(title)) || norm(title).includes(norm(m.name)))) ||
        null;
    }
  } catch (e) {
    // ignore, treated as unresolved
  }
  if (meta) resolved.set(key, meta);
  return meta;
}

// Fallback "front door" domains, e.g. the permanent .fi address that redirects to
// whichever domain is currently official. Comma-separated; override with FALLBACK_DOMAINS.
const FALLBACK_DOMAINS = (process.env.FALLBACK_DOMAINS || "https://1tamilmv.fi")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean)
  .map((d) => (/^https?:\/\//i.test(d) ? d : "https://" + d));

const originCache = new Map(); // fallback domain -> { origin, at }
const ORIGIN_TTL_MS = 60 * 60 * 1000;

// Follow the fallback domain's redirect and return the origin it lands on.
async function discoverOrigin(front) {
  const hit = originCache.get(front);
  if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.origin;
  try {
    const r = await fetch(front, { redirect: "follow", headers: { "User-Agent": UA, Accept: "text/html" } });
    const origin = new URL(r.url).origin;
    originCache.set(front, { origin, at: Date.now() });
    return origin;
  } catch (e) {
    console.error(`Could not resolve ${front}: ${e.message}`);
    return null;
  }
}

async function fetchTopics(url) {
  const headers = { "User-Agent": UA, Accept: "text/html" };
  const want = new URL(url);
  let r = await fetch(url, { headers });

  // If we were redirected to a different domain (e.g. .fi -> current domain), the
  // redirect often drops the forum path and sort options, so repeat them there.
  const landed = new URL(r.url || url);
  if (landed.origin !== want.origin) {
    const retry = landed.origin + want.pathname + want.search;
    console.error(`${want.origin} redirected to ${landed.href}; retrying ${retry}`);
    r = await fetch(retry, { headers });
  }

  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const $ = cheerio.load(await r.text());

  let links = $(".ipsDataItem_title a[href*='/topic/']");
  if (!links.length) links = $("a[href*='/topic/']");

  const seen = new Set();
  const out = [];
  links.each((_, el) => {
    const href = $(el).attr("href");
    if (!href || seen.has(href)) return;
    seen.add(href);
    const parsed = parseTitle($(el).text());
    if (parsed) out.push(parsed);
  });
  if (!out.length) console.error(`0 titles parsed (${links.length} topic links). Page title: "${$("title").text().trim()}"`);
  return out;
}

// Try the configured URL first; if it fails or returns nothing, retry the same
// path on each fallback domain's current (redirected) origin.
async function scrapeTopics(url) {
  const tried = new Set();
  const attempt = async (u) => {
    if (tried.has(u)) return null;
    tried.add(u);
    try {
      const topics = await fetchTopics(u);
      if (topics.length) return topics;
      console.error(`No topics found at ${u}`);
    } catch (e) {
      console.error(`Fetch failed for ${u}: ${e.message}`);
    }
    return null;
  };

  let topics = await attempt(url);
  if (topics) return topics;

  const parsed = new URL(url);
  for (const front of FALLBACK_DOMAINS) {
    const origin = await discoverOrigin(front);
    if (!origin) continue;
    topics = await attempt(origin + parsed.pathname + parsed.search);
    if (topics) return topics;
  }
  throw new Error("All domains failed");
}

const catalogCache = {}; // per-source cache
const TTL_MS = 15 * 60 * 1000;

async function buildCatalog(source) {
  const cached = catalogCache[source.id];
  if (cached && Date.now() - cached.at < TTL_MS) return cached.metas;

  const topics = await scrapeTopics(source.url);
  const results = await Promise.all(topics.map(resolveImdb));

  const seen = new Set();
  const metas = [];
  for (const m of results) {
    if (!m || !m.id || seen.has(m.id)) continue; // dedupe: same movie, many uploads
    seen.add(m.id);
    metas.push({
      id: m.id,
      type: "movie",
      name: m.name,
      poster: m.poster,
      background: m.background,
      releaseInfo: m.releaseInfo || String(m.year || ""),
    });
  }
  if (metas.length) catalogCache[source.id] = { at: Date.now(), metas };
  return metas;
}

// ---------- handler ----------

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.status(204).end();

  const route = req.query.r;
  try {
    if (route === "manifest") {
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.status(200).send(JSON.stringify(manifest));
    }
    if (route === "catalog") {
      const source = SOURCES.find((x) => x.id === req.query.id);
      if (source) {
        const metas = await buildCatalog(source);
        res.setHeader("Cache-Control", "public, s-maxage=900, stale-while-revalidate=3600");
        return res.status(200).send(JSON.stringify({ metas }));
      }
    }
    return res.status(404).send(JSON.stringify({ error: "Not found" }));
  } catch (e) {
    console.error(e);
    return res.status(200).send(JSON.stringify({ metas: [] }));
  }
};
