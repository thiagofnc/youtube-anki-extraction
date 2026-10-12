const SERVER = 'http://127.0.0.1:5000';
const $ = id => document.getElementById(id);
let video = null;
let cards = [];       // [{word, reading, meaning, sentence, count, surface, selected}]

// ---------- Status ----------

function setStatus(msg, { error = false, busy = false } = {}) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', error);
  $('progress').hidden = !busy;
}

function showServerDown() {
  const status = $('status');
  const code = document.createElement('code');
  code.textContent = 'python app.py';
  status.replaceChildren('The local server isn’t running. Start it with ', code, ', then reopen this popup.');
  status.classList.add('error');
  $('progress').hidden = true;
}

class ServerDown extends Error {}

async function post(path, body) {
  let res;
  try {
    res = await fetch(SERVER + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ServerDown();
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status}).`);
  return res;
}

function handleError(err) {
  if (err instanceof ServerDown) showServerDown();
  else setStatus(err.message, { error: true });
}

// ---------- Video ----------

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/(www\.|m\.)?youtube\.com\/(watch|shorts\/|live\/)/.test(tab.url)) {
    setStatus('Open a YouTube video with Japanese subtitles, then click the extension again.');
    return;
  }
  setStatus('Looking up the video…', { busy: true });
  try {
    video = await (await post('/api/preview', { url: tab.url })).json();
  } catch (err) {
    handleError(err);
    return;
  }

  $('thumb').src = video.thumbnail;
  $('video-title').textContent = video.title;
  $('channel').textContent = video.author;
  $('full-page').href = `${SERVER}/?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${video.id}`)}`;
  $('video').hidden = $('extract-btn').hidden = $('full-page').hidden = false;
  setStatus('');

  // Extraction can take a while; results are cached so closing the popup doesn't lose them.
  const cached = (await chrome.storage.session.get(video.id))[video.id];
  if (cached) showCards(cached);
}

$('extract-btn').addEventListener('click', async () => {
  $('extract-btn').disabled = true;
  $('extract-btn').textContent = 'Extracting…';
  $('results').hidden = true;
  setStatus('Reading the subtitles and picking out vocabulary. Long videos take a little while.', { busy: true });
  try {
    const data = await (await post('/api/extract', { url: video.id })).json();
    const fresh = data.cards.map(c => ({ ...c, selected: true }));
    await chrome.storage.session.set({ [video.id]: fresh });
    showCards(fresh);
    setStatus(fresh.length ? '' : 'No vocabulary found in these subtitles.');
  } catch (err) {
    handleError(err);
  }
  $('extract-btn').disabled = false;
  $('extract-btn').textContent = 'Extract vocabulary';
});

function showCards(list) {
  cards = list;
  $('filter').value = '';
  renderList();
  $('results').hidden = cards.length === 0;
  $('extract-btn').hidden = cards.length > 0;
}

function saveSelection() {
  chrome.storage.session.set({ [video.id]: cards });
}

// ---------- Word list ----------

function headword(card) {
  const el = document.createElement('span');
  el.className = 'headword';
  el.lang = 'ja';
  if (card.reading && card.reading !== card.word) {
    const ruby = document.createElement('ruby');
    const rt = document.createElement('rt');
    rt.textContent = card.reading;
    ruby.append(card.word, rt);
    el.append(ruby);
  } else {
    el.textContent = card.word;
  }
  el.translate = false;  // keep page translators from rewriting the Japanese word
  return el;
}

function meaning(card) {
  // The server joins multiple senses as "1. … 2. …"; show them as a short list.
  const div = document.createElement('div');
  div.className = 'meaning';
  if (!card.meaning.startsWith('1. ')) {
    div.textContent = card.meaning;
    return div;
  }
  const ol = document.createElement('ol');
  for (const sense of card.meaning.split(/ (?=\d+\. )/)) {
    const li = document.createElement('li');
    li.textContent = sense.replace(/^\d+\.\s/, '');
    ol.append(li);
  }
  div.append(ol);
  return div;
}

function sentence(card) {
  const p = document.createElement('p');
  p.className = 'sentence';
  p.lang = 'ja';
  const at = card.surface ? card.sentence.indexOf(card.surface) : -1;
  if (at < 0) {
    p.textContent = card.sentence;
  } else {
    const mark = document.createElement('mark');
    mark.textContent = card.surface;
    p.append(card.sentence.slice(0, at), mark, card.sentence.slice(at + card.surface.length));
  }
  return p;
}

function renderList() {
  $('word-list').replaceChildren(...cards.map((card, i) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'word';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = card.selected;
    box.addEventListener('change', () => {
      card.selected = box.checked;
      label.classList.toggle('off', !box.checked);
      updateCount();
      saveSelection();
    });

    const body = document.createElement('div');
    body.className = 'body';
    body.append(meaning(card), sentence(card));

    const seen = document.createElement('span');
    seen.className = 'seen';
    seen.textContent = `×${card.count}`;
    seen.title = `Appears ${card.count} ${card.count === 1 ? 'time' : 'times'} in the video`;

    label.classList.toggle('off', !card.selected);
    label.append(box, headword(card), seen, body);
    li.append(label);
    li.dataset.index = i;
    return li;
  }));
  applyFilter();
  updateCount();
}

function applyFilter() {
  const q = $('filter').value.trim().toLowerCase();
  let shown = 0;
  for (const li of $('word-list').children) {
    const c = cards[li.dataset.index];
    const match = !q || [c.word, c.reading, c.meaning].some(s => s.toLowerCase().includes(q));
    li.hidden = !match;
    shown += match;
  }
  $('no-match').hidden = shown > 0 || !cards.length;
}

function updateCount() {
  const n = cards.filter(c => c.selected).length;
  $('count').textContent = `${n} of ${cards.length} selected`;
  $('export-apkg').disabled = $('export-tsv').disabled = n === 0;
}

function setSelected(value) {
  // Only touches the words currently visible, so a filter + "Clear" removes just those.
  for (const li of $('word-list').children) if (!li.hidden) cards[li.dataset.index].selected = value;
  renderList();
  saveSelection();
}

$('filter').addEventListener('input', applyFilter);
$('select-all').addEventListener('click', () => setSelected(true));
$('select-none').addEventListener('click', () => setSelected(false));

// ---------- Export ----------

for (const btn of [$('export-apkg'), $('export-tsv')]) {
  btn.addEventListener('click', async () => {
    const format = btn.dataset.format;
    btn.disabled = true;
    try {
      const selected = cards.filter(c => c.selected);
      const res = await post('/api/export', { cards: selected, title: video.title, format });
      const disposition = res.headers.get('Content-Disposition') || '';
      const name = disposition.match(/filename\*=UTF-8''([^;]+)/)?.[1] || disposition.match(/filename="?([^";]+)/)?.[1];
      await chrome.downloads.download({
        url: URL.createObjectURL(await res.blob()),
        filename: name ? decodeURIComponent(name) : `vocab.${format}`,
      });
      setStatus(`Downloaded ${selected.length} cards.`);
    } catch (err) {
      handleError(err);
    }
    btn.disabled = false;
  });
}

init();
