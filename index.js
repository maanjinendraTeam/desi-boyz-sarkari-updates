
require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const express = require("express");
const fs = require("fs");
const path = require("path");

const SOURCE_URL = process.env.SOURCE_URL || "https://sarkariresult.com.cm/";
const INTERVAL = Math.max(5, Number(process.env.CHECK_EVERY_MINUTES || 15));
const PORT = Number(process.env.PORT || 3000);

const ROOT_DIR = path.join(__dirname, "..");
const OUT_DIR = path.resolve(ROOT_DIR, process.env.OUT_DIR || "out");
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATA_FILE = path.join(DATA_DIR, "posts.json");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// JSON Database
function readPosts() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("Database read error:", error.message);
    throw error;
  }
}

function writePosts(posts) {
  const tempFile = DATA_FILE + ".tmp";
  fs.writeFileSync(tempFile, JSON.stringify(posts, null, 2), "utf8");
  fs.renameSync(tempFile, DATA_FILE);
}

function insertPost(url, title, category, first_seen) {
  const posts = readPosts();

  if (posts.some(post => post.url === url)) {
    return false;
  }

  posts.push({
    url,
    title,
    category,
    first_seen,
    published: 0
  });

  writePosts(posts);
  return true;
}

function getAllPosts() {
  return readPosts()
    .sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen))
    .slice(0, 300);
}

function getCounts() {
  const posts = readPosts();

  return {
    total: posts.length,
    pending: posts.filter(post => !post.published).length
  };
}

function markPostAsPosted(url) {
  const posts = readPosts();
  const post = posts.find(item => item.url === url);

  if (!post) return false;

  post.published = 1;
  writePosts(posts);
  return true;
}

const CATEGORY_RULES = [
  ["Latest Jobs", /online form|recruitment|vacancy|bharti|apprentice|job/i],
  ["Results", /result|score card|merit list|cut.?off/i],
  ["Admit Card / Exam", /admit card|exam date|exam city|hall ticket|schedule/i],
  ["Answer Key", /answer key|objection|response sheet/i],
  ["Admission", /admission|counselling|entrance/i],
  ["Syllabus", /syllabus|exam pattern/i],
  ["Other Updates", /.*/]
];

function classify(title) {
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(title))[0];
}

function buildMessage(post) {
  return [
    `📢 ${post.category.toUpperCase()}`,
    "",
    `🔹 ${post.title}`,
    "",
    `🔗 More Details: ${post.url}`,
    "",
    "⚠️ आवेदन करने या कोई निर्णय लेने से पहले संबंधित विभाग की आधिकारिक अधिसूचना अवश्य जाँचें।",
    "",
    "Source: SarkariResult.com.cm"
  ].join("\n");
}

let lastScanAt = null;
let lastScanError = null;
let scanRunning = false;

async function fetchUpdates() {
  const response = await axios.get(SOURCE_URL, {
    timeout: 25000,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; UpdateReader/1.0)"
    }
  });

  const $ = cheerio.load(response.data);
  const seen = new Set();
  const now = new Date().toISOString();
  let discovered = 0;

  $("a[href]").each((_, element) => {
    const title = $(element).text().replace(/\s+/g, " ").trim();
    const href = $(element).attr("href");

    if (!title || title.length < 8 || !href) return;

    let absolute;

    try {
      absolute = new URL(href, SOURCE_URL).href;
    } catch {
      return;
    }

    if (new URL(absolute).hostname !== new URL(SOURCE_URL).hostname) return;
    if (absolute === SOURCE_URL || absolute.includes("#")) return;
    if (/\.(jpg|jpeg|png|gif|pdf|zip|css|js)$/i.test(absolute)) return;
    if (seen.has(absolute)) return;

    seen.add(absolute);

    if (insertPost(absolute, title, classify(title), now)) {
      discovered++;
    }
  });

  lastScanAt = new Date().toISOString();
  lastScanError = null;

  console.log(
    `[${new Date().toLocaleString()}] Scan complete. New links: ${discovered}`
  );

  return discovered;
}

function saveMessage(post) {
  const safeName = Buffer.from(post.url).toString("base64url").slice(0, 24);
  const outputPath = path.join(OUT_DIR, `${safeName}.txt`);

  fs.writeFileSync(outputPath, buildMessage(post), "utf8");
  return outputPath;
}

async function runScan() {
  if (scanRunning) {
    return { skipped: true, reason: "A scan is already running." };
  }

  scanRunning = true;

  try {
    const discovered = await fetchUpdates();
    const posts = getAllPosts();

    for (const post of posts) {
      if (!post.published) saveMessage(post);
    }

    return { ok: true, discovered };
  } catch (error) {
    lastScanError = error.message;
    console.error("Automation error:", error.message);

    return { ok: false, error: error.message };
  } finally {
    scanRunning = false;
  }
}

// Express Dashboard
const app = express();

app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, "public")));

app.get("/api/posts", (_req, res) => {
  const posts = getAllPosts().map(post => ({
    ...post,
    message: buildMessage(post)
  }));

  const counts = getCounts();

  res.json({
    posts,
    stats: {
      total: counts.total,
      pending: counts.pending,
      lastScanAt,
      lastScanError,
      scanRunning
    }
  });
});

app.post("/api/scan", async (_req, res) => {
  const result = await runScan();
  res.status(result.ok === false ? 502 : 200).json(result);
});

app.post("/api/posts/:encodedUrl/posted", (req, res) => {
  let url;

  try {
    url = Buffer.from(req.params.encodedUrl, "base64url").toString("utf8");
  } catch {
    return res.status(400).json({ error: "Invalid post identifier." });
  }

  if (!markPostAsPosted(url)) {
    return res.status(404).json({ error: "Post not found." });
  }

  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    source: SOURCE_URL,
    intervalMinutes: INTERVAL
  });
});

app.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Source: ${SOURCE_URL}`);
  console.log(`Scheduled scan: every ${INTERVAL} minutes`);
  console.log("WhatsApp publishing is manual.");
  runScan();
});

cron.schedule(`*/${INTERVAL} * * * *`, runScan);
