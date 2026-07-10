/* ==========================================================================
   SIJING — admin panel
   Writes directly to the GitHub repo via the Contents API (browser → GitHub,
   CORS-enabled, no server involved). Everything here only ever touches the
   JSON + image files under /data, /works and /assets — never index.html.
   ========================================================================== */

(() => {
  "use strict";

  const GH_API = "https://api.github.com";
  const CONFIG_KEY = "sijing_github_config";

  const CATEGORY_LABELS = {
    solo: "个展",
    group: "群展",
    award: "获奖",
    collection: "收藏",
    other: "其他",
  };

  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    works: [],
    cv: [],
    about: {},
    project: null,
    worksLoaded: false,
    cvLoaded: false,
    pagesLoaded: false,
    projectLoaded: false,
  };
  let currentProcessVideos = [];

  /* ---- small utilities ---- */

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function slugify(str) {
    return (str || "")
      .toString()
      .toLowerCase()
      .trim()
      .replace(/[^\x00-\x7F]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "");
  }

  function makeId(seed) {
    const base = slugify(seed) || "work";
    return `${base}-${Date.now().toString(36)}`;
  }

  let toastTimer;
  function toast(msg, kind) {
    const el = qs("#toast");
    if (!el) return;
    el.textContent = msg;
    el.dataset.kind = kind || "ok";
    el.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), kind === "error" ? 6000 : 3200);
  }

  function setBusy(busy, btnId) {
    if (!btnId) return;
    const btn = qs("#" + btnId);
    if (!btn) return;
    if (busy && !btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = busy;
    btn.textContent = busy ? "保存中…" : btn.dataset.label;
  }

  /* ---- generic tri-lingual field read/write ----
     Plain fields use data-field="prefix.lang"; rich text blocks use
     data-rte="prefix.lang". Same convention drives works, CV and pages. */

  function readTriple(prefix) {
    return {
      zh: (qs(`[data-field="${prefix}.zh"]`) || {}).value || "",
      jp: (qs(`[data-field="${prefix}.jp"]`) || {}).value || "",
      en: (qs(`[data-field="${prefix}.en"]`) || {}).value || "",
    };
  }
  function writeTriple(prefix, obj) {
    ["zh", "jp", "en"].forEach((l) => {
      const el = qs(`[data-field="${prefix}.${l}"]`);
      if (el) el.value = (obj && obj[l]) || "";
    });
  }
  function readTripleRTE(prefix) {
    return {
      zh: (qs(`[data-rte="${prefix}.zh"]`) || {}).innerHTML || "",
      jp: (qs(`[data-rte="${prefix}.jp"]`) || {}).innerHTML || "",
      en: (qs(`[data-rte="${prefix}.en"]`) || {}).innerHTML || "",
    };
  }
  function writeTripleRTE(prefix, obj) {
    ["zh", "jp", "en"].forEach((l) => {
      const el = qs(`[data-rte="${prefix}.${l}"]`);
      if (el) el.innerHTML = (obj && obj[l]) || "";
    });
  }

  /* ---- GitHub config ---- */

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
    } catch (_) {
      return null;
    }
  }
  function setConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }
  function clearConfig() {
    localStorage.removeItem(CONFIG_KEY);
  }

  function ghHeaders(token) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function friendlyGhError(status, raw) {
    if (status === 401) return "令牌无效或已过期，请到「设置」重新生成并粘贴。";
    if (status === 403) return "权限不足或触发速率限制，请检查令牌是否已授予该仓库 Contents 读写权限。";
    if (status === 404) return "找不到仓库，请检查「设置」里的用户名 / 仓库名是否正确，以及令牌是否有权访问。";
    if (status === 409) return "保存冲突（可能有其他改动）。请刷新列表后重试。";
    if (status === 422) return "文件过大或内容有误：" + raw;
    return raw || `请求失败（${status}）`;
  }

  /* ---- UTF-8 safe base64 (for JSON text) ---- */

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary);
  }
  function base64ToUtf8(b64) {
    const binary = atob((b64 || "").replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---- GitHub Contents API ---- */

  async function ghGetFile(path) {
    const cfg = getConfig();
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) throw new Error('请先在「设置」中配置并保存 GitHub 信息');
    const res = await fetch(
      `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch || "main")}`,
      { headers: ghHeaders(cfg.token) }
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch (_) {}
      throw new Error(friendlyGhError(res.status, msg));
    }
    const data = await res.json();
    return { content: base64ToUtf8(data.content), sha: data.sha };
  }

  /* returns the sha of an existing file, or null if it doesn't exist —
     required by GitHub when overwriting (e.g. replacing a work's image) */
  async function ghGetSha(path) {
    const cfg = getConfig();
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) return null;
    const res = await fetch(
      `${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch || "main")}`,
      { headers: { ...ghHeaders(cfg.token), Accept: "application/vnd.github.object+json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.sha || null;
  }

  async function ghPutFile(path, content, message, sha, isRawBase64) {
    const cfg = getConfig();
    if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) throw new Error('请先在「设置」中配置并保存 GitHub 信息');
    const body = {
      message,
      content: isRawBase64 ? content : utf8ToBase64(content),
      branch: cfg.branch || "main",
    };
    if (sha) body.sha = sha;
    const res = await fetch(`${GH_API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
      method: "PUT",
      headers: { ...ghHeaders(cfg.token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.message) msg = j.message;
      } catch (_) {}
      throw new Error(friendlyGhError(res.status, msg));
    }
    return res.json();
  }

  async function testConnection() {
    const statusEl = qs("#admin-status");
    if (!statusEl) return;
    statusEl.textContent = "连接中…";
    statusEl.dataset.state = "unset";
    try {
      const cfg = getConfig();
      if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) throw new Error("请先填写用户名、仓库名与令牌");
      const res = await fetch(`${GH_API}/repos/${cfg.owner}/${cfg.repo}`, { headers: ghHeaders(cfg.token) });
      if (!res.ok) throw new Error(friendlyGhError(res.status, `HTTP ${res.status}`));
      const repo = await res.json();
      statusEl.textContent = `已连接 → ${repo.full_name}（${repo.default_branch}）`;
      statusEl.dataset.state = "ok";
    } catch (err) {
      statusEl.textContent = "未连接：" + err.message;
      statusEl.dataset.state = "error";
    }
  }

  /* ---- image: resize + compress on-device before it ever leaves the browser ---- */

  function fileToResizedBase64(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取图片失败"));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error("图片解码失败，请换一张图片"));
        img.onload = () => {
          let { width, height } = img;
          if (width > height && width > maxDim) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else if (height > maxDim) {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve({ base64: dataUrl.split(",")[1], dataUrl });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function wireImageDrop(dropId, inputId, previewId) {
    const drop = qs("#" + dropId),
      input = qs("#" + inputId),
      preview = qs("#" + previewId);
    if (!drop || !input || !preview) return;
    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const f = input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        preview.src = e.target.result;
        preview.hidden = false;
      };
      reader.readAsDataURL(f);
    });
  }

  /* ---- generic multi-image gallery manager (reused by: creative process,
     About/Statement/CV/Research/Contact page images, long-term project) ---- */

  function makeGalleryManager(dropId, inputId, listId) {
    let images = [];

    function render() {
      const listEl = qs("#" + listId);
      if (!listEl) return;
      if (!images.length) {
        listEl.innerHTML = '<p class="field-hint">还没有图片。</p>';
        return;
      }
      listEl.innerHTML = images
        .map(
          (src, i) => `
        <div class="entry-row">
          <img src="../${escapeHtml(src)}" alt="" onerror="this.style.visibility='hidden'">
          <div class="info"><div class="t">图 ${i + 1}</div></div>
          <div class="actions">
            <button type="button" data-del="${i}">删除</button>
          </div>
        </div>`
        )
        .join("");
      qsa("[data-del]", listEl).forEach((b) =>
        b.addEventListener("click", () => {
          images.splice(Number(b.dataset.del), 1);
          render();
        })
      );
    }

    function wire() {
      const drop = qs("#" + dropId),
        input = qs("#" + inputId);
      if (!drop || !input) return;
      drop.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        for (const file of files) {
          try {
            toast("正在压缩并上传图片…");
            const { base64 } = await fileToResizedBase64(file, 1800, 0.82);
            const path = `works/gallery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
            await ghPutFile(path, base64, `配图: ${path}`, null, true);
            images.push(path);
            render();
          } catch (err) {
            toast("上传失败：" + err.message, "error");
          }
        }
        input.value = "";
      });
    }

    return {
      get: () => images,
      set: (arr) => {
        images = Array.isArray(arr) ? arr.filter(Boolean) : [];
        render();
      },
      wire,
      render,
    };
  }

  function makeCaptionedGalleryManager(dropId, inputId, listId) {
    let images = []; // [{ src, caption: { zh, jp, en } }]

    function render() {
      const listEl = qs("#" + listId);
      if (!listEl) return;
      if (!images.length) {
        listEl.innerHTML = '<p class="field-hint">还没有图片。</p>';
        return;
      }
      listEl.innerHTML = images
        .map(
          (it, i) => `
        <div class="captioned-item">
          <div class="captioned-item-top">
            <img src="../${escapeHtml(it.src)}" alt="" onerror="this.style.visibility='hidden'">
            <button type="button" data-del-captioned="${i}">删除</button>
          </div>
          <div class="caption-inputs">
            <input type="text" data-cap-zh="${i}" placeholder="中文说明（可留空）" value="${escapeHtml((it.caption && it.caption.zh) || "")}">
            <input type="text" data-cap-jp="${i}" placeholder="日本語の説明" value="${escapeHtml((it.caption && it.caption.jp) || "")}">
            <input type="text" data-cap-en="${i}" placeholder="English caption" value="${escapeHtml((it.caption && it.caption.en) || "")}">
          </div>
        </div>`
        )
        .join("");
      qsa("[data-del-captioned]", listEl).forEach((b) =>
        b.addEventListener("click", () => {
          images.splice(Number(b.dataset.delCaptioned), 1);
          render();
        })
      );
      qsa("[data-cap-zh]", listEl).forEach((el) =>
        el.addEventListener("input", () => {
          const i = Number(el.dataset.capZh);
          images[i].caption = images[i].caption || { zh: "", jp: "", en: "" };
          images[i].caption.zh = el.value;
        })
      );
      qsa("[data-cap-jp]", listEl).forEach((el) =>
        el.addEventListener("input", () => {
          const i = Number(el.dataset.capJp);
          images[i].caption = images[i].caption || { zh: "", jp: "", en: "" };
          images[i].caption.jp = el.value;
        })
      );
      qsa("[data-cap-en]", listEl).forEach((el) =>
        el.addEventListener("input", () => {
          const i = Number(el.dataset.capEn);
          images[i].caption = images[i].caption || { zh: "", jp: "", en: "" };
          images[i].caption.en = el.value;
        })
      );
    }

    function wire() {
      const drop = qs("#" + dropId),
        input = qs("#" + inputId);
      if (!drop || !input) return;
      drop.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        for (const file of files) {
          try {
            toast("正在压缩并上传图片…");
            const { base64 } = await fileToResizedBase64(file, 1800, 0.82);
            const path = `works/gallery-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
            await ghPutFile(path, base64, `配图: ${path}`, null, true);
            images.push({ src: path, caption: { zh: "", jp: "", en: "" } });
            render();
          } catch (err) {
            toast("上传失败：" + err.message, "error");
          }
        }
        input.value = "";
      });
    }

    return {
      get: () => images.filter((it) => it && it.src),
      set: (arr) => {
        images = Array.isArray(arr)
          ? arr
              .filter((it) => it && it.src)
              .map((it) => ({
                src: it.src,
                caption: { zh: (it.caption && it.caption.zh) || "", jp: (it.caption && it.caption.jp) || "", en: (it.caption && it.caption.en) || "" },
              }))
          : [];
        render();
      },
      wire,
      render,
    };
  }

  const processGallery = makeCaptionedGalleryManager("process-image-drop", "process-image-input", "process-image-list");
  const exhibitionGallery = makeCaptionedGalleryManager(
    "process-exhibition-image-drop",
    "process-exhibition-image-input",
    "process-exhibition-image-list"
  );
  const aboutGallery = makeGalleryManager("about-image-drop", "about-image-input", "about-image-list");
  const statementGallery = makeGalleryManager("statement-image-drop", "statement-image-input", "statement-image-list");
  const researchGallery = makeGalleryManager("research-image-drop", "research-image-input", "research-image-list");
  const contactGallery = makeGalleryManager("contact-image-drop", "contact-image-input", "contact-image-list");
  const cvGallery = makeGalleryManager("cv-image-drop", "cv-image-input", "cv-image-list");
  const projectIntroGallery = makeGalleryManager("project-image-drop", "project-image-input", "project-image-list");
  const projectEntryGallery = makeGalleryManager("project-entry-image-drop", "project-entry-image-input", "project-entry-image-list");

  /* ---- creative process: videos (raw upload, no resize) ---- */

  function fileToBase64Raw(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("读取视频失败"));
      reader.onload = (e) => resolve(e.target.result.split(",")[1]);
      reader.readAsDataURL(file);
    });
  }

  function renderProcessVideoList() {
    const listEl = qs("#process-video-list");
    if (!listEl) return;
    if (!currentProcessVideos.length) {
      listEl.innerHTML = '<p class="field-hint">还没有创作过程视频。</p>';
      return;
    }
    listEl.innerHTML = currentProcessVideos
      .map((v, i) => {
        const label = v.type === "upload" ? `视频文件：${(v.src || "").split("/").pop()}` : `链接：${v.url || ""}`;
        return `
        <div class="entry-row">
          <div class="info"><div class="t">${escapeHtml(label)}</div></div>
          <div class="actions">
            <button type="button" data-del-process-video="${i}">删除</button>
          </div>
        </div>`;
      })
      .join("");
    qsa("[data-del-process-video]", listEl).forEach((b) =>
      b.addEventListener("click", () => {
        currentProcessVideos.splice(Number(b.dataset.delProcessVideo), 1);
        renderProcessVideoList();
      })
    );
  }

  function wireProcessVideoUpload() {
    const drop = qs("#process-video-drop"),
      input = qs("#process-video-input"),
      urlInput = qs("#process-video-url-input"),
      addLinkBtn = qs("#process-video-add-link-btn");
    if (drop && input) {
      drop.addEventListener("click", () => input.click());
      input.addEventListener("change", async () => {
        const files = Array.from(input.files || []);
        if (!files.length) return;
        const MAX_BYTES = 50 * 1024 * 1024;
        for (const file of files) {
          if (file.size > MAX_BYTES) {
            toast(`「${file.name}」超过 50MB，建议压缩后再上传，或改用视频链接。`, "error");
            continue;
          }
          try {
            toast(`正在上传视频…（${file.name}，可能需要一些时间）`);
            const base64 = await fileToBase64Raw(file);
            const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
            const path = `works/process-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
            await ghPutFile(path, base64, `创作过程视频: ${path}`, null, true);
            currentProcessVideos.push({ type: "upload", src: path });
            renderProcessVideoList();
            toast("视频上传成功。");
          } catch (err) {
            toast("视频上传失败：" + err.message, "error");
          }
        }
        input.value = "";
      });
    }
    if (addLinkBtn && urlInput) {
      addLinkBtn.addEventListener("click", () => {
        const url = urlInput.value.trim();
        if (!url) return;
        currentProcessVideos.push({ type: "embed", url });
        urlInput.value = "";
        renderProcessVideoList();
      });
    }
  }

  /* ---- tabs (generic, handles nested groups: main / page-selector / lang) ---- */

  function wireTabGroup(groupEl) {
    const tabs = qsa("[data-tab-target]", groupEl).filter((t) => t.closest("[data-tab-group]") === groupEl);
    const panels = qsa("[data-tab-panel]", groupEl).filter((p) => p.closest("[data-tab-group]") === groupEl);
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const key = tab.dataset.tabTarget;
        tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
        panels.forEach((p) => (p.hidden = p.dataset.tabPanel !== key));
        groupEl.dispatchEvent(new CustomEvent("tabchange", { detail: { key } }));
      });
    });
  }

  function wireRTEToolbars() {
    qsa(".rte-toolbar").forEach((toolbar) => {
      const editor = toolbar.nextElementSibling;
      if (!editor || !editor.classList.contains("rte-editor")) return;
      qsa("button", toolbar).forEach((btn) => {
        btn.addEventListener("click", () => {
          editor.focus();
          document.execCommand(btn.dataset.cmd, false, btn.dataset.val || null);
        });
      });
    });
  }

  /* ==========================================================================
     Works
     ========================================================================== */

  function configIncomplete() {
    const cfg = getConfig();
    return !cfg || !cfg.owner || !cfg.repo || !cfg.token;
  }
  const FIRST_RUN_HINT = '<p class="field-hint">尚未连接 GitHub —— 请先到「设置」标签页完成配置。</p>';

  async function loadWorksList() {
    const listEl = qs("#works-entry-list");
    if (!listEl) return;
    if (configIncomplete()) {
      listEl.innerHTML = FIRST_RUN_HINT;
      return;
    }
    listEl.innerHTML = '<p class="field-hint">加载中…</p>';
    try {
      const file = await ghGetFile("data/works.json");
      state.works = file ? JSON.parse(file.content) : [];
      state.worksLoaded = true;
      renderWorksListOnly();
    } catch (err) {
      listEl.innerHTML = `<p class="field-hint">读取失败：${escapeHtml(err.message)}</p>`;
    }
  }

  async function moveWork(id, direction) {
    try {
      const remote = await ghGetFile("data/works.json");
      const works = remote ? JSON.parse(remote.content) : [];
      const idx = works.findIndex((w) => w.id === id);
      const target = idx + direction;
      if (idx === -1 || target < 0 || target >= works.length) return;
      [works[idx], works[target]] = [works[target], works[idx]];
      await ghPutFile("data/works.json", JSON.stringify(works, null, 2), `调整作品顺序: ${id}`, remote ? remote.sha : null, false);
      state.works = works;
      renderWorksListOnly();
      toast("顺序已调整，网站将在数分钟内自动更新。");
    } catch (err) {
      toast("调整顺序失败：" + err.message, "error");
    }
  }

  function renderWorksListOnly() {
    const listEl = qs("#works-entry-list");
    if (!listEl) return;
    if (!state.works.length) {
      listEl.innerHTML = '<p class="field-hint">还没有作品，填写上方表单新增第一件。</p>';
      return;
    }
    listEl.innerHTML = state.works
      .map((w, idx) => {
        const t = (w.title && (w.title.zh || w.title.en || w.title.jp)) || "（未命名）";
        const tag = w.published === false ? "草稿" : "公开";
        const seriesName = (w.series && (w.series.zh || w.series.en || w.series.jp)) || "";
        return `
        <div class="entry-row">
          <img src="../${escapeHtml(w.image || "")}" alt="" onerror="this.style.visibility='hidden'">
          <div class="info">
            <div class="t">${escapeHtml(t)}</div>
            <div class="m">${escapeHtml(w.year || "")}${seriesName ? " · " + escapeHtml(seriesName) : ""} · ${tag}${w.sold ? " · 已售" : ""}</div>
          </div>
          <div class="actions">
            <button type="button" data-move-work-up="${escapeHtml(w.id)}" ${idx === 0 ? "disabled" : ""}>↑</button>
            <button type="button" data-move-work-down="${escapeHtml(w.id)}" ${idx === state.works.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" data-edit-work="${escapeHtml(w.id)}">编辑</button>
            <button type="button" data-del-work="${escapeHtml(w.id)}">删除</button>
          </div>
        </div>`;
      })
      .join("");
    qsa("[data-edit-work]", listEl).forEach((b) => b.addEventListener("click", () => editWork(b.dataset.editWork)));
    qsa("[data-del-work]", listEl).forEach((b) => b.addEventListener("click", () => deleteWork(b.dataset.delWork)));
    qsa("[data-move-work-up]", listEl).forEach((b) => b.addEventListener("click", () => moveWork(b.dataset.moveWorkUp, -1)));
    qsa("[data-move-work-down]", listEl).forEach((b) => b.addEventListener("click", () => moveWork(b.dataset.moveWorkDown, 1)));
  }

  function resetWorkForm() {
    qs("#work-form").reset();
    qs("#work-editing-id").value = "";
    qs("#work-image-path").value = "";
    qs("#work-image-preview").hidden = true;
    qs("#work-form-title").textContent = "新增作品";
    qs("#work-cancel-edit").hidden = true;
    qs('input[name="work-sold"][value="false"]').checked = true;
    qs('input[name="work-published"][value="true"]').checked = true;
    writeTriple("work-process-desc", {});
    processGallery.set([]);
    exhibitionGallery.set([]);
    currentProcessVideos = [];
    renderProcessVideoList();
  }

  function editWork(id) {
    const w = state.works.find((x) => x.id === id);
    if (!w) return;
    qs("#work-editing-id").value = w.id;
    writeTriple("work-title", w.title);
    writeTriple("work-series", w.series);
    qs("#work-year").value = w.year || "";
    qs("#work-size").value = w.size || "";
    qs("#work-material").value = w.material || "";
    writeTriple("work-desc", w.description);
    (qs(`input[name="work-sold"][value="${w.sold ? "true" : "false"}"]`) || {}).checked = true;
    (qs(`input[name="work-published"][value="${w.published === false ? "false" : "true"}"]`) || {}).checked = true;
    qs("#work-image-path").value = w.image || "";
    const preview = qs("#work-image-preview");
    if (w.image) {
      preview.src = "../" + w.image;
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
    qs("#work-image-input").value = "";
    writeTriple("work-process-desc", w.process && w.process.description);
    processGallery.set(w.process && Array.isArray(w.process.images) ? w.process.images : []);
    exhibitionGallery.set(w.process && Array.isArray(w.process.exhibitionImages) ? w.process.exhibitionImages : []);
    currentProcessVideos = (w.process && Array.isArray(w.process.videos) ? [...w.process.videos] : []).filter(
      (v) => v && (v.src || v.url)
    );
    renderProcessVideoList();
    qs("#work-form-title").textContent = "编辑作品";
    qs("#work-cancel-edit").hidden = false;
    qs("#work-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteWork(id) {
    if (!confirm("确定删除这件作品吗？\n（已上传的图片文件不会被删除，只会从作品列表移除）")) return;
    try {
      const remote = await ghGetFile("data/works.json");
      const works = remote ? JSON.parse(remote.content) : [];
      const next = works.filter((w) => w.id !== id);
      await ghPutFile("data/works.json", JSON.stringify(next, null, 2), `删除作品: ${id}`, remote ? remote.sha : null, false);
      toast("已删除。");
      loadWorksList();
    } catch (err) {
      toast("删除失败：" + err.message, "error");
    }
  }

  async function saveWork(e) {
    e.preventDefault();
    setBusy(true, "work-save-btn");
    try {
      const editingId = qs("#work-editing-id").value;
      const title = readTriple("work-title");
      if (!title.zh && !title.jp && !title.en) throw new Error("请至少填写一种语言的标题");

      const remote = await ghGetFile("data/works.json");
      const works = remote ? JSON.parse(remote.content) : [];

      const id = editingId || makeId(title.en || title.zh || title.jp);
      let imagePath = qs("#work-image-path").value;
      const file = qs("#work-image-input").files[0];
      if (file) {
        toast("正在压缩并上传图片…");
        const { base64 } = await fileToResizedBase64(file, 2000, 0.85);
        const basePath = `works/${id}.jpg`;
        const imgSha = await ghGetSha(basePath);
        await ghPutFile(basePath, base64, `作品图片: ${id}`, imgSha, true);
        imagePath = basePath + "?v=" + Date.now();
      }

      const workObj = {
        id,
        title,
        series: readTriple("work-series"),
        year: qs("#work-year").value.trim(),
        size: qs("#work-size").value.trim(),
        material: qs("#work-material").value.trim(),
        description: readTriple("work-desc"),
        sold: qs('input[name="work-sold"]:checked').value === "true",
        published: qs('input[name="work-published"]:checked').value === "true",
        image: imagePath,
        process: {
          description: readTriple("work-process-desc"),
          images: processGallery.get(),
          exhibitionImages: exhibitionGallery.get(),
          videos: currentProcessVideos.filter((v) => v && (v.src || v.url)),
        },
      };

      const idx = works.findIndex((w) => w.id === editingId);
      if (idx > -1) works[idx] = workObj;
      else works.push(workObj);

      await ghPutFile(
        "data/works.json",
        JSON.stringify(works, null, 2),
        `${idx > -1 ? "更新" : "新增"}作品: ${title.zh || title.en || title.jp}`,
        remote ? remote.sha : null,
        false
      );

      toast("已保存，网站将在数分钟内自动更新。");
      resetWorkForm();
      loadWorksList();
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      setBusy(false, "work-save-btn");
    }
  }

  /* ==========================================================================
     CV
     ========================================================================== */

  async function loadCvList() {
    const listEl = qs("#cv-entry-list");
    if (!listEl) return;
    if (configIncomplete()) {
      listEl.innerHTML = FIRST_RUN_HINT;
      return;
    }
    listEl.innerHTML = '<p class="field-hint">加载中…</p>';
    try {
      const file = await ghGetFile("data/cv.json");
      const data = file ? JSON.parse(file.content) : { exhibitions: [] };
      state.cv = data.exhibitions || [];
      state.cvLoaded = true;
      cvGallery.set(data.images);
      if (!state.cv.length) {
        listEl.innerHTML = '<p class="field-hint">还没有履历记录，填写上方表单新增第一条。</p>';
        return;
      }
      listEl.innerHTML = state.cv
        .map((c) => {
          const t = (c.title && (c.title.zh || c.title.en || c.title.jp)) || "（未命名）";
          const tag = c.published === false ? "草稿" : "公开";
          return `
          <div class="entry-row">
            <div class="info">
              <div class="t">${escapeHtml(t)}</div>
              <div class="m">${escapeHtml(c.year || "")} · ${escapeHtml(CATEGORY_LABELS[c.category] || "")} · ${tag}</div>
            </div>
            <div class="actions">
              <button type="button" data-edit-cv="${escapeHtml(c.id)}">编辑</button>
              <button type="button" data-del-cv="${escapeHtml(c.id)}">删除</button>
            </div>
          </div>`;
        })
        .join("");
      qsa("[data-edit-cv]", listEl).forEach((b) => b.addEventListener("click", () => editCv(b.dataset.editCv)));
      qsa("[data-del-cv]", listEl).forEach((b) => b.addEventListener("click", () => deleteCv(b.dataset.delCv)));
    } catch (err) {
      listEl.innerHTML = `<p class="field-hint">读取失败：${escapeHtml(err.message)}</p>`;
    }
  }

  async function saveCvImages() {
    setBusy(true, "save-cv-images-btn");
    try {
      const remote = await ghGetFile("data/cv.json");
      const data = remote ? JSON.parse(remote.content) : { exhibitions: [] };
      data.images = cvGallery.get();
      await ghPutFile("data/cv.json", JSON.stringify(data, null, 2), "更新履历页面配图", remote ? remote.sha : null, false);
      toast("配图已保存，网站将在数分钟内自动更新。");
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      setBusy(false, "save-cv-images-btn");
    }
  }

  function resetCvForm() {
    qs("#cv-form").reset();
    qs("#cv-editing-id").value = "";
    qs("#cv-form-title").textContent = "新增履历";
    qs("#cv-cancel-edit").hidden = true;
    qs('input[name="cv-published"][value="true"]').checked = true;
  }

  function editCv(id) {
    const c = state.cv.find((x) => x.id === id);
    if (!c) return;
    qs("#cv-editing-id").value = c.id;
    writeTriple("cv-title", c.title);
    writeTriple("cv-location", c.location);
    qs("#cv-year").value = c.year || "";
    qs("#cv-category").value = c.category || "other";
    (qs(`input[name="cv-published"][value="${c.published === false ? "false" : "true"}"]`) || {}).checked = true;
    qs("#cv-form-title").textContent = "编辑履历";
    qs("#cv-cancel-edit").hidden = false;
    qs("#cv-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteCv(id) {
    if (!confirm("确定删除这条履历记录吗？")) return;
    try {
      const remote = await ghGetFile("data/cv.json");
      const data = remote ? JSON.parse(remote.content) : { exhibitions: [] };
      data.exhibitions = (data.exhibitions || []).filter((c) => c.id !== id);
      await ghPutFile("data/cv.json", JSON.stringify(data, null, 2), `删除履历: ${id}`, remote ? remote.sha : null, false);
      toast("已删除。");
      loadCvList();
    } catch (err) {
      toast("删除失败：" + err.message, "error");
    }
  }

  async function saveCv(e) {
    e.preventDefault();
    setBusy(true, "cv-save-btn");
    try {
      const editingId = qs("#cv-editing-id").value;
      const title = readTriple("cv-title");
      if (!title.zh && !title.jp && !title.en) throw new Error("请至少填写一种语言的展览名称");

      const remote = await ghGetFile("data/cv.json");
      const data = remote ? JSON.parse(remote.content) : { exhibitions: [] };
      const list = data.exhibitions || [];

      const id = editingId || makeId(title.en || title.zh || title.jp);
      const cvObj = {
        id,
        title,
        location: readTriple("cv-location"),
        year: qs("#cv-year").value.trim(),
        category: qs("#cv-category").value,
        published: qs('input[name="cv-published"]:checked').value === "true",
      };

      const idx = list.findIndex((c) => c.id === editingId);
      if (idx > -1) list[idx] = cvObj;
      else list.push(cvObj);
      data.exhibitions = list;

      await ghPutFile(
        "data/cv.json",
        JSON.stringify(data, null, 2),
        `${idx > -1 ? "更新" : "新增"}履历: ${title.zh || title.en || title.jp}`,
        remote ? remote.sha : null,
        false
      );

      toast("已保存，网站将在数分钟内自动更新。");
      resetCvForm();
      loadCvList();
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      setBusy(false, "cv-save-btn");
    }
  }

  /* ==========================================================================
     Long-term project — intro + a manually-ordered feed of dated entries
     ========================================================================== */

  async function loadProjectData() {
    if (configIncomplete()) {
      const listEl = qs("#project-entry-list");
      if (listEl) listEl.innerHTML = FIRST_RUN_HINT;
      return;
    }
    try {
      const remote = await ghGetFile("data/project.json");
      const data = remote ? JSON.parse(remote.content) : { title: {}, description: {}, images: [], entries: [] };
      state.project = data;
      state.projectLoaded = true;

      writeTriple("project-title", data.title);
      writeTriple("project-desc", data.description);
      projectIntroGallery.set(data.images);
      renderProjectEntryList();
    } catch (err) {
      toast("长期项目数据读取失败：" + err.message, "error");
    }
  }

  async function saveProjectIntro() {
    setBusy(true, "save-project-intro-btn");
    try {
      const remote = await ghGetFile("data/project.json");
      const data = remote ? JSON.parse(remote.content) : { title: {}, description: {}, images: [], entries: [] };
      data.title = readTriple("project-title");
      data.description = readTriple("project-desc");
      data.images = projectIntroGallery.get();
      if (!Array.isArray(data.entries)) data.entries = [];
      await ghPutFile("data/project.json", JSON.stringify(data, null, 2), "更新长期项目介绍", remote ? remote.sha : null, false);
      state.project = data;
      toast("已保存，网站将在数分钟内自动更新。");
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      setBusy(false, "save-project-intro-btn");
    }
  }

  function renderProjectEntryList() {
    const listEl = qs("#project-entry-list");
    if (!listEl) return;
    if (configIncomplete()) {
      listEl.innerHTML = FIRST_RUN_HINT;
      return;
    }
    const entries = (state.project && Array.isArray(state.project.entries)) ? state.project.entries : [];
    if (!entries.length) {
      listEl.innerHTML = '<p class="field-hint">还没有更新记录，填写上方表单新增第一条。</p>';
      return;
    }
    listEl.innerHTML = entries
      .map((e, idx) => {
        const t = (e.title && (e.title.zh || e.title.en || e.title.jp)) || "（未命名）";
        const tag = e.published === false ? "草稿" : "公开";
        return `
        <div class="entry-row">
          <div class="info">
            <div class="t">${escapeHtml(t)}</div>
            <div class="m">${escapeHtml(e.date || "")} · ${tag}</div>
          </div>
          <div class="actions">
            <button type="button" data-move-project-up="${escapeHtml(e.id)}" ${idx === 0 ? "disabled" : ""}>↑</button>
            <button type="button" data-move-project-down="${escapeHtml(e.id)}" ${idx === entries.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" data-edit-project="${escapeHtml(e.id)}">编辑</button>
            <button type="button" data-del-project="${escapeHtml(e.id)}">删除</button>
          </div>
        </div>`;
      })
      .join("");
    qsa("[data-edit-project]", listEl).forEach((b) => b.addEventListener("click", () => editProjectEntry(b.dataset.editProject)));
    qsa("[data-del-project]", listEl).forEach((b) => b.addEventListener("click", () => deleteProjectEntry(b.dataset.delProject)));
    qsa("[data-move-project-up]", listEl).forEach((b) => b.addEventListener("click", () => moveProjectEntry(b.dataset.moveProjectUp, -1)));
    qsa("[data-move-project-down]", listEl).forEach((b) => b.addEventListener("click", () => moveProjectEntry(b.dataset.moveProjectDown, 1)));
  }

  function resetProjectEntryForm() {
    qs("#project-entry-form").reset();
    qs("#project-entry-editing-id").value = "";
    qs("#project-entry-date").value = "";
    qs("#project-entry-form-title").textContent = "新增更新";
    qs("#project-entry-cancel-edit").hidden = true;
    qs('input[name="project-entry-published"][value="true"]').checked = true;
    writeTriple("project-entry-title", {});
    writeTriple("project-entry-desc", {});
    projectEntryGallery.set([]);
  }

  function editProjectEntry(id) {
    const entries = (state.project && state.project.entries) || [];
    const e = entries.find((x) => x.id === id);
    if (!e) return;
    qs("#project-entry-editing-id").value = e.id;
    qs("#project-entry-date").value = e.date || "";
    writeTriple("project-entry-title", e.title);
    writeTriple("project-entry-desc", e.description);
    projectEntryGallery.set(Array.isArray(e.images) ? e.images : []);
    (qs(`input[name="project-entry-published"][value="${e.published === false ? "false" : "true"}"]`) || {}).checked = true;
    qs("#project-entry-form-title").textContent = "编辑更新";
    qs("#project-entry-cancel-edit").hidden = false;
    qs("#project-entry-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function deleteProjectEntry(id) {
    if (!confirm("确定删除这条更新记录吗？")) return;
    try {
      const remote = await ghGetFile("data/project.json");
      const data = remote ? JSON.parse(remote.content) : { title: {}, description: {}, images: [], entries: [] };
      data.entries = (data.entries || []).filter((e) => e.id !== id);
      await ghPutFile("data/project.json", JSON.stringify(data, null, 2), `删除长期项目更新: ${id}`, remote ? remote.sha : null, false);
      state.project = data;
      toast("已删除。");
      renderProjectEntryList();
    } catch (err) {
      toast("删除失败：" + err.message, "error");
    }
  }

  async function moveProjectEntry(id, direction) {
    try {
      const remote = await ghGetFile("data/project.json");
      const data = remote ? JSON.parse(remote.content) : { title: {}, description: {}, images: [], entries: [] };
      const entries = data.entries || [];
      const idx = entries.findIndex((e) => e.id === id);
      const target = idx + direction;
      if (idx === -1 || target < 0 || target >= entries.length) return;
      [entries[idx], entries[target]] = [entries[target], entries[idx]];
      data.entries = entries;
      await ghPutFile("data/project.json", JSON.stringify(data, null, 2), `调整长期项目更新顺序: ${id}`, remote ? remote.sha : null, false);
      state.project = data;
      renderProjectEntryList();
      toast("顺序已调整，网站将在数分钟内自动更新。");
    } catch (err) {
      toast("调整顺序失败：" + err.message, "error");
    }
  }

  async function saveProjectEntry(evt) {
    evt.preventDefault();
    setBusy(true, "project-entry-save-btn");
    try {
      const editingId = qs("#project-entry-editing-id").value;
      const title = readTriple("project-entry-title");
      const remote = await ghGetFile("data/project.json");
      const data = remote ? JSON.parse(remote.content) : { title: {}, description: {}, images: [], entries: [] };
      const entries = data.entries || [];

      const id = editingId || makeId(title.en || title.zh || title.jp || "update");
      const entryObj = {
        id,
        date: qs("#project-entry-date").value.trim(),
        title,
        description: readTriple("project-entry-desc"),
        images: projectEntryGallery.get(),
        published: qs('input[name="project-entry-published"]:checked').value === "true",
      };

      const idx = entries.findIndex((e) => e.id === editingId);
      if (idx > -1) entries[idx] = entryObj;
      else entries.push(entryObj);
      data.entries = entries;

      await ghPutFile(
        "data/project.json",
        JSON.stringify(data, null, 2),
        `${idx > -1 ? "更新" : "新增"}长期项目更新: ${title.zh || title.en || title.jp || id}`,
        remote ? remote.sha : null,
        false
      );

      state.project = data;
      toast("已保存，网站将在数分钟内自动更新。");
      resetProjectEntryForm();
      renderProjectEntryList();
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      setBusy(false, "project-entry-save-btn");
    }
  }

  /* ==========================================================================
     Pages (Home / About / Statement / Research / Contact)
     ========================================================================== */

  async function loadPagesData() {
    const statusEl = qs("#pages-load-status");
    if (configIncomplete()) {
      if (statusEl) statusEl.textContent = "尚未连接 GitHub —— 请先到「设置」标签页完成配置。";
      return;
    }
    try {
      const remote = await ghGetFile("data/about.json");
      const data = remote ? JSON.parse(remote.content) : {};
      state.about = data;
      state.pagesLoaded = true;

      writeTriple("siteName", data.siteName);
      writeTripleRTE("home", data.home);
      qs("#home-image-path").value = (data.home && data.home.image) || "";
      const heroPrev = qs("#home-image-preview");
      if (data.home && data.home.image) {
        heroPrev.src = "../" + data.home.image;
        heroPrev.hidden = false;
      } else {
        heroPrev.hidden = true;
      }

      writeTripleRTE("about", data.about);
      writeTripleRTE("statement", data.statement);
      writeTripleRTE("research", data.research);
      writeTripleRTE("contact", data.contact);
      qs("#contact-email").value = (data.contact && data.contact.email) || "";
      qs("#contact-instagram").value = (data.contact && data.contact.instagram) || "";
      qs("#contact-other").value = (data.contact && data.contact.other) || "";
      aboutGallery.set(data.about && data.about.images);
      statementGallery.set(data.statement && data.statement.images);
      researchGallery.set(data.research && data.research.images);
      contactGallery.set(data.contact && data.contact.images);

      if (statusEl) statusEl.textContent = "已载入当前网站内容。";
    } catch (err) {
      if (statusEl) statusEl.textContent = "载入失败：" + err.message;
    }
  }

  async function savePage(pageKey) {
    setBusy(true, `save-${pageKey}-btn`);
    try {
      const remote = await ghGetFile("data/about.json");
      const data = remote ? JSON.parse(remote.content) : {};

      if (pageKey === "home") {
        data.siteName = readTriple("siteName");
        const home = readTripleRTE("home");
        home.image = qs("#home-image-path").value || "";
        const file = qs("#home-image-input").files[0];
        if (file) {
          toast("正在压缩并上传首页图片…");
          const { base64 } = await fileToResizedBase64(file, 2400, 0.85);
          const heroSha = await ghGetSha("assets/hero.jpg");
          await ghPutFile("assets/hero.jpg", base64, "更新首页图片", heroSha, true);
          home.image = "assets/hero.jpg?v=" + Date.now();
          qs("#home-image-path").value = home.image;
        }
        data.home = home;
      } else if (pageKey === "contact") {
        const contact = readTripleRTE("contact");
        contact.email = qs("#contact-email").value.trim();
        contact.instagram = qs("#contact-instagram").value.trim();
        contact.other = qs("#contact-other").value.trim();
        contact.images = contactGallery.get();
        data.contact = contact;
      } else {
        const pageObj = readTripleRTE(pageKey);
        const pageGalleries = { about: aboutGallery, statement: statementGallery, research: researchGallery };
        if (pageGalleries[pageKey]) pageObj.images = pageGalleries[pageKey].get();
        data[pageKey] = pageObj;
      }

      await ghPutFile("data/about.json", JSON.stringify(data, null, 2), `更新页面内容: ${pageKey}`, remote ? remote.sha : null, false);
      toast("已保存，网站将在数分钟内自动更新。");
    } catch (err) {
      toast("保存失败：" + err.message, "error");
    } finally {
      setBusy(false, `save-${pageKey}-btn`);
    }
  }

  /* ==========================================================================
     Boot
     ========================================================================== */

  document.addEventListener("DOMContentLoaded", () => {
    qsa("[data-tab-group]").forEach(wireTabGroup);
    wireRTEToolbars();
    wireImageDrop("work-image-drop", "work-image-input", "work-image-preview");
    wireImageDrop("home-image-drop", "home-image-input", "home-image-preview");
    processGallery.wire();
    processGallery.render();
    exhibitionGallery.wire();
    exhibitionGallery.render();
    aboutGallery.wire();
    aboutGallery.render();
    statementGallery.wire();
    statementGallery.render();
    researchGallery.wire();
    researchGallery.render();
    contactGallery.wire();
    contactGallery.render();
    cvGallery.wire();
    cvGallery.render();
    projectIntroGallery.wire();
    projectIntroGallery.render();
    projectEntryGallery.wire();
    projectEntryGallery.render();
    wireProcessVideoUpload();
    renderProcessVideoList();

    /* settings */
    const cfg = getConfig();
    if (cfg) {
      qs("#gh-owner").value = cfg.owner || "";
      qs("#gh-repo").value = cfg.repo || "";
      qs("#gh-branch").value = cfg.branch || "main";
      qs("#gh-token").value = cfg.token || "";
      if (cfg.token) testConnection();
    }
    qs("#settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      setConfig({
        owner: qs("#gh-owner").value.trim(),
        repo: qs("#gh-repo").value.trim(),
        branch: qs("#gh-branch").value.trim() || "main",
        token: qs("#gh-token").value.trim(),
      });
      toast("设置已保存在本机浏览器中。");
      testConnection();
      state.worksLoaded = state.cvLoaded = state.pagesLoaded = false;
      loadWorksList();
    });
    qs("#gh-test-btn").addEventListener("click", testConnection);
    qs("#gh-clear-btn").addEventListener("click", () => {
      if (!confirm("确定要清除本机保存的 GitHub 设置与令牌吗？")) return;
      clearConfig();
      qs("#settings-form").reset();
      qs("#admin-status").textContent = "未设置";
      qs("#admin-status").dataset.state = "unset";
      toast("已清除本机设置。");
    });

    /* works */
    qs("#work-form").addEventListener("submit", saveWork);
    qs("#work-cancel-edit").addEventListener("click", resetWorkForm);

    /* cv */
    qs("#cv-form").addEventListener("submit", saveCv);
    qs("#cv-cancel-edit").addEventListener("click", resetCvForm);
    qs("#save-cv-images-btn").addEventListener("click", saveCvImages);

    /* long-term project */
    qs("#save-project-intro-btn").addEventListener("click", saveProjectIntro);
    qs("#project-entry-form").addEventListener("submit", saveProjectEntry);
    qs("#project-entry-cancel-edit").addEventListener("click", resetProjectEntryForm);
    qs("#project-entry-refresh-btn").addEventListener("click", loadProjectData);

    /* pages */
    qsa("[data-save-page]").forEach((btn) => btn.addEventListener("click", () => savePage(btn.dataset.savePage)));
    qs("#pages-refresh-btn").addEventListener("click", loadPagesData);

    /* lazy-load each section's remote data the first time its main tab opens */
    const mainGroup = qs('[data-tab-group="main"]');
    mainGroup.addEventListener("tabchange", (e) => {
      if (e.detail.key === "works" && !state.worksLoaded) loadWorksList();
      if (e.detail.key === "cv" && !state.cvLoaded) loadCvList();
      if (e.detail.key === "project" && !state.projectLoaded) loadProjectData();
      if (e.detail.key === "pages" && !state.pagesLoaded) loadPagesData();
    });
    qs("#works-refresh-btn").addEventListener("click", loadWorksList);
    qs("#cv-refresh-btn").addEventListener("click", loadCvList);

    /* if works tab is the one visible by default, load it right away */
    if (qs('[data-tab-panel="works"]') && !qs('[data-tab-panel="works"]').hidden) loadWorksList();
  });
})();
