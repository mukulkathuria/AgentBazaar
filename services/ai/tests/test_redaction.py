import time

import pytest
from hypothesis import given
from hypothesis import strategies as st

from agentbazaar_ai.redaction import PresidioRedactor, find_pii, redact

CASES = [
    ("mail me at john.doe+shop@example.co.in", "mail me at [EMAIL]"),
    ("card 4111 1111 1111 1111 thanks", "card [CARD] thanks"),
    ("call 09876543210", "call [PHONE]"),
    ("call +919876543210", "call [PHONE]"),
    ("card 4111-1111-1111-1111", "card [CARD]"),
    ("not a card 4111111111111112", "not a card 4111111111111112"),  # fails Luhn
    ("aadhaar 2345 6789 0123", "aadhaar [AADHAAR]"),
    ("call +91 98765 43210", "call [PHONE]"),
    ("call +91-9876543210 now", "call [PHONE] now"),
    ("call 98765-43210", "call [PHONE]"),
    ("PAN ABCDE1234F", "PAN [PAN]"),
    ("lowercase abcde1234f is not a PAN", "lowercase abcde1234f is not a PAN"),
    ("pay ram.k@okhdfc please", "pay [UPI] please"),
    ("pin code 560001", "[PINCODE]"),
    ("PIN: 560001", "[PINCODE]"),
    ("Pincode-110011", "[PINCODE]"),
    ("postal code 400001", "[PINCODE]"),
    ("order 560001 shipped", "order 560001 shipped"),  # six digits alone are not a pincode
    ("write to ram@okhdfc.com", "write to [EMAIL]"),  # email beats the overlapping UPI match
    ("no pii here, just a mug for ₹2,399", "no pii here, just a mug for ₹2,399"),
]


@pytest.mark.parametrize(("text", "expected"), CASES)
def test_redact(text: str, expected: str) -> None:
    assert redact(text).text == expected


def test_zero_prefixed_mobile_numbers_are_redacted() -> None:
    assert redact("call 09876543210").text == "call [PHONE]"


def test_findings_use_code_point_offsets_into_the_original() -> None:
    text = "😀 नाम: a@b.co, 9876543210"
    findings = redact(text).findings
    assert [(f.type, text[f.start : f.end]) for f in findings] == [
        ("EMAIL", "a@b.co"),
        ("PHONE", "9876543210"),
    ]
    assert findings[0].start == 7  # a UTF-16 offset would be 8: the emoji is one code point here


def test_javascript_regex_semantics_are_kept() -> None:
    # TS regexes have no `u` flag: \d is ASCII-only and \s is JavaScript's whitespace set.
    assert redact("९८७६५४३२१०").findings == []
    assert redact("9876543210").findings != []
    assert redact("98765\ufeff43210").text == "[PHONE]"  # U+FEFF is \s in JS, not in Python
    assert redact("98765\u008543210").text == "98765\u008543210"  # U+0085: the reverse


@pytest.mark.parametrize("text", ["a" * 20000, "pin" + " " * 19997, ".a" * 10000, "1 " * 10000])
def test_adversarial_inputs_stay_linear(text: str) -> None:
    start = time.perf_counter()
    redact(text)
    assert time.perf_counter() - start < 0.5


EMAILS = st.from_regex(
    r"[a-z0-9][a-z0-9._%+-]{0,15}@[a-z0-9]{1,10}(\.[a-z0-9]{1,8})?\.[a-z]{2,6}", fullmatch=True
)
PHONES = st.from_regex(r"(\+91[ -]?)?[6-9][0-9]{4}[ -]?[0-9]{5}", fullmatch=True)
PANS = st.from_regex(r"[A-Z]{5}[0-9]{4}[A-Z]", fullmatch=True)
FILLER = st.text(alphabet="abcxyz ABCXYZ,.!?मगनाम😀", max_size=40)


@given(FILLER, st.one_of(EMAILS, PHONES, PANS), FILLER)
def test_generated_pii_never_survives(before: str, pii: str, after: str) -> None:
    assert pii not in redact(f"{before} {pii} {after}").text


@given(st.text(max_size=2000))
def test_findings_are_valid_sorted_and_disjoint(text: str) -> None:
    result = redact(text)
    rebuilt, last = "", 0
    for f in result.findings:
        assert last <= f.start < f.end <= len(text)
        rebuilt += text[last : f.start] + f"[{f.type}]"
        last = f.end
    assert rebuilt + text[last:] == result.text


def test_find_pii_matches_redact() -> None:
    text = "ram@okhdfc.com / 9876543210"
    assert find_pii(text) == redact(text).findings


def test_presidio_findings_merge_under_regex_findings(fake_presidio: None) -> None:
    result = PresidioRedactor()("Call Rahul at 9876543210")
    assert result.text == "Call [PERSON] at [PHONE]"
    assert [f.type for f in result.findings] == ["PERSON", "PHONE"]
