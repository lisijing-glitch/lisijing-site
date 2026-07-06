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

  const state = { works: [], cv: [], about: {}, worksLoaded: false, cvLoaded: false, pagesLoaded: false };
  let currentProcessImages = [];
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

  /* ---- creative process: multi-image gallery ---- */

  function renderProcessImageList() {
    const listEl = qs("#process-image-list");
    if (!listEl) return;
    if (!currentProcessImages.length) {
      listEl.innerHTML = '<p class="field-hint">还没有创作过程图片。</p>';
      return;
    }
    listEl.innerHTML = currentProcessImages
      .map(
        (src, i) => `
        <div class="entry-row">
          <img src="../${escapeHtml(src)}" alt="" onerror="this.style.visibility='hidden'">
          <div class="info"><div class="t">图 ${i + 1}</div></div>
          <div class="actions">
            <button type="button" data-del-process-image="${i}">删除</button>
          </div>
        </div>`
      )
      .join("");
    qsa("[data-del-process-image]", listEl).forEach((b) =>
      b.addEventListener("click", () => {
        currentProcessImages.splice(Number(b.dataset.delProcessImage), 1);
        renderProcessImageList();
      })
    );
  }

  function wireProcessImageUpload() {
    const drop = qs("#process-image-drop"),
      input = qs("#process-image-input");
    if (!drop || !input) return;
    drop.addEventListener("click", () => input.click());
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      if (!files.length) return;
      for (const file of files) {
        try {
          toast(`正在压缩并上传创作过程图片…（${file.name}）`);
          const { base64 } = await fileToResizedBase64(file, 1800, 0.82);
          const path = `works/process-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`;
          await ghPutFile(path, base64, `创作过程图片: ${path}`, null, true);
          currentProcessImages.push(path);
          renderProcessImageList();
        } catch (err) {
          toast("上传失败：" + err.message, "error");
        }
      }
      input.value = "";
    });
  }

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
      if (!state.works.length) {
        listEl.innerHTML = '<p class="field-hint">还没有作品，填写上方表单新增第一件。</p>';
        return;
      }
      listEl.innerHTML = state.works
        .map((w) => {
          const t = (w.title && (w.title.zh || w.title.en || w.title.jp)) || "（未命名）";
          const tag = w.published === false ? "草稿" : "公开";
          return `
          <div class="entry-row">
            <img src="../${escapeHtml(w.image || "")}" alt="" onerror="this.style.visibility='hidden'">
            <div class="info">
              <div class="t">${escapeHtml(t)}</div>
              <div class="m">${escapeHtml(w.year || "")} · ${tag}${w.sold ? " · 已售" : ""}</div>
            </div>
            <div class="actions">
              <button type="button" data-edit-work="${escapeHtml(w.id)}">编辑</button>
              <button type="button" data-del-work="${escapeHtml(w.id)}">删除</button>
            </div>
          </div>`;
        })
        .join("");
      qsa("[data-edit-work]", listEl).forEach((b) => b.addEventListener("click", () => editWork(b.dataset.editWork)));
      qsa("[data-del-work]", listEl).forEach((b) => b.addEventListener("click", () => deleteWork(b.dataset.delWork)));
    } catch (err) {
      listEl.innerHTML = `<p class="field-hint">读取失败：${escapeHtml(err.message)}</p>`;
    }
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
    currentProcessImages = [];
    currentProcessVideos = [];
    renderProcessImageList();
    renderProcessVideoList();
  }

  function editWork(id) {
    const w = state.works.find((x) => x.id === id);
    if (!w) return;
    qs("#work-editing-id").value = w.id;
    writeTriple("work-title", w.title);
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
    currentProcessImages = (w.process && Array.isArray(w.process.images) ? [...w.process.images] : []).filter(Boolean);
    currentProcessVideos = (w.process && Array.isArray(w.process.videos) ? [...w.process.videos] : []).filter(
      (v) => v && (v.src || v.url)
    );
    renderProcessImageList();
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
        year: qs("#work-year").value.trim(),
        size: qs("#work-size").value.trim(),
        material: qs("#work-material").value.trim(),
        description: readTriple("work-desc"),
        sold: qs('input[name="work-sold"]:checked').value === "true",
        published: qs('input[name="work-published"]:checked').value === "true",
        image: imagePath,
        process: {
          description: readTriple("work-process-desc"),
          images: currentProcessImages.filter(Boolean),
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
        data.contact = contact;
      } else {
        data[pageKey] = readTripleRTE(pageKey);
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
    wireProcessImageUpload();
    renderProcessImageList();
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

    /* pages */
    qsa("[data-save-page]").forEach((btn) => btn.addEventListener("click", () => savePage(btn.dataset.savePage)));
    qs("#pages-refresh-btn").addEventListener("click", loadPagesData);

    /* lazy-load each section's remote data the first time its main tab opens */
    const mainGroup = qs('[data-tab-group="main"]');
    mainGroup.addEventListener("tabchange", (e) => {
      if (e.detail.key === "works" && !state.worksLoaded) loadWorksList();
      if (e.detail.key === "cv" && !state.cvLoaded) loadCvList();
      if (e.detail.key === "pages" && !state.pagesLoaded) loadPagesData();
    });
    qs("#works-refresh-btn").addEventListener("click", loadWorksList);
    qs("#cv-refresh-btn").addEventListener("click", loadCvList);

    /* if works tab is the one visible by default, load it right away */
    if (qs('[data-tab-panel="works"]') && !qs('[data-tab-panel="works"]').hidden) loadWorksList();
  });
})();
