"""Heuristic content-type classification for newspaper chunks.

Categories:
  0 = content (news, editorials, correspondence)
  1 = ad (advertisements, classifieds)
  2 = legal (legal notices, court announcements)
  3 = bad_ocr (garbled / unintelligible text)
"""

from __future__ import annotations

import re
from pathlib import Path

CONTENT = 0
AD = 1
LEGAL = 2
BAD_OCR = 3

_PRICE_RE = re.compile(
    r"\$\s?\d|cents?\b|per\s+annum|dollars?\b|shillings?\b", re.IGNORECASE
)
_AD_KEYWORDS_RE = re.compile(
    r"\bFOR\s+SALE\b|\bWANTED\b|\bTO\s+LET\b|\bAUCTION\b|\bREWARD\b"
    r"|\bAPPLY\s+(TO|AT)\b|\bPRICE\b|\bDISSO(LU|LV)TION\b",
    re.IGNORECASE,
)
_LEGAL_RE = re.compile(
    r"NOTICE\s+IS\s+HEREBY\s+GIVEN"
    r"|IN\s+PURSUANCE\s+OF"
    r"|BY\s+ORDER\s+OF"
    r"|SUPREME\s+COURT"
    r"|CHANCERY"
    r"|CHANCELLOR"
    r"|\bMORTGAGE\b"
    r"|\bFORECLOSURE\b"
    r"|\bPURSUANT\s+TO\s+STATUTE\b"
    r"|\bSURROGATE\b",
    re.IGNORECASE,
)

_WORDLIST: set[str] | None = None
_WORDLIST_PATH = Path(__file__).parent / "wordlist.txt"


def _load_wordlist() -> set[str]:
    global _WORDLIST
    if _WORDLIST is not None:
        return _WORDLIST
    if _WORDLIST_PATH.exists():
        _WORDLIST = {
            w.strip().lower()
            for w in _WORDLIST_PATH.read_text().splitlines()
            if w.strip()
        }
    else:
        _WORDLIST = set()
    return _WORDLIST


def _is_bad_ocr(content: str) -> bool:
    if not content.strip():
        return True
    words = content.split()
    if len(words) < 5:
        return False
    alpha_chars = sum(1 for c in content if c.isalpha())
    total_chars = len(content.replace(" ", ""))
    if total_chars == 0:
        return True
    if alpha_chars / total_chars < 0.6:
        return True
    avg_word_len = sum(len(w) for w in words) / len(words)
    if avg_word_len < 2 or avg_word_len > 15:
        return True
    wordlist = _load_wordlist()
    if wordlist:
        known = sum(1 for w in words if w.lower().strip(".,;:!?\"'()-") in wordlist)
        if known / len(words) < 0.3:
            return True
    return False


def _is_legal(content: str) -> bool:
    matches = len(_LEGAL_RE.findall(content))
    return matches >= 2


def _is_ad(content: str) -> bool:
    words = content.split()
    if len(words) < 80 and _PRICE_RE.search(content):
        return True
    if _AD_KEYWORDS_RE.search(content):
        return True
    return False


def classify_chunk(content: str) -> int:
    if _is_bad_ocr(content):
        return BAD_OCR
    if _is_legal(content):
        return LEGAL
    if _is_ad(content):
        return AD
    return CONTENT


LABELS = {CONTENT: "content", AD: "ad", LEGAL: "legal", BAD_OCR: "bad_ocr"}
