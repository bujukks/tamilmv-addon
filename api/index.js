const cheerio = require("cheerio");

// Each source becomes its own catalog row in Stremio.
// To add another row, add another object here (id must be unique, no spaces).
const SOURCES = [
  {
    id: "tamilmv-webhd",
    name: "TamilMV - Latest WebHD",
    url: "https://www.1tamilmv.capital/index.php?/forums/forum/11-web-hd-itunes-hd-bluray/&sortby=last_post&sortdirection=desc",
  },
  {
    id: "tamilmv-hollywood",
    name: "TamilMV - Hollywood Multi Audio",
    url: "https://www.1tamilmv.capital/index.php?/forums/forum/17-hollywood-movies-in-multi-audios/&sortby=last_post&sortdirection=desc",
  },
];

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

async function scrapeTopics(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!r.ok) throw new Error(`Source returned HTTP ${r.status}`);
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
  return out;
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
