/**
 * Same-origin when Express serves this file (local dev, Render); cross-origin
 * only when the static build is hosted separately (Vercel). Hardcoding the
 * Render URL unconditionally made local development hit production.
 */
const API_BASE = (() => {
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.onrender.com')) return '';
  return 'https://cric-oracle.onrender.com';
})();

const chat = document.getElementById('chat');
const input = document.getElementById('question-input');
const askBtn = document.getElementById('ask-btn');
const statusText = document.getElementById('status-text');
const statusDot = document.getElementById('status-dot');

let pending = false;

/**
 * Guarded binding. The previous version called addEventListener on an element
 * that had been commented out of the markup; the TypeError aborted the rest of
 * the script, silently killing the Enter key and the status check.
 */
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
  return el;
}

function setStatus(text, state) {
  if (statusText) statusText.textContent = text;
  if (statusDot) statusDot.className = `dot ${state || ''}`.trim();
}

async function checkStatus() {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    const indexed = data?.checks?.database?.indexed;

    if (data.status === 'unhealthy') {
      setStatus('Database unavailable', 'down');
    } else if (indexed > 0) {
      setStatus(`${indexed.toLocaleString()} passages indexed`, 'ready');
    } else {
      setStatus('No passages indexed', 'empty');
    }
  } catch {
    setStatus('Server unreachable', 'down');
  }
}

function askExample(question) {
  input.value = question;
  askQuestion();
}

async function askQuestion() {
  const question = input.value.trim();
  if (!question || pending) return;

  // The intro is the empty state -- it goes once a conversation begins.
  const intro = document.getElementById('intro');
  if (intro) intro.remove();

  addMessage('user', question);
  input.value = '';
  pending = true;
  askBtn.disabled = true;

  const loadingEl = addLoading();

  try {
    const res = await fetch(`${API_BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    loadingEl.remove();

    if (!res.ok) {
      addError(data.error || `Request failed (${res.status})`, data.code);
    } else {
      addAssistantMessage(data);
    }
  } catch (err) {
    loadingEl.remove();
    addError(`Network error: ${err.message}`);
  } finally {
    pending = false;
    askBtn.disabled = false;
  }
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  chat.appendChild(div);
  scrollToBottom();
  return div;
}

function addError(message, code) {
  const hints = {
    schema_missing: 'The database schema has not been applied. Run <code>supabase/schema.sql</code>.',
    rate_limited: 'Too many questions in a short window — give it a moment.',
    crawl_disabled: 'Indexing is disabled because <code>CRAWL_SECRET</code> is not configured.',
  };
  const hint = hints[code] ? `<p class="error-hint">${hints[code]}</p>` : '';

  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `<div class="bubble error-bubble"><strong>Something went wrong.</strong><br>${escapeHtml(message)}${hint}</div>`;
  chat.appendChild(div);
  scrollToBottom();
}

/**
 * Renders the passages the answer was built from. The API always returned
 * `sources` and the old UI discarded them, removing the one thing that lets a
 * reader verify a RAG answer instead of trusting it.
 */
function renderSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';

  const items = sources
    .map((s) => {
      const label = [s.law, s.source].filter(Boolean).map(escapeHtml).join(' — ');
      const title = s.url
        ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
      return `<li>
          <span class="cite-num">[${s.n}]</span>
          <div class="cite-body">
            <div class="cite-title">${title}</div>
            <p class="cite-snippet">${escapeHtml(s.snippet)}</p>
          </div>
        </li>`;
    })
    .join('');

  return `<details class="disclosure">
      <summary>${sources.length} source passage${sources.length === 1 ? '' : 's'}</summary>
      <ol class="source-list">${items}</ol>
    </details>`;
}

/**
 * Surfaces what retrieval actually did. Without this the hybrid search,
 * query rewriting and reranking are entirely invisible to a visitor.
 */
function renderTrace(d) {
  if (!d) return '';

  const rows = [];
  if (d.rewrittenQuery) rows.push(['Search query', `<code>${escapeHtml(d.rewrittenQuery)}</code>`]);
  if (d.formatFilter) rows.push(['Format filter', escapeHtml(d.formatFilter.toUpperCase())]);
  if (d.candidates != null && d.used != null) {
    rows.push(['Retrieved', `${d.candidates} candidates → reranked to ${d.used}`]);
  }
  if (d.model) rows.push(['Model', escapeHtml(d.model)]);
  if (d.latencyMs != null) rows.push(['Latency', `${(d.latencyMs / 1000).toFixed(1)}s`]);
  if (d.degraded) rows.push(['Degraded', escapeHtml(d.degraded)]);

  if (rows.length === 0) return '';

  const body = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return `<details class="disclosure">
      <summary>Retrieval trace</summary>
      <dl class="trace">${body}</dl>
    </details>`;
}

function addAssistantMessage(data) {
  const div = document.createElement('div');
  div.className = 'message assistant';

  const badge = data.usedWebSearch
    ? '<span class="badge web">🌐 Live web search</span>'
    : '<span class="badge rag">📖 Grounded in indexed laws</span>';

  // Highlight inline [n] citations so they visibly tie back to the source list.
  const body = escapeHtml(data.answer)
    .replace(/\[(\d+)\]/g, '<span class="inline-cite">[$1]</span>')
    .replace(/\n/g, '<br>');

  div.innerHTML = `<div class="bubble">
      ${badge}
      ${body}
      ${renderSources(data.sources)}
      ${renderTrace(data.diagnostics)}
    </div>`;

  chat.appendChild(div);
  scrollToBottom();
}

function addLoading() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `<div class="loading-bubble">
      <div class="dots"><span></span><span></span><span></span></div>
    </div>`;
  chat.appendChild(div);
  scrollToBottom();
  return div;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

// Example buttons are bound by delegation so the intro can be removed and the
// handler never goes stale.
chat.addEventListener('click', (e) => {
  const btn = e.target.closest('.example-btn');
  if (btn) askExample(btn.textContent.trim());
});

on('question-input', 'keydown', (e) => {
  if (e.key === 'Enter' && !pending) askQuestion();
});
on('ask-btn', 'click', askQuestion);

checkStatus();
