#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";

const GH_USER = process.env.GH_USER ?? "Borges1607";
const GH_TOKEN = process.env.GH_TOKEN;
const BB_WORKSPACE = process.env.BB_WORKSPACE;
const BB_USER = process.env.BB_USER;
const BB_APP_PASSWORD = process.env.BB_APP_PASSWORD;
const BB_EMAILS = (process.env.BB_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const OUT_DIR = process.env.OUT_DIR ?? "dist";
const MOCK = process.env.MOCK === "1";

const WEEKS = 53;
const DAYS = 7;

const iso = (d) => d.toISOString().slice(0, 10);

/* ------------------------------------------------------------------ janela */

function window52Weeks() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  // termina no sábado da semana atual
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (WEEKS * DAYS - 1));
  return { start, end };
}

/* ------------------------------------------------------------------ GitHub */

async function fetchGitHub(start, end) {
  if (!GH_TOKEN) {
    console.warn("! GH_TOKEN ausente — pulando GitHub");
    return new Map();
  }
  const query = `
    query($login:String!, $from:DateTime!, $to:DateTime!) {
      user(login:$login) {
        contributionsCollection(from:$from, to:$to) {
          contributionCalendar {
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${GH_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "snake-generator",
    },
    body: JSON.stringify({
      query,
      variables: {
        login: GH_USER,
        from: start.toISOString(),
        to: end.toISOString(),
      },
    }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));

  const map = new Map();
  for (const w of json.data.user.contributionsCollection.contributionCalendar
    .weeks)
    for (const d of w.contributionDays)
      if (d.contributionCount > 0) map.set(d.date, d.contributionCount);
  console.log(`GitHub: ${map.size} dias com contribuição`);
  return map;
}

/* --------------------------------------------------------------- Bitbucket */

async function bb(url) {
  const auth = Buffer.from(`${BB_USER}:${BB_APP_PASSWORD}`).toString("base64");
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Bitbucket ${res.status}: ${await res.text()}`);
  return res.json();
}

function extractEmail(raw = "") {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).toLowerCase();
}

async function fetchBitbucket(start) {
  if (!BB_WORKSPACE || !BB_USER || !BB_APP_PASSWORD) {
    console.warn("! credenciais do Bitbucket ausentes — pulando Bitbucket");
    return new Map();
  }
  const map = new Map();
  const startTs = start.getTime();

  // 1. lista os repositórios do workspace
  const repos = [];
  let url = `https://api.bitbucket.org/2.0/repositories/${BB_WORKSPACE}?pagelen=100&role=member&fields=next,values.slug`;
  while (url) {
    const page = await bb(url);
    repos.push(...page.values.map((r) => r.slug));
    url = page.next;
  }
  console.log(`Bitbucket: ${repos.length} repositórios`);

  // 2. percorre os commits de cada um
  for (const slug of repos) {
    let next = `https://api.bitbucket.org/2.0/repositories/${BB_WORKSPACE}/${slug}/commits?pagelen=100&fields=next,values.date,values.author.raw,values.hash`;
    const seen = new Set();
    let stop = false;
    while (next && !stop) {
      let page;
      try {
        page = await bb(next);
      } catch (e) {
        console.warn(`  ${slug}: ${e.message.slice(0, 120)}`);
        break;
      }
      for (const c of page.values ?? []) {
        const ts = new Date(c.date).getTime();
        if (ts < startTs) {
          stop = true;
          continue;
        }
        if (seen.has(c.hash)) continue;
        seen.add(c.hash);
        const email = extractEmail(c.author?.raw);
        if (BB_EMAILS.length && !BB_EMAILS.includes(email)) continue;
        const day = iso(new Date(c.date));
        map.set(day, (map.get(day) ?? 0) + 1);
      }
      next = stop ? null : page.next;
    }
  }
  console.log(`Bitbucket: ${map.size} dias com commits`);
  return map;
}

/* -------------------------------------------------------------------- mock */

function mockData(start) {
  const map = new Map();
  for (let i = 0; i < WEEKS * DAYS; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (Math.random() < 0.45) map.set(iso(d), 1 + Math.floor(Math.random() * 12));
  }
  return map;
}

/* -------------------------------------------------------------------- grid */

function buildGrid(counts, start) {
  const cells = [];
  for (let x = 0; x < WEEKS; x++)
    for (let y = 0; y < DAYS; y++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + x * DAYS + y);
      const n = counts.get(iso(d)) ?? 0;
      cells.push({ x, y, date: iso(d), n, level: level(n) });
    }
  return cells;
}

const level = (n) => (n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4);

/* ------------------------------------------------------------------- trajeto */

