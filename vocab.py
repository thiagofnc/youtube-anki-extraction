"""YouTube transcript -> filtered Japanese vocabulary cards."""
import gzip
import json
import re
from dataclasses import dataclass, asdict
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import fugashi
import requests
from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled

INDEX_PATH = Path(__file__).parent / "data" / "jmdict_index.json.gz"

# Parts of speech (UniDic pos1) that can carry real vocabulary.
CONTENT_POS = {"名詞", "動詞", "形容詞", "形状詞", "副詞"}

# Sub-categories (pos2) that are grammar, names or numbers rather than vocabulary.
EXCLUDED_POS2 = {"固有名詞", "数詞", "代名詞", "助動詞語幹"}

# Very basic or function-like words that slip through the POS filter.
STOPWORDS = {
    "する", "為る", "いる", "居る", "ある", "有る", "在る", "なる", "成る", "言う", "いう", "できる", "出来る",
    "こと", "事", "もの", "物", "の", "ん", "よう", "様", "ため", "為", "ところ", "所", "わけ", "訳", "はず",
    "筈", "まま", "ほう", "方", "さん", "ちゃん", "くん", "君", "みたい", "そう", "こう", "ああ", "どう",
    "ここ", "そこ", "あそこ", "どこ", "これ", "それ", "あれ", "どれ", "うち", "なか", "とき", "時",
    "ちょっと", "もう", "まだ", "また", "とても", "すごい", "凄い", "やっぱり", "やはり", "ない", "無い",
    "いい", "良い", "よい", "くる", "来る", "いく", "行く", "おる", "思う", "感じ",
}

# Verbs that act as auxiliaries after the て-form (食べている, 見てみる ...).
AUXILIARY_AFTER_TE = {"いる", "居る", "ある", "おく", "置く", "しまう", "仕舞う", "みる", "見る", "いく", "行く",
                      "くる", "来る", "くれる", "呉れる", "もらう", "貰う", "あげる", "上げる", "ほしい", "欲しい"}

# Verbs that are part of grammar expressions after に/と: について, によって, に対して, にとって, に関して ...
GRAMMAR_VERBS_AFTER_NI = {"つく", "就く", "よる", "因る", "依る", "対する", "とる", "取る", "関する", "おく", "於く"}

# Tokens that may be glued together into compound nouns (委員+会, 経済+産業+省).
COMPOUND_POS = {"名詞", "接頭辞", "接尾辞"}
MAX_COMPOUND_TOKENS = 4

KANA_ONLY =re.compile(r"^[぀-ヿー]+$")
HAS_JAPANESE = re.compile(r"[぀-ヿ一-鿿]")


@dataclass
class Card:
    word: str
    reading: str
    meaning: str
    sentence: str
    count: int


class ExtractionError(Exception):
    pass


# ---------------------------------------------------------------- YouTube

def parse_video_id(url: str) -> str:
    url = url.strip()
    if re.fullmatch(r"[\w-]{11}", url):
        return url
    parsed = urlparse(url if "://" in url else "https://" + url)
    host = parsed.netloc.lower().removeprefix("www.").removeprefix("m.")
    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif host.endswith("youtube.com"):
        if parsed.path == "/watch":
            candidate = parse_qs(parsed.query).get("v", [""])[0]
        else:
            parts = parsed.path.strip("/").split("/")
            candidate = parts[1] if len(parts) > 1 and parts[0] in {"shorts", "embed", "live", "v"} else ""
    else:
        candidate = ""
    if not re.fullmatch(r"[\w-]{11}", candidate):
        raise ExtractionError("That doesn't look like a YouTube video link.")
    return candidate


def fetch_preview(url: str) -> dict:
    video_id = parse_video_id(url)
    resp = requests.get(
        "https://www.youtube.com/oembed",
        params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
        timeout=10,
    )
    if resp.status_code != 200:
        raise ExtractionError("Video not found, or it is private.")
    data = resp.json()
    return {
        "id": video_id,
        "title": data.get("title", ""),
        "author": data.get("author_name", ""),
        "thumbnail": f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
    }


def fetch_transcript(video_id: str) -> list[str]:
    try:
        transcripts = YouTubeTranscriptApi().list(video_id)
        # Prefers manually created subtitles over auto-generated ones.
        transcript = transcripts.find_transcript(["ja", "ja-JP"])
        return [s.text for s in transcript.fetch() if s.text.strip()]
    except (NoTranscriptFound, TranscriptsDisabled):
        raise ExtractionError("This video has no Japanese subtitles (manual or auto-generated).")
    except Exception as e:
        raise ExtractionError(f"Could not download subtitles: {e}")


# ---------------------------------------------------------------- Dictionary

@lru_cache(maxsize=1)
def load_dictionary() -> dict:
    if not INDEX_PATH.exists():
        raise ExtractionError("Dictionary missing. Run `python setup_dictionary.py` first.")
    with gzip.open(INDEX_PATH, "rt", encoding="utf-8") as f:
        return json.load(f)


