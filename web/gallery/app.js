"use strict";

const $ = (selector) => document.querySelector(selector); // Keeps DOM lookups readable throughout the gallery.
const state = { sets: [], active: null, admin: false, authenticated: false, canPost: false, usersPage: 0, csrf: "", viewerIndex: 0, editing: null, captionId: null, uploading: false };
const apiRoot = new URL("api/", location.href); // Keeps requests beside the gallery even when the site lives in a subdirectory.
const engagementRequests = new Map(); // Serializes each target's view/like requests so slower responses cannot undo newer feedback.

function engagementTarget(kind, id) {
  return kind === "sets" ? state.sets.find((set) => set.id === id) : state.sets.flatMap((set) => set.items).find((item) => item.id === id);
}

function syncEngagement(kind, id, values = null) {
  const target = engagementTarget(kind, id);
  if (!target) return;
  if (values) Object.assign(target, values);
  document.querySelectorAll(`[data-engagement="${kind}:${id}"]`).forEach((bar) => {
    bar.querySelector(".view-count").textContent = `${(target.views || 0).toLocaleString()} view${target.views === 1 ? "" : "s"}`;
    const button = bar.querySelector(".like-button");
    button.textContent = `${target.liked ? "♥ Liked" : "♡ Like"} · ${(target.likes || 0).toLocaleString()}`;
    button.setAttribute("aria-pressed", String(Boolean(target.liked)));
    button.setAttribute("aria-label", `${target.liked ? "Unlike" : "Like"} ${kind === "sets" ? "collection" : "media"}, ${target.likes || 0} likes`);
    button.disabled = engagementRequests.has(`${kind}:${id}`);
  }); // Updates counts in place without reloading images, interrupting video, or moving keyboard focus.
}

