"""PII redaction: a port of apps/api/src/shared/observability/redact.ts, plus optional Presidio NER.

The regexes keep JavaScript semantics (no ``u`` flag: ASCII ``\\d``/``\\w``/``\\b``, JavaScript's
``\\s``) so both sides find the same spans. Offsets are code points into the original text.
"""

import re
from collections.abc import Callable, Iterator

from .schemas import RedactFinding, RedactResponse

Redactor = Callable[[str], RedactResponse]

_A = re.ASCII
_S = r"\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"  # JS \s
_LOCAL = "A-Za-z0-9._%+-"
_EMAIL = re.compile(rf"[{_LOCAL}]+@[A-Za-z0-9.-]+\.[A-Za-z]{{2,}}", _A)
_EMAIL_AT_RUN = re.compile(rf"(?<![{_LOCAL}])" + _EMAIL.pattern, _A)


def _emails(text: str) -> Iterator[re.Match[str]]:
    """Same matches as ``_EMAIL.finditer`` without its quadratic rescans of long local-part runs.

    Every start inside one run of local-part characters reaches the same ``@``, so a run either
    matches from wherever scanning resumed (try ``match`` there) or not at all (skip to the start
    of the next run).
    """
    pos = 0
    while m := _EMAIL.match(text, pos) or _EMAIL_AT_RUN.search(text, pos):
        yield m
        pos = m.end()


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch) * (2 if i % 2 else 1)
        total += d - 9 if d > 9 else d
    return total % 10 == 0


def _card(match: str) -> bool:
    digits = re.sub(r"\D", "", match, flags=_A)
    return 13 <= len(digits) <= 19 and _luhn(digits)


# Verhoeff check digit (UIDAI's Aadhaar checksum): random 12-digit runs aren't Aadhaar numbers.
_VERHOEFF_D = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 2, 3, 4, 0, 6, 7, 8, 9, 5),
    (2, 3, 4, 0, 1, 7, 8, 9, 5, 6),
    (3, 4, 0, 1, 2, 8, 9, 5, 6, 7),
    (4, 0, 1, 2, 3, 9, 5, 6, 7, 8),
    (5, 9, 8, 7, 6, 0, 4, 3, 2, 1),
    (6, 5, 9, 8, 7, 1, 0, 4, 3, 2),
    (7, 6, 5, 9, 8, 2, 1, 0, 4, 3),
    (8, 7, 6, 5, 9, 3, 2, 1, 0, 4),
    (9, 8, 7, 6, 5, 4, 3, 2, 1, 0),
)
_VERHOEFF_P = (
    (0, 1, 2, 3, 4, 5, 6, 7, 8, 9),
    (1, 5, 7, 6, 2, 8, 3, 0, 9, 4),
    (5, 8, 0, 3, 7, 9, 6, 1, 4, 2),
    (8, 9, 1, 6, 0, 4, 3, 5, 2, 7),
    (9, 4, 5, 3, 1, 2, 6, 8, 7, 0),
    (4, 2, 8, 6, 5, 7, 3, 9, 0, 1),
    (2, 7, 9, 3, 8, 0, 6, 4, 1, 5),
    (7, 0, 4, 6, 9, 1, 3, 2, 5, 8),
)


def _aadhaar(match: str) -> bool:
    check = 0
    for i, ch in enumerate(reversed(re.sub(r"\D", "", match, flags=_A))):
        check = _VERHOEFF_D[check][_VERHOEFF_P[i % 8][int(ch)]]
    return check == 0


# Order matters: longer, more specific patterns run first so they win overlaps.
# The third item accepts or rejects a match; ``bool`` accepts every (non-empty) match.
_RULES: tuple[tuple[str, Callable[[str], Iterator[re.Match[str]]], Callable[[str], bool]], ...] = (
    ("EMAIL", _emails, bool),
    ("CARD", re.compile(r"\b\d(?:[ -]?\d){12,18}\b", _A).finditer, _card),
    (
        "PHONE",
        re.compile(rf"(?<!\d)(?:\+91[{_S}-]?|0)?[6-9]\d{{4}}[{_S}-]?\d{{5}}(?!\d)", _A).finditer,
        bool,
    ),
    ("AADHAAR", re.compile(r"\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b", _A).finditer, _aadhaar),
    ("PAN", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", _A).finditer, bool),
    ("UPI", re.compile(r"\b[A-Za-z0-9._-]{2,256}@(?:ok)?[a-z]{2,64}\b", _A).finditer, bool),
    (
        "PINCODE",
        # TS has \s*[:#-]?\s*; \s*(?:[:#-]\s*)? matches the same text, minus quadratic backtracking.
        re.compile(
            rf"\b(?:pin(?:[{_S}]?code)?|postal code)[{_S}]*(?:[:#-][{_S}]*)?[1-9]\d{{5}}\b",
            _A | re.IGNORECASE,
        ).finditer,
        bool,
    ),
)


def _overlaps(findings: list[RedactFinding], start: int, end: int) -> bool:
    return any(start < f.end and end > f.start for f in findings)


# Identifiers, not personal data: digit runs inside a UUID can look like a phone or Aadhaar number.
_UUID = re.compile(
    r"\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b", _A
)


def find_pii(text: str) -> list[RedactFinding]:
    ids = [m.span() for m in _UUID.finditer(text)]
    found: list[RedactFinding] = []
    for kind, finditer, accept in _RULES:
        for m in finditer(text):
            start, end = m.span()
            if any(start < e and end > s for s, e in ids) or not accept(m.group()):
                continue
            if not _overlaps(found, start, end):
                found.append(RedactFinding(type=kind, start=start, end=end))
    return sorted(found, key=lambda f: f.start)


def _apply(text: str, findings: list[RedactFinding]) -> RedactResponse:
    parts: list[str] = []
    last = 0
    for f in findings:
        parts += (text[last : f.start], f"[{f.type}]")
        last = f.end
    parts.append(text[last:])
    return RedactResponse(text="".join(parts), findings=findings)


def redact(text: str) -> RedactResponse:
    return _apply(text, find_pii(text))


_PRESIDIO_TYPES = {
    "EMAIL_ADDRESS": "EMAIL",
    "CREDIT_CARD": "CARD",
    "IN_AADHAAR": "AADHAAR",
    "PHONE_NUMBER": "PHONE",
    "IN_PAN": "PAN",
}


class PresidioRedactor:
    """Optional ``presidio`` extra: NER findings (names, places) merged under the regex ones."""

    def __init__(self) -> None:
        from presidio_analyzer import AnalyzerEngine

        self._engine = AnalyzerEngine()

    def __call__(self, text: str) -> RedactResponse:
        findings = find_pii(text)
        results = self._engine.analyze(text=text, language="en", score_threshold=0.5)
        for r in sorted(results, key=lambda r: -r.score):
            if not _overlaps(findings, r.start, r.end):
                kind = _PRESIDIO_TYPES.get(r.entity_type, r.entity_type)
                findings.append(RedactFinding(type=kind, start=r.start, end=r.end))
        return _apply(text, sorted(findings, key=lambda f: f.start))