function buildPath() {
  const p = [];
  for (let x = 0; x < WEEKS; x++) {
    const rows = x % 2 === 0 ? [0, 1, 2, 3, 4, 5, 6] : [6, 5, 4, 3, 2, 1, 0];
    for (const y of rows) p.push({ x, y });
  }
  // caminho de volta, por fora do grid, para fechar o ciclo
  const last = p[p.length - 1];
  const outY = last.y === 6 ? DAYS : -1;
  p.push({ x: last.x, y: outY });
  for (let x = last.x - 1; x >= -1; x--) p.push({ x, y: outY });
  const step = outY === DAYS ? -1 : 1;
  for (let y = outY + step; y !== 0; y += step) p.push({ x: -1, y });
  p.push({ x: -1, y: 0 });
  return p;
}

/* --------------------------------------------------------------------- SVG */

const THEMES = {
  light: {
    empty: "#ebedf0",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: "#7c3aed",
    stroke: "rgba(27,31,35,0.06)",
  },
  dark: {
    empty: "#161b22",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: "#a78bfa",
    stroke: "rgba(240,246,252,0.1)",
  },
};

const CELL = 12;
const GAP = 3;
const STRIDE = CELL + GAP;
const PAD = 2 + STRIDE; // espaço para o trajeto de volta
const SNAKE_LEN = 5;
const STEP_MS = 90;

const px = (i) => PAD + i * STRIDE;

function renderSVG(cells, path, theme) {
  const t = THEMES[theme];
  const n = path.length;
  const total = n * STEP_MS;
  const width = px(WEEKS) + PAD - GAP;
  const height = px(DAYS) + PAD - GAP;

  // quando cada célula é comida
  const eatAt = new Map();
  path.forEach((p, i) => eatAt.set(`${p.x},${p.y}`, i));

  const rects = [];
  const anims = [];

  for (const c of cells) {
    const key = `${c.x},${c.y}`;
    const fill = t.levels[c.level];
    if (c.level === 0) {
      rects.push(
        `<rect class="c" x="${px(c.x)}" y="${px(c.y)}" width="${CELL}" height="${CELL}" rx="2" fill="${t.empty}"/>`
      );
      continue;
    }
    const i = eatAt.get(key);
    const pct = ((i / n) * 100).toFixed(3);
    const name = `e${c.x}_${c.y}`;
    rects.push(
      `<rect class="c ${name}" x="${px(c.x)}" y="${px(c.y)}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"><title>${c.date}: ${c.n}</title></rect>`
    );
    anims.push(
      `@keyframes ${name}{0%,${pct}%{fill:${fill}}${(Number(pct) + 0.35).toFixed(3)}%,100%{fill:${t.empty}}}` +
        `.${name}{animation:${name} ${total}ms linear infinite}`
    );
  }

  // keyframes do trajeto (compartilhado por todos os segmentos)
  const stops = path
    .map(
      (p, i) =>
        `${((i / n) * 100).toFixed(3)}%{transform:translate(${px(p.x)}px,${px(p.y)}px)}`
    )
    .join("");
  const move = `@keyframes move{${stops}100%{transform:translate(${px(path[0].x)}px,${px(path[0].y)}px)}}`;

  const segments = Array.from({ length: SNAKE_LEN }, (_, k) => {
    const o = 1 - (k / SNAKE_LEN) * 0.75;
    const inset = k === 0 ? 0 : 1;
    return `<rect class="s" x="${inset}" y="${inset}" width="${CELL - inset * 2}" height="${CELL - inset * 2}" rx="${k === 0 ? 3 : 2}" fill="${t.snake}" opacity="${o.toFixed(2)}" style="animation-delay:${-k * STEP_MS}ms"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>
.c{stroke:${t.stroke};stroke-width:1;shape-rendering:crispEdges}
.s{animation:move ${total}ms linear infinite;transform-origin:0 0}
${move}
${anims.join("\n")}
</style>
<g>${rects.join("")}</g>
<g>${segments}</g>
</svg>`;
}

/* -------------------------------------------------------------------- main */

const { start, end } = window52Weeks();
console.log(`Janela: ${iso(start)} → ${iso(end)}`);

let counts;
if (MOCK) {
  counts = mockData(start);
} else {
  const [gh, bbm] = await Promise.all([
    fetchGitHub(start, end),
    fetchBitbucket(start),
  ]);
  counts = new Map(gh);
  for (const [d, n] of bbm) counts.set(d, (counts.get(d) ?? 0) + n);
}

const totalContribs = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`Total combinado: ${totalContribs} contribuições`);

const cells = buildGrid(counts, start);
const path = buildPath();

await mkdir(OUT_DIR, { recursive: true });
for (const theme of ["light", "dark"]) {
  const file = `${OUT_DIR}/snake${theme === "dark" ? "-dark" : ""}.svg`;
  await writeFile(file, renderSVG(cells, path, theme));
  console.log(`✓ ${file}`);
}
