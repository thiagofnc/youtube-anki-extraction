const $ = id => document.getElementById(id);
let video = null;
let cards = [];       // [{word, reading, meaning, sentence, count, surface, selected}]

// ---------- Status ----------

function setStatus(msg, { error = false, busy = false } = {}) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', error);
  $('progress').hidden = !busy;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed (${res.status}).`);
  return res;
}

// ---------- Load video ----------

async function loadVideo(url) {
  $('url-error').textContent = '';
  $('load-btn').disabled = true;
  $('load-btn').textContent = 'Loading…';
  try {
    video = await (await post('/api/preview', { url })).json();
    const watchUrl = `https://www.youtube.com/watch?v=${video.id}`;
    $('thumb').src = video.thumbnail;
    $('video-link').href = watchUrl;
    $('video-title').href = watchUrl;
    $('video-title').textContent = video.title;
    $('channel').textContent = video.author;
    $('video').hidden = false;
    $('results').hidden = true;
    document.body.classList.add('has-video');
    history.replaceState(null, '', `?url=${encodeURIComponent(watchUrl)}`);
    setStatus('');
    $('extract-btn').focus();
  } catch (err) {
    $('url-error').textContent = `${err.message} Check the link and try again.`;
    $('url').focus();
  }
  $('load-btn').disabled = false;
  $('load-btn').textContent = 'Load video';
}

$('url-form').addEventListener('submit', e => {
  e.preventDefault();
  loadVideo($('url').value);
});

$('extract-btn').addEventListener('click', async () => {
  $('extract-btn').disabled = true;
  $('extract-btn').textContent = 'Extracting…';
  $('results').hidden = true;
  setStatus('Reading the subtitles and picking out vocabulary. Long videos take a little while.', { busy: true });
  try {
    const data = await (await post('/api/extract', { url: video.id })).json();
    cards = data.cards.map(c => ({ ...c, selected: true }));
    $('filter').value = '';
    renderList();
    $('results').hidden = false;
    setStatus(cards.length ? '' : 'No vocabulary found in these subtitles.');
  } catch (err) {
    setStatus(err.message, { error: true });
  }
  $('extract-btn').disabled = false;
  $('extract-btn').textContent = 'Extract vocabulary';
});

// ---------- Word list ----------

function headword(card) {
  const el = document.createElement('span');
  el.className = 'headword';
  el.lang = 'ja';
  if (card.reading && card.reading !== card.word) {
    const ruby = document.createElement('ruby');
    const rt = document.createElement('rt');
    ruby.append(card.word, rt);
    rt.textContent = card.reading;
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
  const list = $('word-list');
  list.replaceChildren(...cards.map((card, i) => {
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
    });

    const body = document.createElement('div');
    body.className = 'body';
    body.append(meaning(card), sentence(card));

    const seen = document.createElement('span');
    seen.className = 'seen';
    seen.textContent = `×${card.count}`;
    seen.title = `Appears ${card.count} ${card.count === 1 ? 'time' : 'times'} in the video`;

    label.classList.toggle('off', !card.selected);
    label.append(box, headword(card), body, seen);
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

function visibleCards() {
  return [...$('word-list').children].filter(li => !li.hidden).map(li => cards[li.dataset.index]);
}

function updateCount() {
  const n = cards.filter(c => c.selected).length;
  $('count').textContent = `${n} of ${cards.length} words selected`;
  $('export-apkg').disabled = $('export-tsv').disabled = n === 0;
}

function setSelected(value) {
  // Only touches the words currently visible, so a filter + "Clear" removes just those.
  for (const c of visibleCards()) c.selected = value;
  renderList();
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
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = name ? decodeURIComponent(name) : `vocab.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
      setStatus(`Downloaded ${selected.length} cards.`);
    } catch (err) {
      setStatus(err.message, { error: true });
    }
    btn.disabled = false;
  });
}

// ---------- Deep link: /?url=<youtube link> ----------

const initialUrl = new URLSearchParams(location.search).get('url');
if (initialUrl) {
  $('url').value = initialUrl;
  loadVideo(initialUrl);
}
