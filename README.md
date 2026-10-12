# youtube-anki-extraction

Extract Japanese vocabulary flashcards from YouTube videos.

Paste a YouTube link, check the thumbnail/title preview, and extract every useful word from the
video's Japanese subtitles (manual or auto-generated). Cards are exported as an Anki deck (`.apkg`)
or a TSV file.

**Card format** — front: word (dictionary form) · back: hiragana reading, English meaning, and the
subtitle line it appeared in.

## Setup

```sh
python -m venv .venv
.venv\Scripts\activate        # Windows  (source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
python setup_dictionary.py    # one-time: downloads JMdict and builds data/jmdict_index.json.gz
python app.py                 # http://127.0.0.1:5000
```

## Chrome extension

The `extension/` folder is a popup that extracts vocabulary from the YouTube video in the current
tab. It talks to the local server, so keep `python app.py` running.

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` folder.
3. Open a YouTube video and click the extension icon.

Extracted cards are cached per video for the browser session, so closing the popup mid-way
doesn't lose them.

## How vocabulary is filtered

1. Subtitles are tokenized with MeCab (fugashi + UniDic) and each word is reduced to its dictionary form.
2. Only nouns, verbs, i-adjectives, na-adjectives and adverbs are kept. Particles, auxiliary verbs,
   conjunctions, interjections/fillers, pronouns, numbers, proper names and symbols are dropped.
3. Grammar uses are removed: auxiliary verbs after て (〜ている, 〜てみる), expressions like
   について / によって, and counters after numbers (3月, 7時).
4. A stoplist removes ultra-basic or function-like words (する, ある, こと, もの, これ, ...).
5. Adjacent nouns are merged into compounds when JMdict knows them (委員 + 会 → 委員会).
6. Only words found in JMdict become cards; duplicates are merged and sorted by frequency.

You can untick any cards you don't want before exporting.
