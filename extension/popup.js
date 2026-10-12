const SERVER = 'http://127.0.0.1:5000';
const $ = id => document.getElementById(id);
let video = null, cards = [];

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').className = isError ? 'error' : '';
}

async function post(path, body) {
  let res;
  try {
    res = await fetch(SERVER + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Cannot reach the local server. Start it with `python app.py`.');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/(www\.|m\.)?youtube\.com\/(watch|shorts\/|live\/)/.test(tab.url)) {
    setStatus('Open a YouTube video, then click the extension again.');
    return;
  }
  try {
    video = await (await post('/api/preview', { url: tab.url })).json();
  } catch (err) { setStatus(err.message, true); return; }

  $('thumb').src = video.thumbnail;
  $('title').textContent = video.title;
  $('author').textContent = `— ${video.author}`;
  $('preview').classList.remove('hidden');
  setStatus('');

  // Extraction can take a while; results are cached so closing the popup doesn't lose them.
  const cached = (await chrome.storage.session.get(video.id))[video.id];
  if (cached) { cards = cached; renderCards(); }
}

$('extract-btn').onclick = async () => {
  setStatus('Downloading subtitles and extracting vocabulary…');
  $('extract-btn').disabled = true;
  try {
    cards = (await (await post('/api/extract', { url: video.id })).json()).cards;
    await chrome.storage.session.set({ [video.id]: cards });
    renderCards();
    setStatus('');
  } catch (err) { setStatus(err.message, true); }
  $('extract-btn').disabled = false;
};

function renderCards() {
  const tbody = $('cards');
  tbody.innerHTML = '';
  cards.forEach((c, i) => {
    const tr = document.createElement('tr');
    for (const [cls, text] of [['', ''], ['word', c.word], ['', c.reading], ['', c.meaning]]) {
      const td = document.createElement('td');
      td.className = cls;
      td.textContent = text;
      tr.appendChild(td);
    }
    tr.title = c.sentence;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = true; cb.dataset.index = i;
    cb.onchange = updateCount;
    tr.firstChild.appendChild(cb);
    tbody.appendChild(tr);
  });
  $('results').classList.remove('hidden');
  updateCount();
}

const checkboxes = () => [...document.querySelectorAll('#cards input[type=checkbox]')];
const selectedCards = () => checkboxes().filter(cb => cb.checked).map(cb => cards[cb.dataset.index]);

function updateCount() {
  $('count').textContent = `${selectedCards().length} of ${cards.length} cards selected`;
}

$('toggle-all').onclick = () => {
  const allChecked = checkboxes().every(cb => cb.checked);
  checkboxes().forEach(cb => cb.checked = !allChecked);
  updateCount();
};

document.querySelectorAll('.export').forEach(btn => btn.onclick = async () => {
  try {
    const res = await post('/api/export', { cards: selectedCards(), title: video.title, format: btn.dataset.format });
    const disposition = res.headers.get('Content-Disposition') || '';
    const name = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || disposition.match(/filename="?([^";]+)/)?.[1];
    await chrome.downloads.download({
      url: URL.createObjectURL(await res.blob()),
      filename: name ? decodeURIComponent(name) : `vocab.${btn.dataset.format}`,
    });
  } catch (err) { setStatus(err.message, true); }
});

init();
