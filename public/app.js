/**
 * Same-origin when the Express server is serving this file (local dev, Render),
 * cross-origin only when the static build is hosted separately (Vercel).
 * Hardcoding the Render URL unconditionally made local development hit
 * production.
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

let pending = false;

/**
 * Guarded binding.
 *
 * The previous version did `crawlBtn.addEventListener(...)` on an element that
 * is commented out in index.html. The resulting TypeError aborted the rest of
 * the script, which is why the Enter key and the status check silently stopped
 * working -- only the hoisted function declarations survived.
 */
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
  return el;
}

async function checkStatus() {
  if (!statusText) return;
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    const indexed = data?.checks?.database?.indexed;

    if (data.status === 'unhealthy') {
      statusText.textContent = `Database unavailable — ${data.checks.database.detail}`;
      statusText.className = 'empty';
    } else if (indexed > 0) {
      statusText.textContent = `Ready — ${indexed} law chunks indexed`;
      statusText.className = 'ready';
    } else {
      statusText.textContent = 'No laws indexed yet';
      statusText.className = 'empty';
    }
  } catch (err) {
    statusText.textContent = `Server not reachable: ${err.message}`;
    statusText.className = 'empty';
  }
}

function useExample(btn) {
  input.value = btn.textContent;
  input.focus();
}

async function askQuestion() {
  const question = input.value.trim();
  if (!question || pending) return;

  const welcome = chat.querySelector('.welcome-message');
  if (welcome) welcome.remove();

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
      addAssistantMessage(data.answer, data.sources, data.usedWebSearch);
    }
  } catch (err) {
    loadingEl.remove();
    addError(`Network error: ${err.message}`);
  } finally {
    pending = false;
    askBtn.disabled = false;
    input.focus();
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
  const div = document.createElement('div');
  div.className = 'message assistant';
  const hint =
    code === 'schema_missing'
      ? '<p class="error-hint">The database schema has not been applied. Run <code>supabase/schema.sql</code>.</p>'
      : code === 'rate_limited'
        ? '<p class="error-hint">Too many questions in a short window — give it a moment.</p>'
        : '';
  div.innerHTML = `<div class="bubble error-bubble"><strong>Something went wrong.</strong><br>${escapeHtml(message)}${hint}</div>`;
  chat.appendChild(div);
  scrollToBottom();
}

/**
 * Renders the retrieved passages alongside the answer. The API always returned
 * `sources`, but the old UI dropped them on the floor -- which removed the one
 * thing that lets a reader verify a RAG answer instead of trusting it.
 */
function renderSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';

  const items = sources
    .map((s) => {
      const label = [s.law, s.source].filter(Boolean).map(escapeHtml).join(' — ');
      const title = s.url
        ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
      return `
        <li>
          <span class="cite-num">[${s.n}]</span>
          <div class="cite-body">
            <div class="cite-title">${title}</div>
            <p class="cite-snippet">${escapeHtml(s.snippet)}</p>
          </div>
        </li>`;
    })
    .join('');

  return `
    <details class="sources">
      <summary>${sources.length} source passage${sources.length === 1 ? '' : 's'}</summary>
      <ol class="source-list">${items}</ol>
    </details>`;
}

function addAssistantMessage(answer, sources, usedWebSearch) {
  const div = document.createElement('div');
  div.className = 'message assistant';

  const badge = usedWebSearch
    ? '<span class="web-badge">🌐 Live web search</span>'
    : '<span class="rag-badge">📖 Grounded in indexed laws</span>';

  // Highlight inline [n] citations so they visibly tie back to the source list.
  const body = escapeHtml(answer)
    .replace(/\[(\d+)\]/g, '<span class="inline-cite">[$1]</span>')
    .replace(/\n/g, '<br>');

  div.innerHTML = `
    <div class="bubble">
      ${badge}
      ${body}
      ${renderSources(sources)}
    </div>
  `;
  chat.appendChild(div);
  scrollToBottom();
}

function addLoading() {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `
    <div class="loading-bubble">
      <div class="dots"><span></span><span></span><span></span></div>
    </div>
  `;
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

on('question-input', 'keydown', (e) => {
  if (e.key === 'Enter' && !pending) askQuestion();
});
on('ask-btn', 'click', askQuestion);

checkStatus();
