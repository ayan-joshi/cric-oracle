const chat = document.getElementById('chat');
const input = document.getElementById('question-input');
const askBtn = document.getElementById('ask-btn');
const statusText = document.getElementById('status-text');
const crawlBtn = document.getElementById('crawl-btn');
const crawlModal = document.getElementById('crawl-modal');
const crawlProgress = document.getElementById('crawl-progress');

// Check index status on load
async function checkStatus() {
  try {
    const res = await fetch('/crawl/status');
    const data = await res.json();
    if (data.indexed > 0) {
      statusText.textContent = `Ready — ${data.indexed} law chunks indexed`;
      statusText.className = 'ready';
    } else {
      statusText.textContent = 'Not indexed yet — click "Index Laws" to start';
      statusText.className = 'empty';
    }
  } catch {
    statusText.textContent = 'Server not reachable';
  }
}

// Trigger crawl
crawlBtn.addEventListener('click', async () => {
  crawlModal.classList.remove('hidden');
  crawlBtn.disabled = true;

  try {
    const res = await fetch('/crawl', { method: 'POST' });
    const data = await res.json();

    if (data.success) {
      crawlProgress.textContent = `Done! ${data.stats.pages} pages, ${data.stats.chunks} chunks indexed.`;
      setTimeout(() => {
        crawlModal.classList.add('hidden');
        crawlBtn.disabled = false;
        checkStatus();
      }, 2000);
    } else {
      crawlProgress.textContent = `Error: ${data.error}`;
      crawlBtn.disabled = false;
    }
  } catch (err) {
    crawlProgress.textContent = `Failed: ${err.message}`;
    crawlBtn.disabled = false;
  }
});

// Use example question
function useExample(btn) {
  input.value = btn.textContent;
  input.focus();
}

// Ask question
async function askQuestion() {
  const question = input.value.trim();
  if (!question) return;

  // Clear welcome message on first question
  const welcome = chat.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  // Add user message
  addMessage('user', question);
  input.value = '';
  askBtn.disabled = true;

  // Add loading indicator
  const loadingEl = addLoading();

  try {
    const res = await fetch('/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();

    loadingEl.remove();

    if (data.error) {
      addMessage('assistant', `Error: ${data.error}`);
    } else {
      addAssistantMessage(data.answer);
    }
  } catch (err) {
    loadingEl.remove();
    addMessage('assistant', `Network error: ${err.message}`);
  } finally {
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

function addAssistantMessage(answer) {
  const div = document.createElement('div');
  div.className = 'message assistant';

  div.innerHTML = `
    <div class="bubble">
      ${escapeHtml(answer).replace(/\n/g, '<br>')}
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
      <div class="dots">
        <span></span><span></span><span></span>
      </div>
    </div>
  `;
  chat.appendChild(div);
  scrollToBottom();
  return div;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

// Enter key to submit
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !askBtn.disabled) {
    askQuestion();
  }
});

// Init
checkStatus();
