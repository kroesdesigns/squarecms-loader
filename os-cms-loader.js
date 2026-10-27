/* osCMS loader — v1 (runtime only; was "v58"). Build: __BUILD__
 *
 * The live-site half of SquareCMS. Everything an editor needs now lives in
 * the SquareCMS Studio Chrome extension, so this file is just:
 *
 *   01. Config & constants
 *   02. Shared helpers (slugify, normalization, tag map)
 *   04.5 Page views (data-oscms-view: values | highlight | tags) — set by Studio
 *   03. Replacement engine (text nodes + attributes, record/restore)
 *   04. LIVE SITE boot (immediate pass + MutationObserver + mercury:load)
 *   05. Editor gate (top-window /config check)
 *   06. EDITOR PREVIEW runtime — values from the Studio draft, raw tags +
 *       pill highlights in edit mode (the restore-before-serialize safety)
 *
 * Install (one line, every site, never changes):
 *   <script src="https://cdn.jsdelivr.net/gh/OWNER/REPO@release/os-cms-loader.min.js"></script>
 *
 * Data: the footer OSCMS:data block (window.__osCMSData), written by the
 * extension when you publish. v3–v57 data blocks all work unchanged.
 */
(function () {
  "use strict";

  /* ====================================================================
   * 01. Config & constants
   * ================================================================== */
  var APP = "osCMS";
  var DATA_GLOBAL = "__osCMSData";
  var LOADER_VERSION = "1";          // one major line — every site loads @release and stays current
  var LOADER_BUILD = "__BUILD__";    // replaced by the GitHub Action with the commit that built this file
  try { document.documentElement.setAttribute("data-oscms-loader", LOADER_VERSION); document.documentElement.setAttribute("data-oscms-build", LOADER_BUILD); } catch (eV) {}
  var MARKER_ID = "OSCMS:data";
  var MARKER_OPEN = "<!-- ==== " + MARKER_ID + " \u00b7 Site CMS Data ==== -->";
  var MARKER_CLOSE = "<!-- ==== /" + MARKER_ID + " ==== -->";
  var STORE_KEY = "osCMSEditor";
  var STORE_VERSION = 4;
  var LINK_KINDS = ["url", "phone", "email"];
  var FIELD_TYPES = ["text", "link", "image", "rich", "number", "date", "toggle"];

  function tagRe() {
    // fresh instance each use — global regexes carry lastIndex state
    return /\{\{\s*([a-zA-Z0-9][a-zA-Z0-9_.-]*)\s*\}\}/g;
  }

  /* ====================================================================
   * 02. Shared helpers
   * ================================================================== */
  /** Status stamp Studio reads from <html data-oscms-status> — what mode the
   *  loader is in on this page, which item _xx resolved to, how much it did. */
  var statusCounts = { replaced: 0 };
  function stampStatus(doc, mode, extra) {
    try {
      var o = { mode: mode, index: window.APS_PAGE_INDEX || null, replaced: statusCounts.replaced, unknown: (window.__osCMSUnknownTags || []).length, data: !!window.__osCMSData, at: Date.now() };
      if (extra) for (var k in extra) o[k] = extra[k];
      (doc || document).documentElement.setAttribute("data-oscms-status", JSON.stringify(o));
    } catch (e) {}
  }
  function log() {
    try {
      if (window.osCMSDebug || (window.top && window.top.osCMSDebug)) {
        console.log.apply(console, ["[" + APP + "]"].concat([].slice.call(arguments)));
      }
    } catch (e) {}
  }
  function slugify(s) {
    return (
      String(s || "")
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "item"
    );
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  /** v1 stored fields as plain strings; v2 uses {name,type}; v3 adds pages. */
  function normalizeCollections(cols) {
    return (cols || []).map(function (c) {
      return {
        id: c.id,
        name: c.name || "Collection",
        slug: c.slug || slugify(c.name),
        pages: (c.pages || [])
          .map(function (p) {
            p = String(p).trim();
            if (!p) return "";
            return p.charAt(0) === "/" ? p : "/" + p;
          })
          .filter(Boolean),
        fields: (c.fields || []).map(function (f) {
          if (typeof f === "string") return { name: f, type: "text" };
          var nf = { name: f.name, type: FIELD_TYPES.indexOf(f.type) !== -1 ? f.type : "text" };
          if (f.format) nf.format = String(f.format);
          if (f.decimals != null && f.decimals !== "") nf.decimals = f.decimals;
          if (f.currency) nf.currency = String(f.currency);
          return nf;
        }),
        items: (c.items || []).map(function (it) {
          return { values: (it && it.values) || {} };
        }),
      };
    });
  }

  /** Does a collection apply on this path? Empty list = sitewide. */
  function pageMatch(pages, pathname) {
    if (!pages || !pages.length || pathname == null) return true;
    for (var i = 0; i < pages.length; i++) {
      var p = pages[i];
      if (p === "/") {
        if (pathname === "/") return true;
        continue;
      }
      if (pathname === p || pathname.indexOf(p + "/") === 0) return true;
    }
    return false;
  }

  /** Link values are objects; v1–v3 stored bare strings. Accept both. */
  function normLink(v) {
    if (v && typeof v === "object") {
      return {
        v: String(v.v || ""),
        label: String(v.label || ""),
        kind: LINK_KINDS.indexOf(v.kind) !== -1 ? v.kind : "url",
        nt: !!v.nt,
      };
    }
    var s = String(v == null ? "" : v).trim();
    var kind = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
      ? "email"
      : /^\+?[\d\s().-]{7,}$/.test(s)
        ? "phone"
        : "url";
    return { v: s, label: "", kind: kind, nt: false };
  }

  function linkHref(l) {
    var s = (l.v || "").trim();
    if (!s) return "";
    if (l.kind === "phone") return "tel:" + s.replace(/[^+0-9]/g, "");
    if (l.kind === "email") return "mailto:" + s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.charAt(0) === "/" || s.charAt(0) === "#") return s;
    return "https://" + s; // bare domain convenience
  }

  /**
   * tagMap — pathname null = no scoping.
   *   text/image: { value, type }
   *   link:       { value: display text, type, href, nt }
   */
  /* ====================================================================
   * Field display — rich / number / date / toggle. Shared with Studio
   * (lib/core.js carries the same function); keep the two in step.
   * ================================================================== */
  var RICH_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, A: 1, BR: 1, P: 1, UL: 1, OL: 1, LI: 1, S: 1 };
  function sanitizeRich(html) {
    try {
      var box = document.implementation.createHTMLDocument("").createElement("div");
      box.innerHTML = String(html == null ? "" : html);
      (function walk(el) {
        var kids = [].slice.call(el.childNodes);
        for (var i = 0; i < kids.length; i++) {
          var k = kids[i];
          if (k.nodeType === 8) { el.removeChild(k); continue; }
          if (k.nodeType !== 1) continue;
          if (!RICH_TAGS[k.tagName]) { // unwrap unknown elements, keep their text
            while (k.firstChild) el.insertBefore(k.firstChild, k);
            el.removeChild(k); continue;
          }
          var attrs = [].slice.call(k.attributes);
          for (var a = 0; a < attrs.length; a++) {
            var an = attrs[a].name.toLowerCase();
            if (k.tagName === "A" && (an === "href" || an === "target")) {
              if (an === "href" && /^\s*javascript:/i.test(attrs[a].value)) k.removeAttribute(an);
              continue;
            }
            k.removeAttribute(attrs[a].name);
          }
          if (k.tagName === "A" && k.getAttribute("target") === "_blank") k.setAttribute("rel", "noopener");
          walk(k);
        }
      })(box);
      return box.innerHTML;
    } catch (e) { return String(html == null ? "" : html).replace(/<[^>]*>/g, ""); }
  }
  function richToText(html) {
    return String(html == null ? "" : html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div)>/gi, "\n").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\n{2,}/g, "\n").trim();
  }
  function toggleOn(raw) {
    if (typeof raw === "boolean") return raw;
    if (raw == null) return false;
    var s = String(typeof raw === "object" ? raw.v : raw).trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes" || s === "on" || s === "y";
  }
  function formatNumber(raw, f) {
    var s = String(raw == null ? "" : typeof raw === "object" ? raw.v : raw).trim();
    if (s === "") return "";
    var n = Number(s.replace(/[^0-9.+-]/g, ""));
    if (!isFinite(n)) return s;
    var style = (f && f.format) || "plain", dec = f && f.decimals != null && f.decimals !== "" ? parseInt(f.decimals, 10) : null;
    var o = {};
    if (dec != null && !isNaN(dec)) { o.minimumFractionDigits = dec; o.maximumFractionDigits = dec; }
    try {
      if (style === "currency") { o.style = "currency"; o.currency = (f && f.currency) || "USD"; if (dec == null) { o.minimumFractionDigits = 0; o.maximumFractionDigits = 2; } return new Intl.NumberFormat("en-US", o).format(n); }
      if (style === "percent") { if (dec == null) o.maximumFractionDigits = 2; return new Intl.NumberFormat("en-US", o).format(n) + "%"; }
      if (style === "comma") { if (dec == null) o.maximumFractionDigits = 4; return new Intl.NumberFormat("en-US", o).format(n); }
      if (dec != null && !isNaN(dec)) return n.toFixed(dec);
    } catch (e) {}
    return String(n);
  }
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  function parseDateRaw(raw) {
    var s = String(raw == null ? "" : typeof raw === "object" ? raw.v : raw).trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    var d = new Date(s); return isNaN(d.getTime()) ? null : d;
  }
  function formatDate(raw, f) {
    var s = String(raw == null ? "" : typeof raw === "object" ? raw.v : raw).trim();
    if (!s) return "";
    var d = parseDateRaw(s); if (!d) return s;
    var style = (f && f.format) || "medium";
    var M = MONTHS[d.getMonth()], D = d.getDate(), Y = d.getFullYear();
    switch (style) {
      case "long": return M + " " + D + ", " + Y;
      case "short": return (d.getMonth() + 1) + "/" + D + "/" + Y;
      case "iso": return Y + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + D).slice(-2);
      case "monthYear": return M + " " + Y;
      case "weekday": return DAYS[d.getDay()] + ", " + M + " " + D + ", " + Y;
      case "day": return M.slice(0, 3) + " " + D;
      default: return M.slice(0, 3) + " " + D + ", " + Y;
    }
  }
  /** Map entry for a non-link field: { value (display text), type, html?, on? }. */
  function fieldEntry(f, raw) {
    var t = f.type;
    if (t === "rich") { var h = sanitizeRich(typeof raw === "object" && raw ? raw.v : raw); return { value: richToText(h), html: h, type: "rich" }; }
    if (t === "number") return { value: formatNumber(raw, f), type: "number" };
    if (t === "date") return { value: formatDate(raw, f), type: "date" };
    if (t === "toggle") { var on = toggleOn(raw); return { value: on ? "Yes" : "No", on: on, type: "toggle" }; }
    return { value: typeof raw === "string" ? raw : raw == null ? "" : String(raw.v == null ? "" : raw.v), type: t };
  }

  function buildTagMap(data, pathname) {
    var map = {};
    if (!data) return map;
    normalizeCollections(data.collections).forEach(function (c) {
      if (!pageMatch(c.pages, pathname)) return;
      c.items.forEach(function (item, i) {
        var n = i + 1;
        c.fields.forEach(function (f) {
          var key = c.slug + "." + f.name + "_" + n;
          if (f.type === "link") {
            var l = normLink(item.values[f.name]);
            map[key] = { value: l.label || l.v, type: "link", href: linkHref(l), nt: l.nt };
          } else {
            map[key] = fieldEntry(f, item.values[f.name]);
          }
        });
      });
    });
    return map;
  }

  function maybeDecode(s) {
    if (s.indexOf("%7B") === -1 && s.indexOf("%7b") === -1) return s;
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }
  /* ====================================================================
   * 03. Replacement engine
   *
   * One engine serves both worlds. `record: true` (editor preview) keeps
   * every original so restore() can hand the page back to Squarespace
   * untouched before edit mode gets a chance to serialize anything.
   *
   * Text: tokens swapped inside text nodes (values inherit surrounding
   * styling; inserted as text data — no HTML injection possible).
   * Attributes:
   *   img/source src|data-src|data-image|srcset → tag present (raw or
   *     URL-encoded) → whole attribute becomes the field value; srcset
   *     and sizes are dropped so the browser uses our src. An img whose
   *     alt EXACTLY equals a known image-type tag is swapped too.
   *   a[href] and alt → token-level replacement.
   * ================================================================== */
  function createReplacer(doc, opts) {
    var record = !!(opts && opts.record);
    var map = {};
    var textLog = []; // { node, original }
    var attrLog = []; // { el, attr, original }  (original null = attr was absent)
    var wrapLog = []; // { inserted: [nodes], original: textNode }
    var seenText = typeof WeakSet !== "undefined" ? new WeakSet() : null;

    var counts = {};
    var tidSeq = 0;

    function setMap(m) {
      map = m || {};
      counts = {};
      for (var k in map) {
        if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
        var mm = /^([a-z0-9_-]+)\.[a-z0-9_.-]+_(\d+)$/.exec(k);
        if (mm) {
          var n = parseInt(mm[2], 10);
          if (!counts[mm[1]] || n > counts[mm[1]]) counts[mm[1]] = n;
        }
      }
    }

    /** Repeater: <template data-oscms-each="services"> stamps its content
     *  once per item, rewriting the _i index placeholder to _1.._N. The
     *  stamped copies carry ordinary numeric tags, so the normal text and
     *  attribute passes resolve them with no further special-casing. Item
     *  counts come from the tag map itself (max index per collection), and
     *  a count change (item added or removed in the editor) removes the
     *  previous stamp and re-stamps live. */
    function expandRepeaters(scope) {
      var tpls = scope.querySelectorAll
        ? scope.querySelectorAll("template[data-oscms-each]")
        : [];
      for (var t = 0; t < tpls.length; t++) {
        var tpl = tpls[t];
        var slug = (tpl.getAttribute("data-oscms-each") || "").toLowerCase().trim();
        var n = counts[slug] || 0;
        if (!n) continue; // data not landed yet — a later run() will stamp
        if (tpl.getAttribute("data-oscms-count") === String(n)) continue;

        var tid = tpl.getAttribute("data-oscms-tid");
        if (!tid) {
          tid = "r" + (++tidSeq);
          tpl.setAttribute("data-oscms-tid", tid);
        }
        var parent = tpl.parentNode;
        if (!parent) continue;

        // clear a previous stamp (count changed)
        var old = parent.querySelectorAll('[data-oscms-from="' + tid + '"]');
        for (var o = old.length - 1; o >= 0; o--) {
          if (old[o].parentNode) old[o].parentNode.removeChild(old[o]);
        }

        var unit = tpl.innerHTML;
        var perItem = tpl.content && tpl.content.children ? tpl.content.children.length : 1;
        var html = "";
        for (var i = 1; i <= n; i++) {
          html += unit.split("_i}}").join("_" + i + "}}");
        }
        tpl.insertAdjacentHTML("afterend", html);

        // tag the stamped top-level elements so re-stamps can find them
        var el = tpl.nextElementSibling;
        var need = n * perItem;
        while (el && need > 0) {
          el.setAttribute("data-oscms-from", tid);
          el = el.nextElementSibling;
          need--;
        }
        tpl.setAttribute("data-oscms-count", String(n));
        log("stamped " + n + " items for [" + slug + "]");
      }
    }

    function firstTagIn(str) {
      var m = tagRe().exec(str);
      return m ? m[1] : null;
    }

    function swapTokens(str) {
      return str.replace(tagRe(), function (m, key) {
        return Object.prototype.hasOwnProperty.call(map, key) ? map[key].value : m;
      });
    }

    /** Token swap for href attributes — link entries contribute their href. */
    function swapHrefTokens(str) {
      return str.replace(tagRe(), function (m, key) {
        var e = map[key];
        if (!e) return m;
        return e.type === "link" ? e.href : e.value;
      });
    }

    function hrefWantsNewTab(str) {
      var re = tagRe();
      var m;
      while ((m = re.exec(str))) {
        var e = map[m[1]];
        if (e && e.type === "link" && e.nt) return true;
      }
      return false;
    }

    function hasKnownTag(str) {
      var re = tagRe();
      var m;
      while ((m = re.exec(str))) {
        if (Object.prototype.hasOwnProperty.call(map, m[1])) return true;
      }
      return false;
    }

    function insideAnchor(node) {
      var p = node.parentElement;
      while (p) {
        if (p.tagName === "A") return true;
        p = p.parentElement;
      }
      return false;
    }

    function hasWrappableLink(str) {
      var re = tagRe();
      var m;
      while ((m = re.exec(str))) {
        var e = map[m[1]];
        if (e && (e.type === "link" || (e.type === "rich" && e.html))) return true;
      }
      return false;
    }

    /**
     * Transform one text node. Plain path: token swap in place. If the node
     * holds a link-type tag and is NOT already inside an <a>, the node is
     * split and the tag becomes a real anchor: <a href class="oscms-a">.
     */
    function transformTextNode(node) {
      var s = node.nodeValue;
      if (!hasWrappableLink(s) || insideAnchor(node) || !node.parentNode) {
        if (record && seenText && !seenText.has(node)) {
          seenText.add(node);
          textLog.push({ node: node, original: s });
        }
        node.nodeValue = swapTokens(s);
        return;
      }
      var frag = doc.createDocumentFragment();
      var re = tagRe();
      var idx = 0;
      var m;
      while ((m = re.exec(s))) {
        var e = map[m[1]];
        if (!e) continue; // unknown tag text survives in the surrounding slices
        if (m.index > idx) frag.appendChild(doc.createTextNode(swapTokens(s.slice(idx, m.index))));
        if (e.type === "link") {
          var a = doc.createElement("a");
          a.className = "oscms-a";
          if (e.href) a.setAttribute("href", e.href);
          if (e.nt) {
            a.setAttribute("target", "_blank");
            a.setAttribute("rel", "noopener");
          }
          a.textContent = e.value;
          frag.appendChild(a);
        } else if (e.type === "rich" && e.html) {
          // formatted value: a span carrying the sanitized HTML (bold, links, breaks, lists)
          var sp = doc.createElement("span");
          sp.className = "oscms-rich";
          sp.innerHTML = e.html;
          frag.appendChild(sp);
        } else {
          frag.appendChild(doc.createTextNode(e.value));
        }
        idx = m.index + m[0].length;
      }
      if (idx < s.length) frag.appendChild(doc.createTextNode(swapTokens(s.slice(idx))));
      var inserted = [].slice.call(frag.childNodes);
      node.parentNode.replaceChild(frag, node);
      if (record) wrapLog.push({ inserted: inserted, original: node });
    }

    /** data-oscms-show="{{slug.field_N}}" hides the element while the toggle
     *  is off; data-oscms-hide does the opposite. Works inside repeaters
     *  (the _i index is rewritten with the rest of the template). */
    function processToggles(scope) {
      var els = scope.querySelectorAll ? scope.querySelectorAll("[data-oscms-show],[data-oscms-hide]") : [];
      for (var i = 0; i < els.length; i++) {
        var el = els[i], show = el.hasAttribute("data-oscms-show");
        var key = firstTagIn(el.getAttribute(show ? "data-oscms-show" : "data-oscms-hide") || "");
        var e = key && map[key];
        if (!e || e.type !== "toggle") continue;
        var hide = show ? !e.on : !!e.on;
        var cur = el.getAttribute("data-oscms-hidden");
        if (hide && cur !== "1") { recordAttr(el, "hidden"); recordAttr(el, "data-oscms-hidden"); el.setAttribute("hidden", ""); el.setAttribute("data-oscms-hidden", "1"); }
        else if (!hide && cur === "1") { el.removeAttribute("hidden"); el.removeAttribute("data-oscms-hidden"); }
      }
    }

    function recordAttr(el, attr) {
      if (!record) return;
      attrLog.push({ el: el, attr: attr, original: el.getAttribute(attr) });
    }

    // v31: a static data-oscms-format="500w" on the <img> (or any ancestor)
    // appends Squarespace's CDN resize param to swapped image URLs, so a
    // 48px thumb stops downloading the multi-megapixel original. Values:
    // 100w/300w/500w/750w/1000w/1500w/2500w/original. Never applied to
    // non-Squarespace URLs or URLs that already carry a format param.
    function oscmsFormatFor(el) {
      var n = el;
      while (n && n.getAttribute) {
        var f = n.getAttribute("data-oscms-format");
        if (f) return f;
        n = n.parentElement;
      }
      return null;
    }
    function withOscmsFormat(el, url) {
      var f = oscmsFormatFor(el);
      if (!f || !url) return url;
      if (!/^(\d+w|original)$/.test(f)) return url;
      if (url.indexOf("squarespace-cdn.com") === -1 && url.indexOf("/content/v1/") === -1) return url;
      if (/[?&]format=/.test(url)) return url;
      return url + (url.indexOf("?") === -1 ? "?" : "&") + "format=" + f;
    }

    function replaceSrcLike(el, attr, value) {
      if (!el.hasAttribute(attr)) return;
      var raw = el.getAttribute(attr);
      var dec = maybeDecode(raw);
      if (dec.indexOf("{{") === -1 || !hasKnownTag(dec)) return;
      var key = firstTagIn(dec);
      if (!key || !map[key]) return;
      recordAttr(el, attr);
      el.setAttribute(attr, withOscmsFormat(el, map[key].value));
      return true;
    }

    function processImg(el) {
      var swapped = false;
      ["src", "data-src", "data-image"].forEach(function (a) {
        if (replaceSrcLike(el, a, null)) swapped = true;
      });
      // alt === image tag → author signal to swap this img's source
      var alt = el.getAttribute("alt");
      if (!swapped && alt) {
        var key = firstTagIn(alt.trim());
        if (key && map[key] && map[key].type === "image" && alt.trim().replace(tagRe(), "") === "") {
          ["src", "data-src", "data-image"].forEach(function (a) {
            if (el.hasAttribute(a)) {
              recordAttr(el, a);
              el.setAttribute(a, withOscmsFormat(el, map[key].value));
            }
          });
          swapped = true;
        }
      }
      if (swapped) {
        ["srcset", "sizes"].forEach(function (a) {
          if (el.hasAttribute(a)) {
            recordAttr(el, a);
            el.removeAttribute(a);
          }
        });
      }
      // token-level alt text replacement (text tags in alt)
      if (alt && alt.indexOf("{{") !== -1 && hasKnownTag(alt)) {
        var next = swapTokens(alt);
        if (next !== alt) {
          recordAttr(el, "alt");
          el.setAttribute("alt", next);
        }
      }
    }

    function processAttributes(root) {
      var scope = root && root.querySelectorAll ? root : doc;
      var imgs = scope.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) processImg(imgs[i]);

      var sources = scope.querySelectorAll("source[srcset]");
      for (var s = 0; s < sources.length; s++) {
        var dec = maybeDecode(sources[s].getAttribute("srcset"));
        if (dec.indexOf("{{") !== -1 && hasKnownTag(dec)) {
          recordAttr(sources[s], "srcset");
          sources[s].removeAttribute("srcset");
        }
      }

      var links = scope.querySelectorAll("a[href]");
      for (var l = 0; l < links.length; l++) {
        var href = links[l].getAttribute("href");
        var decH = maybeDecode(href);
        if (decH.indexOf("{{") === -1 || !hasKnownTag(decH)) continue;
        recordAttr(links[l], "href");
        links[l].setAttribute("href", swapHrefTokens(decH));
        if (hrefWantsNewTab(decH)) {
          recordAttr(links[l], "target");
          recordAttr(links[l], "rel");
          links[l].setAttribute("target", "_blank");
          links[l].setAttribute("rel", "noopener");
        }
      }
    }

    function processTextNodes(root) {
      var base = root && root.nodeType === 1 ? root : doc.body;
      if (!base) return 0;
      var walker = doc.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (node.nodeValue.indexOf("{{") === -1) return NodeFilter.FILTER_REJECT;
          var p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var t = p.tagName;
          if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT" || t === "TEXTAREA") {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      var nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      var count = 0;
      nodes.forEach(function (node) {
        if (!hasKnownTag(node.nodeValue)) return;
        transformTextNode(node);
        count++;
      });
      return count;
    }

    /** _xx -> _N page-index rewrite, folded into the pipeline so the
     *  whole chain (detect -> rewrite -> resolve) lives in one script.
     *  The external footer rewriter remains harmless if present. */
    function rewritePageIndex(scope) {
      var n = parseInt(window.APS_PAGE_INDEX, 10);
      if (!n || n < 1 || !scope) return;
      var suffix = "_" + n + "}}";
      try {
        var walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
          acceptNode: function (t) {
            return t.nodeValue.indexOf("_xx}}") !== -1
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        });
        var nodes = [], t;
        while ((t = walker.nextNode())) nodes.push(t);
        for (var i = 0; i < nodes.length; i++) {
          nodes[i].nodeValue = nodes[i].nodeValue.split("_xx}}").join(suffix);
        }
        var attrs = ["href", "src", "alt", "data-src", "data-image", "srcset"];
        var sel =
          "a[href*='_xx}}'],img[src*='_xx}}'],img[alt*='_xx}}'],img[data-src*='_xx}}'],img[data-image*='_xx}}'],source[srcset*='_xx}}']";
        var els = scope.querySelectorAll ? scope.querySelectorAll(sel) : [];
        for (var k = 0; k < els.length; k++) {
          for (var a = 0; a < attrs.length; a++) {
            var v = els[k].getAttribute(attrs[a]);
            if (v && v.indexOf("_xx}}") !== -1) {
              els[k].setAttribute(attrs[a], v.split("_xx}}").join(suffix));
            }
          }
        }
      } catch (e) {}
    }

    function run(root) {
      try {
        var scope = root && root.nodeType === 1 ? root : doc.body || doc;
        expandRepeaters(scope);
        rewritePageIndex(scope);
        var n = processTextNodes(root);
        processAttributes(root && root.nodeType === 1 ? root : doc);
        processToggles(root && root.nodeType === 1 ? root : doc);
        if (n) { statusCounts.replaced += n; log("replaced tags in " + n + " text node(s)"); }
      } catch (e) {
        log("replace failed:", e);
      }
    }

    /** Put every recorded original back (editor preview → edit mode). */
    function restore() {
      try {
        var stamped = doc.querySelectorAll("[data-oscms-from]");
        for (var s = stamped.length - 1; s >= 0; s--) {
          if (stamped[s].parentNode) stamped[s].parentNode.removeChild(stamped[s]);
        }
        var tpls = doc.querySelectorAll("template[data-oscms-count]");
        for (var tt = 0; tt < tpls.length; tt++) tpls[tt].removeAttribute("data-oscms-count");
      } catch (e) {}
      for (var w = wrapLog.length - 1; w >= 0; w--) {
        var entry = wrapLog[w];
        try {
          var anchorNode = entry.inserted[0];
          if (anchorNode && anchorNode.parentNode) {
            anchorNode.parentNode.insertBefore(entry.original, anchorNode);
            entry.inserted.forEach(function (n) {
              if (n.parentNode) n.parentNode.removeChild(n);
            });
          }
        } catch (e) {}
      }
      wrapLog = [];
      for (var i = textLog.length - 1; i >= 0; i--) {
        try {
          textLog[i].node.nodeValue = textLog[i].original;
        } catch (e) {}
      }
      textLog = [];
      seenText = typeof WeakSet !== "undefined" ? new WeakSet() : null;
      for (var j = attrLog.length - 1; j >= 0; j--) {
        var a = attrLog[j];
        try {
          if (a.original == null) a.el.removeAttribute(a.attr);
          else a.el.setAttribute(a.attr, a.original);
        } catch (e) {}
      }
      attrLog = [];
    }

    /** Where the swapped VALUES sit right now — for the "highlight" page view.
     *  Text: [start,end) ranges inside recorded text nodes, derived from the
     *  original string + the current map (verified against the live text).
     *  Elements: anchors we created, and img/a whose attributes we swapped. */
    function valueSpots() {
      var ranges = [], els = [];
      textLog.forEach(function (t) {
        var node = t.node;
        if (!node || !node.isConnected) return;
        var out = 0, prev = 0, re = tagRe(), m, orig = t.original;
        while ((m = re.exec(orig))) {
          var e = map[m[1]];
          if (!e) continue;
          out += m.index - prev;
          var v = String(e.value || "");
          if (node.nodeValue.substr(out, v.length) === v && v.length) ranges.push({ node: node, start: out, end: out + v.length, type: e.type, key: m[1] });
          out += v.length;
          prev = m.index + m[0].length;
        }
      });
      wrapLog.forEach(function (w) {
        w.inserted.forEach(function (n) {
          if (!n.isConnected) return;
          if (n.nodeType === 1 && n.classList && n.classList.contains("oscms-a")) els.push({ el: n, type: "link" });
          else if (n.nodeType === 1 && n.classList && n.classList.contains("oscms-rich")) els.push({ el: n, type: "text" });
          else if (n.nodeType === 3) {
            for (var k in map) {
              if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
              var v2 = String(map[k].value || ""); if (v2.length < 2) continue;
              var at = n.nodeValue.indexOf(v2);
              if (at !== -1) ranges.push({ node: n, start: at, end: at + v2.length, type: map[k].type, key: k });
            }
          }
        });
      });
      attrLog.forEach(function (a) {
        if (!a.el || !a.el.isConnected) return;
        if (a.attr === "src" || a.attr === "data-src" || a.attr === "data-image") els.push({ el: a.el, type: "image" });
        else if (a.attr === "href") els.push({ el: a.el, type: "link" });
      });
      return { ranges: ranges, els: els };
    }

    return { setMap: setMap, run: run, restore: restore, getMap: function () { return map; }, valueSpots: valueSpots };
  }

  /** Debounced observer that re-runs `fn` whenever Squarespace renders. */
  function observeRenders(doc, fn) {
    if (typeof MutationObserver === "undefined" || !doc.body) return null;
    var t = null;
    var mo = new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(fn, 60);
    });
    mo.observe(doc.body, { childList: true, subtree: true, characterData: true });
    return mo;
  }

  /* ====================================================================
   * 04. LIVE SITE boot (loader path)
   *
   * v3 data blocks carry their own inline runtime that runs during page
   * parse (window.__osCMSInline flag). The loader defers one tick and
   * skips if the inline runtime is present, so nothing runs twice. This
   * path still fully serves v1/v2 data blocks that lack the inline copy.
   * ================================================================== */
  /** URL -> page index: if this page's path exactly matches a *_page /
   *  page link field in the map, derive window.APS_PAGE_INDEX from it and
   *  announce it. Manual APS_PAGE_INDEX (header injection) always wins.
   *  Runs in BOTH the live boot and the editor preview path so the config
   *  preview matches the published site. */
  function deriveIndexFromMap(map) {
    try {
      if (window.APS_PAGE_INDEX || !map) return;
      var here = location.pathname.replace(/\/+$/, "").toLowerCase() || "/";
      var best = null; // { index, own }
      for (var mk in map) {
        if (!Object.prototype.hasOwnProperty.call(map, mk)) continue;
        var pm = /^([a-z0-9_-]+)\.([a-z0-9_-]+)_(\d+)$/.exec(mk);
        if (!pm) continue;
        var e = map[mk];
        if (!e || e.type !== "link" || !e.href) continue;
        var isPageField = /page$/.test(pm[2]);
        if (!isPageField && String(e.href).charAt(0) !== "/") continue; // *page fields, or any internal link
        var hp = String(e.href).split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase() || "/";
        if (hp !== here) continue;

        /* Own-page vs reference: many items carry links TO other pages
         * (every Skin service's category_page points at /procedures/skin).
         * A field is an item's OWN page only when its name matches its
         * collection - service_page on services, category_page on
         * categories, plain page on surgeons. Own-page matches win. */
        var slug = pm[1];
        var field = pm[2];
        var singular = slug.replace(/ies$/, "y").replace(/s$/, "");
        var own = field === "page" || field.indexOf(singular) === 0;
        if (!best || (own && !best.own)) {
          best = { index: parseInt(pm[3], 10), own: own };
          if (own) break; // an own-page match is definitive
        }
      }
      if (best) {
        window.APS_PAGE_INDEX = best.index;
        try {
          document.dispatchEvent(new CustomEvent("oscms:pageindex", { detail: { index: best.index } }));
        } catch (e2) {}
        log("page index " + best.index + " derived from URL " + here + (best.own ? "" : " (reference match)"));
      }
    } catch (e3) {}
  }

  function bootLive() {
    setTimeout(function () {
      if (window.__osCMSInline) {
        // Legacy inline runtime (pre-repeater, pre-URL-detection) from an
        // older sync payload. The loader now owns the live site — proceed.
        // Its replacements are consume-once, so overlap is harmless; the
        // next sync writes a data-only block and it disappears entirely.
        log("legacy inline runtime detected — loader taking over");
      }
      var replacer = createReplacer(document, { record: true });
      var lastView = null;
      var run = function () {
        var data = window[DATA_GLOBAL];
        var view = pageView(document);
        if (data) {
          var liveMap = buildTagMap(data, location.pathname);
          deriveIndexFromMap(liveMap);
          replacer.setMap(liveMap);
          if (view === "tags") {
            // Studio asked for the source view: raw tags, color-coded
            clearValueSpots(document);
            replacer.restore();
            injectHighlightStyles(document);
            refreshHighlights(liveMap, document);
          } else {
            if (lastView === "tags") clearHighlights(document);
            replacer.run();
            if (view === "highlight") { injectHighlightStyles(document); paintValueSpots(document, replacer); }
            else if (lastView === "highlight") clearValueSpots(document);
          }
          lastView = view;
        }
        stampStatus(document, "live", { hasData: !!data });
        try {
          document.documentElement.classList.remove("oscms-cloak");
        } catch (e) {}
      };
      run();
      observeView(document, run);
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", run, { once: true });
      }
      window.addEventListener("load", run);
      window.addEventListener("mercury:load", run);
      if (document.body) observeRenders(document, run);
      else
        document.addEventListener(
          "DOMContentLoaded",
          function () {
            observeRenders(document, run);
          },
          { once: true }
        );
    }, 0);
  }
  /* ====================================================================
   * 04.5 Page views — driven by SquareCMS Studio through one attribute:
   *   <html data-oscms-view="values|highlight|tags">
   *   values    → what visitors see (default)
   *   highlight → values stay, every CMS-driven word/image/link is tinted
   *   tags      → the raw {{tags}} in place, color-coded by field type
   * ================================================================== */
  function pageView(doc) {
    var v = doc.documentElement.getAttribute("data-oscms-view");
    return v === "highlight" || v === "tags" ? v : "values";
  }
  function observeView(doc, fn) {
    try {
      new MutationObserver(fn).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-oscms-view"] });
    } catch (e) {}
  }
  var decorated = [];
  function paintValueSpots(doc, replacer) {
    clearValueSpots(doc);
    var spots = replacer.valueSpots();
    if (highlightsSupported()) {
      var groups = { text: [], link: [], image: [] };
      spots.ranges.forEach(function (r) {
        try { var rg = doc.createRange(); rg.setStart(r.node, r.start); rg.setEnd(r.node, r.end); (groups[r.type] || groups.text).push(rg); } catch (e) {}
      });
      ["text", "link", "image"].forEach(function (g) {
        try {
          if (groups[g].length) { var hl = new Highlight(); groups[g].forEach(function (r) { hl.add(r); }); CSS.highlights.set("oscms-" + g, hl); }
          else CSS.highlights.delete("oscms-" + g);
        } catch (e) {}
      });
    }
    spots.els.forEach(function (x) {
      try { x.el.classList.add(x.type === "image" ? "oscms-hl-img" : x.type === "text" ? "oscms-hl-rich" : "oscms-hl-a"); decorated.push(x.el); } catch (e) {}
    });
  }
  function clearValueSpots(doc) {
    clearHighlights(doc);
    decorated.forEach(function (el) { try { el.classList.remove("oscms-hl-img", "oscms-hl-a", "oscms-hl-rich"); } catch (e) {} });
    decorated = [];
  }

  /* ====================================================================
   * 05. Editor gate
   * ================================================================== */
  var T;
  try {
    var maybeTop = window.top;
    if (
      maybeTop &&
      maybeTop !== window &&
      maybeTop.location &&
      /\/config(\/|$|\?)/.test(maybeTop.location.pathname + maybeTop.location.search) &&
      maybeTop.document &&
      maybeTop.document.body
    ) {
      T = maybeTop;
    }
  } catch (e) {
    T = null; // cross-origin — behave as live site
  }

  if (!T) {
    bootLive();
    return;
  }

  var D = T.document; // editor chrome
  var P = document; // page being edited (this iframe)
  /* ====================================================================
   * 06. EDITOR PREVIEW runtime — replace ↔ restore + pill highlights
   *
   * Preview (browsing in /config): show real values, recording originals.
   * Edit mode (body.sqs-edit-mode-active / .sqs-edit-mode): restore raw
   * tags instantly (BEFORE anything can be serialized), then paint each
   * tag as a color-coded pill with the CSS Custom Highlight API — ranges
   * are presentation-only, the DOM text stays exactly what you typed.
   * ================================================================== */
  function isEditModeBody() {
    // NOTE: `sqs-edit-mode` sits on the preview body the entire time you're
    // inside /config; `sqs-edit-mode-active` appears only while actually
    // editing. Only the latter means "restore raw tags + show pills".
    var b = P.body;
    return !!(b && b.classList.contains("sqs-edit-mode-active"));
  }

  var HIGHLIGHT_CSS =
    "::highlight(oscms-text){background-color:#dbeafe;color:#1e40af}" +
    ".oscms-hl-rich{outline:2px solid #3b7ee0;outline-offset:1px;border-radius:2px;background:#dbeafe}" +
    "::highlight(oscms-link){background-color:#ede9fe;color:#6d28d9}" +
    "::highlight(oscms-image){background-color:#fef3c7;color:#92400e}" +
    "::highlight(oscms-unknown){background-color:#fee2e2;color:#b91c1c}" +
    "::highlight(oscms-global){background-color:#d9f74e;color:#3f4410}" +
    ".oscms-hl-img{outline:3px solid #d97706!important;outline-offset:3px;border-radius:4px}" +
    ".oscms-hl-a{outline:2px solid #7c3aed!important;outline-offset:2px;border-radius:3px}";

  function highlightsSupported() {
    try {
      return typeof Highlight !== "undefined" && typeof CSS !== "undefined" && CSS.highlights;
    } catch (e) {
      return false;
    }
  }

  function injectHighlightStyles(doc) {
    doc = doc || P;
    if (doc.getElementById("oscms-hl-styles")) return;
    var s = doc.createElement("style");
    s.id = "oscms-hl-styles";
    s.textContent = HIGHLIGHT_CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function refreshHighlights(map, doc) {
    var P = doc || window.__osCMSPreviewDoc;
    if (!highlightsSupported() || !P || !P.body) return;
    var groups = { text: [], link: [], image: [], unknown: [], global: [] };
    var walker = P.createTreeWalker(P.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        return node.nodeValue.indexOf("{{") !== -1
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    var node;
    while ((node = walker.nextNode())) {
      var re = tagRe();
      var m;
      while ((m = re.exec(node.nodeValue))) {
        try {
          var r = P.createRange();
          r.setStart(node, m.index);
          r.setEnd(node, m.index + m[0].length);
          var entry = map[m[1]];
          var g = entry ? (entry.type === "link" || entry.type === "image" ? entry.type : "text") : /_(?:xx|i)$/i.test(m[1]) ? "global" : "unknown";
          groups[g].push(r);
        } catch (e) {}
      }
    }
    ["text", "link", "image", "unknown", "global"].forEach(function (g) {
      try {
        if (groups[g].length) {
          var hl = new Highlight();
          groups[g].forEach(function (r) {
            hl.add(r);
          });
          CSS.highlights.set("oscms-" + g, hl);
        } else {
          CSS.highlights.delete("oscms-" + g);
        }
      } catch (e) {}
    });
  }

  function clearHighlights(doc) {
    if (!highlightsSupported()) return;
    ["text", "link", "image", "unknown", "global"].forEach(function (g) {
      try {
        CSS.highlights.delete("oscms-" + g);
      } catch (e) {}
    });
  }

  function bootEditorPreview() {
    window.__osCMSPreviewDoc = P;
    injectHighlightStyles(P);
    var replacer = createReplacer(P, { record: true });

    /* Preview renders the DRAFT (top localStorage) so widget edits show up
     * live without a sync; published data is the fallback. The live site
     * only ever sees published data — this is editor-side sugar. */
    function draftCollections() {
      try {
        var raw = T.localStorage.getItem(STORE_KEY);
        if (!raw) return null;
        var s = JSON.parse(raw);
        var cols = s && s.draft && s.draft.collections;
        return cols && cols.length ? cols : null;
      } catch (e) {
        return null;
      }
    }
    function currentData() {
      var dc = draftCollections();
      if (dc) return { collections: dc };
      return publishedData();
    }

    var scopedMap = {};
    var pillMap = {};
    var lastJson = null;

    /** Rebuild maps when the underlying data changed. Returns true if so. */
    function refreshData() {
      var d = currentData();
      var j = JSON.stringify((d && d.collections) || []);
      if (j === lastJson) return false;
      lastJson = j;
      // Replacement respects page scoping (preview mirrors the live page);
      // pills use the UNSCOPED map so out-of-scope tags keep their field
      // color while editing instead of reading as unknown.
      scopedMap = buildTagMap(d, P.location.pathname);
      pillMap = buildTagMap(d, null);
      return true;
    }

    var mode = null;

    /** Every tag present on the page that the (unscoped) data can't
     *  resolve — the widget home turns this into a warning card.
     *  v29: each occurrence also records WHERE it was found (node ref,
     *  kind, nearest section/block anchor, text snippet) so the panel's
     *  Locate button can scroll the preview to it and flash it. */
    function scanUnknown() {
      var out = {};
      var spots = {};
      function anchorFor(ref) {
        var el = ref && ref.nodeType === 3 ? ref.parentElement : ref;
        if (!el || !el.closest) return "page";
        var parts = [];
        var section = el.closest("section[id], [data-section-id]");
        if (section) {
          parts.push(
            section.id
              ? "#" + section.id
              : "section \u2026" + String(section.getAttribute("data-section-id") || "").slice(-6)
          );
        }
        var block = el.closest('[id^="block-"]');
        if (block) parts.push("#" + block.id);
        return parts.join(" \u203a ") || "page";
      }
      function snippetFor(str, key) {
        var idx = str.indexOf("{{" + key);
        if (idx === -1) return "";
        var from = Math.max(0, idx - 28);
        var to = Math.min(str.length, idx + key.length + 32);
        return (
          (from > 0 ? "\u2026" : "") +
          str.slice(from, to).replace(/\s+/g, " ").trim() +
          (to < str.length ? "\u2026" : "")
        );
      }
      function note(str, ref, kind) {
        if (!str || str.indexOf("{{") === -1) return;
        var re = tagRe();
        var m;
        while ((m = re.exec(str))) {
          if (/_(?:xx|i)$/i.test(m[1])) continue; // _xx page-index / _i repeater — intentional global tags
          if (pillMap[m[1]]) continue;
          out[m[1]] = true;
          (spots[m[1]] = spots[m[1]] || []).push({
            ref: ref || null,
            kind: kind || "text",
            anchor: anchorFor(ref),
            snippet: snippetFor(str, m[1]),
          });
        }
      }
      try {
        if (P.body) {
          var w = P.createTreeWalker(P.body, NodeFilter.SHOW_TEXT, {
            acceptNode: function (n) {
              if (n.nodeValue.indexOf("{{") === -1) return NodeFilter.FILTER_REJECT;
              // v30: code text isn't content — scripts land in <body> when a
              // custom element closes <head> early, and their comments can
              // legitimately mention {{tags}}.
              var pe = n.parentElement;
              var tg = pe && pe.tagName;
              if (tg === "SCRIPT" || tg === "STYLE" || tg === "NOSCRIPT" || tg === "TEXTAREA")
                return NodeFilter.FILTER_REJECT;
              return NodeFilter.FILTER_ACCEPT;
            },
          });
          var n;
          while ((n = w.nextNode())) note(n.nodeValue, n, "text");
          var imgs = P.querySelectorAll("img");
          for (var i = 0; i < imgs.length; i++) {
            note(maybeDecode(imgs[i].getAttribute("src") || ""), imgs[i], "img src");
            note(maybeDecode(imgs[i].getAttribute("data-src") || ""), imgs[i], "img src");
            note(imgs[i].getAttribute("alt") || "", imgs[i], "img alt");
          }
          var links = P.querySelectorAll("a[href]");
          for (var l = 0; l < links.length; l++) {
            note(maybeDecode(links[l].getAttribute("href") || ""), links[l], "link href");
          }
        }
      } catch (e) {}
      window.__osCMSUnknownTags = Object.keys(out);
      window.__osCMSUnknownSpots = spots;
    }

    var lastView = null;
    function afterRun() {
      // "highlight" page view: tint the swapped values in place
      if (pageView(P) === "highlight") paintValueSpots(P, replacer);
      else if (lastView === "highlight") clearValueSpots(P);
      lastView = pageView(P);
    }
    function sync() {
      var changed = refreshData();
      // Studio's "tags" page view behaves exactly like Squarespace's block
      // edit mode: raw tags in the DOM, painted as color-coded pills.
      var next = isEditModeBody() || pageView(P) === "tags" ? "edit" : "preview";
      if (next !== mode) {
        mode = next;
        if (mode === "edit") {
          clearValueSpots(P);
          replacer.restore(); // raw tags back BEFORE any serialization
          refreshHighlights(pillMap);
          log("edit mode — raw tags restored, pills on");
          stampStatus(P, "edit");
        } else {
          clearHighlights(P);
          deriveIndexFromMap(scopedMap);
          replacer.setMap(scopedMap);
          replacer.run();
          afterRun();
          log("preview mode — values shown");
          stampStatus(P, "preview");
        }
        scanUnknown();
        return;
      }
      if (changed) {
        if (mode === "edit") {
          refreshHighlights(pillMap);
        } else {
          replacer.restore(); // swap old values out, new draft values in
          deriveIndexFromMap(scopedMap);
          replacer.setMap(scopedMap);
          replacer.run();
          afterRun();
          log("draft changed — preview refreshed");
          stampStatus(P, "preview");
        }
        scanUnknown();
        return;
      }
      // steady-state upkeep as Squarespace re-renders
      if (mode === "edit") refreshHighlights(pillMap);
      else { replacer.run(); afterRun(); }
      scanUnknown();
      stampStatus(P, mode);
    }

    sync();
    observeView(P, sync);
    observeRenders(P, sync);
    if (typeof MutationObserver !== "undefined" && P.body) {
      new MutationObserver(sync).observe(P.body, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    window.addEventListener("mercury:load", sync);
    // Widget edits land in top localStorage → storage event fires in this
    // iframe; a slow interval covers browsers/timing the event misses.
    window.addEventListener("storage", function (e) {
      if (!e || !e.key || e.key === STORE_KEY) sync();
    });
    setInterval(sync, 900);
  }
  /* ====================================================================
   * 07. Published data + draft (the Studio extension mirrors its draft
   *     into top-window localStorage["osCMSEditor"] while you edit)
   * ================================================================== */
  function publishedData() {
    try { return window[DATA_GLOBAL] || null; } catch (e) { return null; }
  }

  /* ====================================================================
   * 08. Boot (editor) — preview only; no panel, no toolbar button
   * ================================================================== */
  bootEditorPreview();
  log("editor preview booted on", P.location.pathname);
})();