function sendEngagement(kind, id, action, body) {
  const key = `${kind}:${id}`;
  const previous = engagementRequests.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const values = await api(`${kind}/${id}/${action}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) });
    syncEngagement(kind, id, values);
  });
  engagementRequests.set(key, pending);
  syncEngagement(kind, id);
  pending.catch((error) => {
    document.querySelectorAll(`[data-engagement="${key}"] .engagement-feedback`).forEach((node) => { node.textContent = error.message; });
  }).finally(() => {
    if (engagementRequests.get(key) === pending) engagementRequests.delete(key);
    syncEngagement(kind, id);
  }); // A failed request leaves the previous confirmed count intact and offers an inline explanation.
}

function engagementBar(kind, target) {
  const bar = element("div", "engagement-bar");
  bar.dataset.engagement = `${kind}:${target.id}`;
  const views = element("span", "view-count", `${(target.views || 0).toLocaleString()} view${target.views === 1 ? "" : "s"}`);
  views.title = "One view per browser per UTC day when opened.";
  const like = element("button", "action like-button", `${target.liked ? "♥ Liked" : "♡ Like"} · ${(target.likes || 0).toLocaleString()}`);
  like.type = "button";
  like.setAttribute("aria-pressed", String(Boolean(target.liked)));
  like.setAttribute("aria-label", `${target.liked ? "Unlike" : "Like"} ${kind === "sets" ? "collection" : "media"}, ${target.likes || 0} likes`);
  like.title = state.authenticated ? "One like per LiDollID account. Click again to remove your like." : "Sign in with LiDollID to like this.";
  like.disabled = engagementRequests.has(`${kind}:${target.id}`);
  like.addEventListener("click", () => {
    if (!state.authenticated) { $("#login-dialog").showModal(); return; }
    document.querySelectorAll(`[data-engagement="${kind}:${target.id}"] .engagement-feedback`).forEach((node) => { node.textContent = ""; });
    sendEngagement(kind, target.id, "like", { liked: !engagementTarget(kind, target.id)?.liked });
  });
  const feedback = element("span", "engagement-feedback");
  feedback.setAttribute("role", "status");
  bar.append(views, like, feedback);
  return bar;
}

function element(tag, className, content) {
  const node = document.createElement(tag); // Builds content without treating titles or captions as executable HTML.
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function api(path, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrf;
  const response = await fetch(new URL(path, apiRoot), { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => ({ error: "The gallery service is unavailable. Please try again shortly." }));
  if (!response.ok) {
    if (response.status === 401) setAccount({}); // Hides management controls when a server session expires.
    throw new Error(data.error || "The request could not be completed.");
  }
  return data;
}

function setAccount(account) { // Separates account access, posting permission and owner management in the interface.
  state.authenticated = Boolean(account.authenticated);
  state.admin = Boolean(account.admin);
  state.canPost = Boolean(account.can_post);
  $("#manager").hidden = !state.canPost;
  $("#users-button").hidden = !state.admin;
  $("#login-button").hidden = state.authenticated;
  $("#logout-button").hidden = !state.authenticated;
  $("#account-label").textContent = account.user ? 'Signed in as ' + account.user.username : 'Sign in to like and download originals';
  if (!state.admin && $("#users-dialog").open) $("#users-dialog").close();
  if (state.active) renderDetail();
}

function mediaElement(item, full = false) {
  const original = full && state.authenticated;
  const media = element(item.kind === "video" && original ? "video" : "img");
  media.src = original ? item.url : item.preview_url;
  if (item.kind === "video" && original) {
    media.controls = full;
    media.preload = full ? "metadata" : "none"; // Avoids downloading every video while browsing a collection.
    media.playsInline = true;
    media.setAttribute("aria-label", item.caption || "Video");
    if (full) videoPreviews.watch(media, item.url, true);
  } else {
    media.alt = item.caption || "Photo from this collection";
    media.loading = full ? "eager" : "lazy";
    media.decoding = "async";
  }
  return media;
}

function mediaCover(item) {
  const cover = element("div", "cover");
  if (item?.kind === "video" && !item.preview_url) {
    const preview = element("img", "video-preview");
    preview.alt = ""; // The enclosing button already names the video; its preview is decorative.
    const play = element("span", "video-play", "▷");
    play.setAttribute("aria-hidden", "true");
    cover.append(preview, play);
    videoPreviews.watch(preview, item.url);
  } else if (item) {
    cover.append(mediaElement(item));
    if (item.kind === "video") cover.append(element("span", "video-play", "Play"));
  }
  else cover.append(element("span", "cover-symbol", "✧"));
  return cover; // Gives collection covers and individual videos the same lazy still-frame preview and play affordance.
}

function mediaCount(items) {
  const photos = items.filter((item) => item.kind === "image").length;
  const videos = items.length - photos;
  return `${photos} photo${photos === 1 ? "" : "s"} · ${videos} video${videos === 1 ? "" : "s"}`;
}

function renderCollections() {
  const query = $("#search").value.trim().toLowerCase();
  const matching = state.sets.filter((set) => `${set.title} ${set.description}`.toLowerCase().includes(query));
  $("#set-count").textContent = String(state.sets.length).padStart(2, "0");
  $("#collection-grid").replaceChildren();
  for (const set of matching) {
    const card = element("article", "collection-card");
    const open = element("button", "collection-open");
    open.type = "button"; // Keeps the collection opener and its like button separate for valid keyboard-accessible markup.
    const item = set.items.find((entry) => entry.id === set.cover_id) || set.items[0];
    const cover = mediaCover(item);
    const copy = element("div", "card-copy");
    copy.append(element("p", "eyebrow", mediaCount(set.items)), element("h3", "", set.title), element("p", "", set.description.slice(0, 140)), element("p", "eyebrow", "Explore collection →"));
    open.append(cover, copy);
    open.addEventListener("click", () => { openSet(set.id); sendEngagement("sets", set.id, "view"); });
    card.append(open, engagementBar("sets", set));
    $("#collection-grid").append(card);
  }
  $("#empty-state").hidden = matching.length > 0;
  $("#empty-title").textContent = query ? "No collections found" : "A little space for memories";
  $("#empty-description").textContent = query ? "Try another title or a shorter search." : state.canPost ? "Choose + New set to start your first collection." : "The first collection is on its way. Come back soon.";
}

function openSet(id, focus = true) {
  state.active = state.sets.find((set) => set.id === id) || null;
  $("#collections").hidden = Boolean(state.active);
  $("#set-detail").hidden = !state.active;
  if (state.active) {
    renderDetail();
    if (focus) $("#set-title").focus();
  } else renderCollections();
}

function actionButton(label, handler, danger = false) {
  const button = element("button", `action${danger ? " danger" : ""}`, label);
  button.type = "button";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await handler(); } catch (error) { alert(error.message); }
    finally { button.disabled = false; }
  }); // Prevents double submissions and surfaces errors for individual management actions.
  return button;
}

function renderDetail() {
  const set = state.active;
  $("#set-actions").hidden = $("#upload-form").hidden = !(state.canPost && set.can_edit);
  $("#set-title").textContent = set.title;
  $("#set-description").textContent = set.description;
  $("#set-meta").textContent = mediaCount(set.items);
  $("#set-engagement").replaceChildren(engagementBar("sets", set));
  $("#media-empty").hidden = set.items.length > 0;
  $("#media-grid").replaceChildren();
  set.items.forEach((item, index) => {
    const card = element("article", "media-card");
    const open = element("button", "media-open");
    open.type = "button";
    open.setAttribute("aria-label", `Open ${item.kind === "video" ? "video" : "photo"} ${index + 1}: ${item.caption || set.title}`);
    const cover = mediaCover(item);
    open.append(cover);
    open.addEventListener("click", () => showViewer(index));
    card.append(open, element("p", "preserve-lines", item.caption || `${item.kind === "video" ? "Video" : "Photo"} ${index + 1}`));
    card.append(engagementBar("items", item));
    if (state.canPost && set.can_edit) {
      const controls = element("div", "media-controls");
      controls.append(actionButton("Caption", () => {
        state.captionId = item.id;
        $("#caption-form").elements.caption.value = item.caption;
        $("#caption-error").textContent = "";
        $("#caption-dialog").showModal();
      }));
      controls.append(actionButton(set.cover_id === item.id ? "Current cover" : "Make cover", async () => {
        await api(`sets/${set.id}`, { method: "PATCH", body: JSON.stringify({ cover_id: item.id }) });
        await refresh();
      }));
      controls.append(actionButton("Delete", async () => {
        if (!confirm("Delete this file from the gallery? This cannot be undone.")) return;
        await api(`items/${item.id}`, { method: "DELETE" });
        await refresh();
      }, true));
      card.append(controls);
    }
    $("#media-grid").append(card);
  });
}

function showViewer(index) {
  const items = state.active.items;
  state.viewerIndex = (index + items.length) % items.length;
  const item = items[state.viewerIndex];
  $("#viewer-media").replaceChildren(mediaElement(item, true)); // Removing the previous video also stops its playback.
  $("#viewer-caption").textContent = item.caption;
  $("#viewer-counter").textContent = `${state.viewerIndex + 1} / ${items.length}`;
  $("#viewer-engagement").replaceChildren(engagementBar("items", item));
  $("#download-media").href = state.authenticated ? item.download_url : "auth/login";
  $("#download-media").textContent = state.authenticated ? "Download original" : "Sign in for the original";
  $("#preview-notice").hidden = state.authenticated;
  $("#previous-media").disabled = $("#next-media").disabled = items.length < 2;
  if (!$("#viewer").open) $("#viewer").showModal();
  sendEngagement("items", item.id, "view"); // Thumbnails and video range requests do not count as opens.
}

async function refresh() {
  const data = await api("sets");
  state.sets = data.sets;
  $("#status").textContent = "";
  $("#retry").hidden = true;
  renderCollections();
  if (state.active) openSet(state.active.id, false);
}

async function initialize() {
  $("#status").textContent = "Opening the archive…";
  try {
    const session = await api("session");
    state.csrf = session.csrf;
    setAccount(session);
    $("#upload-hint").textContent = `JPG, PNG, GIF, WebP, MP4 or WebM. Up to ${session.max_upload_mb} MB per file. Previews are public; originals require LiDollID sign-in.`;
    await refresh();
  } catch (error) {
    $("#status").textContent = error.message;
    $("#retry").hidden = false;
  }
}

function wireForm(selector, errorSelector, submit) {
  $(selector).addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]');
    button.disabled = true;
    $(errorSelector).textContent = "";
    try { await submit(event.target); }
    catch (error) { $(errorSelector).textContent = error.message; }
    finally { button.disabled = false; }
  }); // Keeps each form usable after a validation, network, or authentication error.
}

wireForm("#edit-form", "#edit-error", async (form) => {
  const data = await api(state.editing ? `sets/${state.editing}` : "sets", { method: state.editing ? "PATCH" : "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
  await refresh();
  $("#edit-dialog").close();
  openSet(data.id);
});

wireForm("#caption-form", "#caption-error", async (form) => {
  await api(`items/${state.captionId}`, { method: "PATCH", body: JSON.stringify({ caption: form.elements.caption.value }) });
  await refresh();
  $("#caption-dialog").close();
});

function uploadFile(setId, file, progress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); // Uses upload progress events so larger videos have visible feedback.
    request.open("POST", new URL(`sets/${setId}/items`, apiRoot));
    request.setRequestHeader("X-CSRF-Token", state.csrf);
    request.upload.onprogress = (event) => { if (event.lengthComputable) progress(event.loaded / event.total); };
    request.onerror = () => reject(new Error("Connection interrupted. Check the collection before retrying this file."));
    request.onload = () => {
      let data;
      try { data = JSON.parse(request.responseText); } catch { data = { error: "The server could not accept this upload." }; }
      if (request.status >= 200 && request.status < 300) resolve(data);
      else {
        if (request.status === 401) setAccount({});
        reject(new Error(data.error || "Upload failed."));
      }
    };
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    request.send(file); // Streams the file directly instead of buffering a multipart batch on the server.
  });
}

wireForm("#upload-form", "#upload-status", async (form) => {
  const files = Array.from($("#upload-files").files);
  const setId = state.active.id; // Pins the batch to its original set even if navigation changes.
  state.uploading = true;
  $("#upload-files").disabled = true;
  $("#upload-progress").hidden = false;
  $("#upload-progress").value = 0;
  let completed = 0;
  try {
    for (const file of files) {
      $("#upload-status").textContent = `Uploading ${completed + 1} of ${files.length}: ${file.name}`;
      await uploadFile(setId, file, (fraction) => { $("#upload-progress").value = ((completed + fraction) / files.length) * 100; });
      completed += 1;
    }
    form.reset();
    $("#upload-status").textContent = `${completed} file${completed === 1 ? "" : "s"} uploaded. Your collection is live.`;
  } catch (error) {
    // Keeps only unfinished files selected so retrying cannot duplicate successful uploads.
    const remaining = new DataTransfer();
    files.slice(completed).forEach((file) => remaining.items.add(file));
    $("#upload-files").files = remaining.files;
    throw new Error(`${completed} of ${files.length} uploaded. ${error.message} Only unfinished files remain selected.`);
  } finally {
    state.uploading = false;
    $("#upload-files").disabled = false;
    $("#upload-progress").hidden = true;
    await refresh();
  }
});

function editSet(set = null) {
  state.editing = set?.id || null;
  $("#edit-title").textContent = set ? "Edit set" : "New set";
  $("#edit-form").elements.title.value = set?.title || "";
  $("#edit-form").elements.description.value = set?.description || "";
  $("#edit-error").textContent = "";
  $("#edit-dialog").showModal();
}

$("#login-button").addEventListener("click", () => $("#login-dialog").showModal());
$("#download-media").addEventListener("click", event => { if (!state.authenticated) { event.preventDefault(); $("#login-dialog").showModal(); } });
$("#logout-button").addEventListener("click", async () => {
  try { await api("logout", { method: "POST" }); state.csrf = ""; setAccount({}); await initialize(); }
  catch (error) { alert(error.message); }
});
$("#new-set").addEventListener("click", () => editSet());
$("#edit-set").addEventListener("click", () => editSet(state.active));
$("#delete-set").addEventListener("click", async () => {
  if (state.uploading) { alert("Please let the upload finish before deleting this set."); return; }
  if (!confirm(`Delete “${state.active.title}” and all its photos and videos? This cannot be undone.`)) return;
  try { await api(`sets/${state.active.id}`, { method: "DELETE" }); openSet(null); await refresh(); }
  catch (error) { alert(error.message); }
});
$("#back-to-sets").addEventListener("click", () => { openSet(null); $("#search").focus(); });
$("#search").addEventListener("input", renderCollections);
$("#retry").addEventListener("click", initialize);
$("#previous-media").addEventListener("click", () => showViewer(state.viewerIndex - 1));
$("#next-media").addEventListener("click", () => showViewer(state.viewerIndex + 1));
$("#viewer").addEventListener("close", () => $("#viewer-media").replaceChildren());
$("#viewer").addEventListener("keydown", (event) => {
  if (event.target.tagName === "VIDEO") return; // Leaves native video keyboard controls intact.
  if (event.key === "ArrowLeft") { event.preventDefault(); showViewer(state.viewerIndex - 1); }
  if (event.key === "ArrowRight") { event.preventDefault(); showViewer(state.viewerIndex + 1); }
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
window.addEventListener("beforeunload", (event) => { if (state.uploading) { event.preventDefault(); event.returnValue = ""; } });

function syncCrt() {
  const enabled = !document.documentElement.classList.contains("crt-disabled");
  $("#crt-toggle").textContent = `CRT FX // ${enabled ? "ON" : "OFF"}`;
  $("#crt-toggle").setAttribute("aria-pressed", String(enabled));
}
$("#crt-toggle").addEventListener("click", () => {
  document.documentElement.classList.toggle("crt-disabled");
  try { localStorage.setItem("ldq-crt-effect", document.documentElement.classList.contains("crt-disabled") ? "off" : "on"); } catch { /* Keeps the toggle working without storage. */ }
  syncCrt();
});
syncCrt();
initialize();

async function loadUsers() { // Paginates account management; user-authored names always enter the DOM through textContent.
  $("#users-error").textContent = '';
  const data = await api('users?q=' + encodeURIComponent($("#users-search").value) + '&page=' + state.usersPage);
  $("#users-list").replaceChildren();
  for (const user of data.users) {
    const row = element('form', 'user-row');
    row.dataset.userId = user.id;
    const description = element('div');
    description.append(element('strong', '', user.username), element('p', 'field-hint', user.collections + ' collections'), element('small', '', 'Account ID: ' + user.subject));
    const label = element('label', '', 'Gallery access');
    const role = element('select');
    role.name = 'role';
    for (const value of user.role === 'owner' ? ['owner'] : ['viewer','contributor']) {
      const option = element('option', '', value === 'contributor' ? 'Contributor (can post)' : value === 'owner' ? 'Owner' : 'Viewer');
      option.value = value; role.append(option);
    }
    role.value = user.role;
    role.disabled = user.role === 'owner';
    label.append(role);
    const blockedLabel = element('label', 'checkbox-label', 'Disable gallery access');
    const blocked = element('input'); blocked.type = 'checkbox'; blocked.name = 'disabled'; blocked.checked = Boolean(user.disabled); blocked.disabled = user.role === 'owner'; blockedLabel.prepend(blocked);
    const save = element('button', 'action', 'Save access'); save.type = 'submit'; save.disabled = user.role === 'owner';
    row.append(description, label, blockedLabel, save);
    row.addEventListener('submit', async event => {
      event.preventDefault(); save.disabled = true;
      try { await api('users/' + user.id, { method: 'PATCH', body: JSON.stringify({ role: role.value, disabled: blocked.checked }) }); await loadUsers(); }
      catch(error) { $("#users-error").textContent = error.message; }
      finally { save.disabled = user.role === 'owner'; }
    });
    $("#users-list").append(row);
  }
  $("#users-page").textContent = data.total + ' accounts - page ' + (state.usersPage + 1);
  $("#users-prev").disabled = state.usersPage === 0;
  $("#users-next").disabled = (state.usersPage + 1) * 50 >= data.total;
}
$("#users-button").addEventListener('click', async () => { $("#users-dialog").showModal(); try { await loadUsers(); } catch(error) { $("#users-error").textContent = error.message; } });
$("#users-search-form").addEventListener('submit', async event => { event.preventDefault(); state.usersPage = 0; try { await loadUsers(); } catch(error) { $("#users-error").textContent = error.message; } });
for (const [id, delta] of [['users-prev', -1], ['users-next', 1]]) document.getElementById(id).addEventListener('click', async () => { state.usersPage += delta; try { await loadUsers(); } catch(error) { $("#users-error").textContent = error.message; } });
