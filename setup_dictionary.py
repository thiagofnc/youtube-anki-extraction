"""Download JMdict (English) and build the compact lookup index used by the app.

Run once:  python setup_dictionary.py
"""
import gzip
import io
import json
import zipfile
from pathlib import Path

import requests

RELEASES_API = "https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"
DATA_DIR = Path(__file__).parent / "data"
INDEX_PATH = DATA_DIR / "jmdict_index.json.gz"
MAX_SENSES = 3


def download_jmdict() -> dict:
    release = requests.get(RELEASES_API, timeout=30).json()
    asset = next(
        a for a in release["assets"]
        if a["name"].startswith("jmdict-eng-") and "common" not in a["name"] and a["name"].endswith(".json.zip")
    )
    print(f"Downloading {asset['name']} ...")
    resp = requests.get(asset["browser_download_url"], timeout=300)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        with zf.open(zf.namelist()[0]) as f:
            return json.load(f)


def build_index(jmdict: dict) -> dict:
    entries = []
    index: dict[str, list[int]] = {}
    for word in jmdict["words"]:
        senses = []
        usually_kana = False
        for sense in word["sense"][:MAX_SENSES]:
            glosses = [g["text"] for g in sense["gloss"] if g.get("lang", "eng") == "eng"]
            if glosses:
                senses.append(glosses)
            if "uk" in sense.get("misc", []):
                usually_kana = True
        if not senses:
            continue
        entry = {
            "k": [k["text"] for k in word["kanji"]],
            "r": [r["text"] for r in word["kana"]],
            "s": senses,
            "c": any(x["common"] for x in word["kanji"] + word["kana"]),
            "uk": usually_kana,
        }
        eid = len(entries)
        entries.append(entry)
        for text in set(entry["k"] + entry["r"]):
            index.setdefault(text, []).append(eid)
    return {"entries": entries, "index": index}


def main():
    DATA_DIR.mkdir(exist_ok=True)
    data = build_index(download_jmdict())
    with gzip.open(INDEX_PATH, "wt", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(data['entries'])} entries to {INDEX_PATH}")


if __name__ == "__main__":
    main()
