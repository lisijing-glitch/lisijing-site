/* ==========================================================================
   SIJING — site script
   Reads /data/*.json at runtime and renders every view. No build step:
   adding a work never touches this file — it only ever touches the JSON.
   ========================================================================== */

(() => {
  "use strict";

  const LANGS = ["zh", "jp", "en"];
  let currentLang = localStorage.getItem("sijing_lang") || "zh";
  let siteData = { works: [], cv: { exhibitions: [] }, about: {} };

  /* ---- UI micro-copy the artist doesn't need to edit ---- */
  const PAGE_TITLES = {
    about: { zh: "关于", jp: "アバウト", en: "About" },
    statement: { zh: "创作自述", jp: "ステートメント", en: "Statement" },
    works: { zh: "作品", jp: "作品", en: "Works" },
    cv: { zh: "履历", jp: "CV", en: "CV" },
    research: { zh: "研究", jp: "リサーチ", en: "Research" },
    contact: { zh: "联系", jp: "コンタクト", en: "Contact" },
  };
  const META_LABELS = {
    year: { zh: "年份", jp: "制作年", en: "Year" },
    size: { zh: "尺寸", jp: "サイズ", en: "Size" },
    material: { zh: "材料", jp: "素材", en: "Material" },
  };
  const STATUS_SOLD = { zh: "已售", jp: "売却済", en: "Sold" };
  const BACK_LABEL = { zh: "← 返回作品", jp: "← 作品一覧へ", en: "← Back to works" };
  const EMPTY_WORKS = { zh: "尚无作品。", jp: "作品はまだありません。", en: "No works yet." };
  const EMPTY_WORKS_HINT = {
    zh: "通过后台新增第一件作品。",
    jp: "管理画面から最初の作品を追加してください。",
    en: "Add your first work from the admin panel.",
  };
  const EMPTY_CV = { zh: "尚无展览记录。", jp: "展示履歴はまだありません。", en: "No exhibitions yet." };
  const NOT_FOUND = { zh: "未找到该作品。", jp: "作品が見つかりません。", en: "Work not found." };
  window.SIJING_CATEGORY_LABELS = {
    solo: { zh: "个展", jp: "個展", en: "Solo Exhibition" },
    group: { zh: "群展", jp: "グループ展", en: "Group Exhibition" },
    award: { zh: "获奖", jp: "受賞", en: "Award" },
    collection: { zh: "收藏", jp: "コレクション", en: "Collection" },
    other: { zh: "其他", jp: "その他", en: "Other" },
  };

  function pick(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj[currentLang] || obj.zh || obj.en || obj.jp || "";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  /* ---- data ---- */

  async function loadData() {
    const [works, cv, about] = await Promise.all([
      fetch("data/works.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch("data/cv.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { exhibitions: [] })).catch(() => ({ exhibitions: [] })),
      fetch("data/about.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    siteData = { works: Array.isArray(works) ? works : [], cv: cv || { exhibitions: [] }, about: about || {} };
  }

  function groupByYear(list, yearFn) {
    const map = new Map();
    list.forEach((item) => {
      const y = yearFn(item) || "——";
      if (!map.has(y)) map.set(y, []);
      map.get(y).push(item);
    });
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0));
  }

  /* ---- router ---- */

  function parseRoute() {
    const hash = location.hash.slice(1) || "/";
    const parts = hash.split("/").filter(Boolean);
    if (parts.length === 0) return { view: "home" };
    if (parts[0] === "works" && parts[1]) return { view: "work-detail", id: decodeURIComponent(parts[1]) };
    if (["about", "statement", "works", "cv", "research", "contact"].includes(parts[0])) {
      return { view: parts[0] };
    }
    return { view: "home" };
  }

  function activeNavKey(route) {
    return route.view === "work-detail" ? "works" : route.view;
  }

  function render() {
    const route = parseRoute();

    document.querySelectorAll("[data-view]").forEach((el) => {
      el.hidden = el.dataset.view !== route.view;
    });
    document.querySelectorAll("[data-route]").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.route === activeNavKey(route));
    });

    const renderers = {
      home: renderHome,
      about: () => renderProse("about"),
      statement: () => renderProse("statement"),
      research: () => renderProse("research"),
      contact: renderContact,
      works: renderWorksGrid,
      "work-detail": () => renderWorkDetail(route.id),
      cv: renderCV,
    };
    (renderers[route.view] || renderHome)();

    document.querySelectorAll(".view-heading").forEach((h) => {
      const key = h.dataset.i18nHeading;
      if (key && PAGE_TITLES[key]) h.textContent = pick(PAGE_TITLES[key]);
    });

    const siteName = pick(siteData.about.siteName) || "SIJING";
    const pageTitle = PAGE_TITLES[route.view] ? pick(PAGE_TITLES[route.view]) : "";
    document.title = pageTitle ? `${pageTitle} · ${siteName}` : siteName;

    window.scrollTo(0, 0);
  }

  function renderHome() {
    const root = document.getElementById("home-content");
    const name = pick(siteData.about.siteName) || "SIJING";
    const tagline = pick(siteData.about.home) || "";
    const image = siteData.about.home && siteData.about.home.image;
    root.innerHTML = `
      ${image ? `<img class="hero-image" src="${escapeHtml(image)}" alt="" onerror="this.remove()">` : ""}
      <div class="hero-name">${escapeHtml(name)}</div>
      <div class="hero-tagline prose">${tagline}</div>
    `;
  }

  function renderProse(key) {
    const root = document.getElementById(`${key}-content`);
    root.innerHTML = pick(siteData.about[key]) || "";
  }

  function renderContact() {
    renderProse("contact");
    const c = siteData.about.contact || {};
    const links = document.getElementById("contact-links");
    const items = [];
    if (c.email) items.push(`<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
    if (c.instagram) items.push(`<a href="${escapeHtml(c.instagram)}" target="_blank" rel="noopener">Instagram</a>`);
    if (c.other) items.push(`<a href="${escapeHtml(c.other)}" target="_blank" rel="noopener">${escapeHtml(c.other)}</a>`);
    links.innerHTML = items.join("");
  }

  function renderWorksGrid() {
    const root = document.getElementById("works-list");
    const visible = siteData.works.filter((w) => w.published !== false);
    if (!visible.length) {
      root.innerHTML = `<div class="empty-state prose"><p>${pick(EMPTY_WORKS)}<br>${pick(EMPTY_WORKS_HINT)}</p></div>`;
      return;
    }
    const groups = groupByYear([...visible].reverse(), (w) => w.year);
    root.innerHTML = groups
      .map(
        ([year, items]) => `
      <div class="works-year-group">
        <div class="works-year-heading">
          <span class="year-num">${escapeHtml(year)}</span>
          <div class="horizon-rule horizon-rule--tight"></div>
        </div>
        <div class="works-grid">
          ${items
            .map(
              (w) => `
            <a class="work-card" href="#/works/${encodeURIComponent(w.id)}">
              <div class="work-card-frame">
                <img src="${escapeHtml(w.image || "")}" alt="${escapeHtml(pick(w.title))}" loading="lazy">
                ${w.sold ? `<span class="work-card-sold mono">${pick(STATUS_SOLD)}</span>` : ""}
              </div>
              <div class="work-card-caption">
                <span class="title">${escapeHtml(pick(w.title))}</span>
                <span class="year mono">${escapeHtml(w.year || "")}</span>
              </div>
            </a>
          `
            )
            .join("")}
        </div>
      </div>
    `
      )
      .join("");
  }

  function renderWorkDetail(id) {
    const root = document.getElementById("work-detail-content");
    const work = siteData.works.find((w) => w.id === id);
    if (!work) {
      root.innerHTML = `<a href="#/works" class="work-detail-back mono">${pick(BACK_LABEL)}</a><p class="prose">${pick(NOT_FOUND)}</p>`;
      return;
    }
    const title = pick(work.title);
    const desc = pick(work.description);
    const descHtml = desc
      ? desc
          .split(/\n+/)
          .filter(Boolean)
          .map((p) => `<p>${escapeHtml(p)}</p>`)
          .join("")
      : "";
    root.innerHTML = `
      <a href="#/works" class="work-detail-back mono">${pick(BACK_LABEL)}</a>
      <div class="work-detail">
        <div class="work-detail-image">
          <img src="${escapeHtml(work.image || "")}" alt="${escapeHtml(title)}">
        </div>
        <div>
          ${work.sold ? `<span class="work-detail-status mono">${pick(STATUS_SOLD)}</span>` : ""}
          <h1 class="work-detail-title">${escapeHtml(title)}</h1>
          <div class="work-detail-meta">
            <div class="row"><span class="label mono">${pick(META_LABELS.year)}</span><span>${escapeHtml(work.year || "")}</span></div>
            <div class="row"><span class="label mono">${pick(META_LABELS.size)}</span><span>${escapeHtml(work.size || "")}</span></div>
            <div class="row"><span class="label mono">${pick(META_LABELS.material)}</span><span>${escapeHtml(work.material || "")}</span></div>
          </div>
          <div class="prose">${descHtml}</div>
        </div>
      </div>
    `;
  }

  function renderCV() {
    const root = document.getElementById("cv-list");
    const list = (siteData.cv.exhibitions || []).filter((e) => e.published !== false);
    if (!list.length) {
      root.innerHTML = `<div class="empty-state prose"><p>${pick(EMPTY_CV)}</p></div>`;
      return;
    }
    const groups = groupByYear([...list].reverse(), (e) => e.year);
    root.innerHTML = groups
      .map(
        ([year, items]) => `
      <div class="cv-year-group">
        <span class="year-num mono">${escapeHtml(year)}</span>
        ${items
          .map((e) => {
            const cat = e.category && window.SIJING_CATEGORY_LABELS[e.category];
            return `
            <div class="cv-entry">
              <div>
                <div class="title">${escapeHtml(pick(e.title))}</div>
                ${pick(e.location) ? `<div class="location">${escapeHtml(pick(e.location))}</div>` : ""}
              </div>
              <span class="category mono">${cat ? pick(cat) : ""}</span>
            </div>
          `;
          })
          .join("")}
      </div>
    `
      )
      .join("");
  }

  /* ---- language ---- */

  function setLang(lang) {
    if (!LANGS.includes(lang)) return;
    currentLang = lang;
    localStorage.setItem("sijing_lang", lang);
    document.documentElement.setAttribute("data-lang", lang);
    document.documentElement.setAttribute("lang", lang === "zh" ? "zh-CN" : lang === "jp" ? "ja" : "en");
    document.body.setAttribute("data-lang", lang);
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.langBtn === lang);
    });
    render();
  }

  /* ---- chrome: header scroll state + mobile nav ---- */

  function initChrome() {
    const header = document.querySelector(".site-header");
    window.addEventListener(
      "scroll",
      () => header && header.classList.toggle("is-scrolled", window.scrollY > 8),
      { passive: true }
    );

    const toggle = document.querySelector(".nav-toggle");
    const nav = document.querySelector(".site-nav");
    if (toggle && nav) {
      toggle.addEventListener("click", () => nav.classList.toggle("is-open"));
      nav.querySelectorAll("a").forEach((a) =>
        a.addEventListener("click", () => nav.classList.remove("is-open"))
      );
    }

    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      btn.addEventListener("click", () => setLang(btn.dataset.langBtn));
    });
  }

  /* ---- signature: ambient horizon field ----
     A slow drifting light — cool aqua and dusty rose — behind every page.
     One deliberate animated moment rather than scattered micro-motion. */

  function initHorizonField() {
    const canvas = document.getElementById("horizon-field");
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let w = 0,
      h = 0;
    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    window.addEventListener("resize", resize);
    resize();

    let mx = 0.5,
      my = 0.4;
    window.addEventListener(
      "pointermove",
      (e) => {
        mx = e.clientX / window.innerWidth;
        my = e.clientY / window.innerHeight;
      },
      { passive: true }
    );

    const cs = getComputedStyle(document.documentElement);
    const lightRgb = cs.getPropertyValue("--light-rgb").trim() || "143,212,222";
    const warmthRgb = cs.getPropertyValue("--warmth-rgb").trim() || "161,93,117";

    const blobs = [
      { rgb: lightRgb, baseX: 0.3, baseY: 0.36, r: 0.55, amp: 0.07, speed: 1, phase: 0, alpha: 0.32 },
      { rgb: warmthRgb, baseX: 0.7, baseY: 0.62, r: 0.4, amp: 0.05, speed: 0.7, phase: 2.1, alpha: 0.16 },
    ];

    function frame(t) {
      ctx.clearRect(0, 0, w, h);
      const drift = reduced ? 0 : t * 0.00003;
      blobs.forEach((b) => {
        const ang = drift * b.speed + b.phase;
        const cx = (b.baseX + Math.sin(ang) * b.amp + (mx - 0.5) * 0.015) * w;
        const cy = (b.baseY + Math.cos(ang * 0.8) * b.amp + (my - 0.5) * 0.015) * h;
        const r = b.r * Math.max(w, h);
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, `rgba(${b.rgb},${b.alpha})`);
        grad.addColorStop(1, `rgba(${b.rgb},0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
      });
      if (!reduced) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    if (reduced) frame(0);
  }

  /* ---- boot ---- */

  document.addEventListener("DOMContentLoaded", async () => {
    document.documentElement.setAttribute("data-lang", currentLang);
    document.body.setAttribute("data-lang", currentLang);
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.langBtn === currentLang);
    });

    initChrome();
    initHorizonField();
    await loadData();
    render();
  });

  window.addEventListener("hashchange", render);
})();
