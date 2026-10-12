import csv
import hashlib
import io
import re
import tempfile
from pathlib import Path

import genanki
from flask import Flask, jsonify, render_template, request, send_file

from vocab import ExtractionError, extract_from_url, fetch_preview

app = Flask(__name__)

# Fixed ID so re-imports update the same note type in Anki instead of creating duplicates.
CARD_MODEL = genanki.Model(
    1607392319,
    "YouTube Japanese Vocab",
    fields=[{"name": "Word"}, {"name": "Reading"}, {"name": "Meaning"}, {"name": "Sentence"}],
    templates=[{
        "name": "Recognition",
        "qfmt": '<div class="word">{{Word}}</div>',
        "afmt": '{{FrontSide}}<hr id="answer">'
                '<div class="reading">{{Reading}}</div>'
                '<div class="meaning">{{Meaning}}</div>'
                '{{#Sentence}}<div class="sentence">{{Sentence}}</div>{{/Sentence}}',
    }],
    css=".card { font-family: sans-serif; text-align: center; font-size: 20px; }"
        ".word { font-size: 48px; } .reading { font-size: 28px; margin-bottom: 12px; }"
        ".sentence { font-size: 16px; color: #888; margin-top: 16px; }",
)


@app.get("/")
def index():
    return render_template("index.html")


@app.post("/api/preview")
def preview():
    try:
        return jsonify(fetch_preview(request.json.get("url", "")))
    except ExtractionError as e:
        return jsonify(error=str(e)), 400


@app.post("/api/extract")
def extract():
    try:
        return jsonify(cards=extract_from_url(request.json.get("url", "")))
    except ExtractionError as e:
        return jsonify(error=str(e)), 400


@app.post("/api/export")
def export():
    body = request.json
    cards = body.get("cards", [])
    title = body.get("title") or "YouTube Vocabulary"
    filename = re.sub(r'[\\/:*?"<>|]+', "_", title)[:80].strip() or "vocab"

    if body.get("format") == "tsv":
        buf = io.StringIO()
        writer = csv.writer(buf, delimiter="\t", lineterminator="\n")
        for c in cards:
            writer.writerow([c["word"], c["reading"], c["meaning"], c["sentence"]])
        return send_file(io.BytesIO(buf.getvalue().encode("utf-8")), mimetype="text/tab-separated-values",
                         as_attachment=True, download_name=f"{filename}.tsv")

    deck_id = int(hashlib.sha1(title.encode()).hexdigest()[:8], 16)
    deck = genanki.Deck(deck_id, f"YouTube Japanese::{title}")
    for c in cards:
        deck.add_note(genanki.Note(
            model=CARD_MODEL,
            fields=[c["word"], c["reading"], c["meaning"], c["sentence"]],
            guid=genanki.guid_for(c["word"], c["reading"]),
        ))
    path = Path(tempfile.mkdtemp()) / f"{filename}.apkg"
    genanki.Package(deck).write_to_file(path)
    return send_file(path, as_attachment=True, download_name=path.name)


if __name__ == "__main__":
    app.run(debug=True)