def to_hiragana(text: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in text)


def lookup(written: str, lemma: str, reading: str) -> dict | None:
    """Find the JMdict entry best matching a token's written form, UniDic lemma and reading."""
    dic = load_dictionary()
    ids = set(dic["index"].get(written, [])) | set(dic["index"].get(lemma, []))
    best, best_score = None, 0
    for eid in ids:
        entry = dic["entries"][eid]
        reading_match = reading in entry["r"] or to_hiragana(reading) in entry["r"]
        kanji_match = lemma in entry["k"] or written in entry["k"]
        if not (reading_match or kanji_match):
            continue
        score = 4 * reading_match + 3 * kanji_match + 2 * entry["c"] + (written in entry["k"] + entry["r"])
        if score > best_score:
            best, best_score = entry, score
    return best


def format_meaning(entry: dict) -> str:
    senses = ["; ".join(glosses) for glosses in entry["s"]]
    if len(senses) == 1:
        return senses[0]
    return " ".join(f"{i}. {s}" for i, s in enumerate(senses, 1))


# ---------------------------------------------------------------- Extraction

@lru_cache(maxsize=1)
def tagger() -> fugashi.Tagger:
    return fugashi.Tagger()


def is_useful(token, prev) -> bool:
    f = token.feature
    if f.pos1 not in CONTENT_POS or f.pos2 in EXCLUDED_POS2:
        return False
    base = f.orthBase or token.surface
    lemma = (f.lemma or "").split("-")[0]
    if base in STOPWORDS or lemma in STOPWORDS:
        return False
    if not HAS_JAPANESE.search(base):
        return False
    # Single hiragana/katakana characters are almost always fragments or fillers.
    if len(base) == 1 and KANA_ONLY.match(base):
        return False
    if prev is not None:
        # Counters after numbers: 3月, 7時, 2年 ...
        if f.pos3 == "助数詞可能" and prev.feature.pos2 == "数詞":
            return False
        if f.pos1 == "動詞":
            # Auxiliary use of verbs: 食べている, 書いておく, 見てみる ...
            if prev.surface in {"て", "で"} and (base in AUXILIARY_AFTER_TE or lemma in AUXILIARY_AFTER_TE):
                return False
            if prev.surface in {"に", "と"} and (base in GRAMMAR_VERBS_AFTER_NI or lemma in GRAMMAR_VERBS_AFTER_NI):
                return False
    return True


def match_compound(tokens: list, start: int) -> tuple[int, str, str, dict] | None:
    """Longest run of noun-like tokens starting at `start` that JMdict knows as one word."""
    dic = load_dictionary()
    run_end = start
    while run_end < len(tokens) and run_end - start < MAX_COMPOUND_TOKENS and \
            tokens[run_end].feature.pos1 in COMPOUND_POS and tokens[run_end].feature.pos2 != "数詞":
        run_end += 1
    for end in range(run_end, start + 1, -1):
        written = "".join(t.surface for t in tokens[start:end])
        if written not in dic["index"]:
            continue
        kana = "".join(t.feature.kana or "" for t in tokens[start:end])
        entry = lookup(written, written, kana)
        if entry:
            return end, written, kana, entry
    return None


def extract_cards(lines: list[str]) -> list[Card]:
    cards: dict[str, Card] = {}

    def add(written: str, kana: str, entry: dict, sentence: str):
        # Keep katakana for loanwords (ラーメン), hiragana otherwise.
        reading = next((r for r in (kana, to_hiragana(kana)) if r in entry["r"]), entry["r"][0])
        key = f"{written}|{reading}"
        if key in cards:
            cards[key].count += 1
        else:
            cards[key] = Card(written, reading, format_meaning(entry), sentence, 1)

    for line in lines:
        line = line.replace("\n", " ").strip()
        tokens = list(tagger()(line))
        i = 0
        while i < len(tokens):
            # Counters after numbers (3月, 7時, 3年生) are never vocabulary cards.
            if i and tokens[i - 1].feature.pos2 == "数詞" and tokens[i].feature.pos3 in {"助数詞可能", "助数詞"}:
                i += 1
                continue
            compound = match_compound(tokens, i)
            if compound:
                end, written, kana, entry = compound
                add(written, kana, entry, line)
                i = end
                continue
            token, prev = tokens[i], tokens[i - 1] if i else None
            if is_useful(token, prev):
                f = token.feature
                written = f.orthBase or token.surface
                lemma = (f.lemma or "").split("-")[0]
                entry = lookup(written, lemma, f.kanaBase or "")
                if entry:
                    add(written, f.kanaBase or "", entry, line)
            i += 1
    return sorted(cards.values(), key=lambda c: -c.count)


def extract_from_url(url: str) -> list[dict]:
    video_id = parse_video_id(url)
    return [asdict(c) for c in extract_cards(fetch_transcript(video_id))]
